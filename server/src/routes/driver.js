// Pantalla del conductor: saldo, recargas por transferencia y documentos
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { pool } from '../db.js';
import { sanitizeJpeg } from '../jpeg.js';
import { encryptBuffer } from '../secure.js';
import { getSettings, money } from '../wallet.js';
import { UPLOADS, DOC_TYPES } from '../config.js';
import { app, photoJson } from '../app.js';
import { clean } from '../util.js';
import { authUser, driverOnly } from '../access.js';
import { pushStaff } from '../notify.js';

// Lo que ve el conductor: su saldo, cómo transferir, sus movimientos y sus recargas
app.get('/api/driver/wallet', authUser, driverOnly, async (req, res) => {
  const s = await getSettings(pool);
  const [[u]] = await pool.query('SELECT balance FROM users WHERE id = ?', [req.user.id]);
  const [entries] = await pool.query('SELECT id, amount, kind, ride_id, note, created_at FROM wallet_entries WHERE user_id = ? ORDER BY id DESC LIMIT 50', [req.user.id]);
  const [topups] = await pool.query('SELECT id, amount, bank, reference, status, approved_amount, review_note, created_at FROM topups WHERE driver_id = ? ORDER BY id DESC LIMIT 20', [req.user.id]);
  res.json({
    enabled: s.commission_enabled === '1',
    balance: Number(u.balance), minBalance: Number(s.min_balance), percent: Number(s.commission_percent),
    topupMin: Number(s.topup_min), topupMax: Number(s.topup_max),
    bank: { name: s.bank_name, type: s.bank_account_type, account: s.bank_account, holder: s.bank_holder, note: s.bank_note },
    entries, topups,
  });
});

// El conductor avisa que transfirió: monto, banco, número de referencia y foto del comprobante
app.post('/api/driver/topups', authUser, driverOnly, photoJson, async (req, res) => {
  if (req.user.status !== 'active') return res.status(403).json({ error: 'Tu cuenta debe estar aprobada para recargar' });
  const s = await getSettings(pool);
  if (s.commission_enabled !== '1') return res.status(409).json({ error: 'Las recargas no están activas' });
  const amount = money(req.body?.amount);
  if (!(amount >= Number(s.topup_min) && amount <= Number(s.topup_max)))
    return res.status(400).json({ error: `La recarga debe ser de L ${Number(s.topup_min)} a L ${Number(s.topup_max)}` });
  const bank = clean(req.body?.bank)?.slice(0, 60);
  const reference = clean(req.body?.reference)?.slice(0, 60);
  if (!bank || !reference || reference.length < 4) return res.status(400).json({ error: 'Indica el banco y el número de referencia de la transferencia' });
  const m = String(req.body?.image || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  let cleaned;
  try {
    const buf = m ? Buffer.from(m[1], 'base64') : null;
    if (!buf || buf.length > 2 * 1024 * 1024) throw new Error('imagen');
    cleaned = sanitizeJpeg(buf).buf; // se quitan los datos ocultos de la foto, igual que en los documentos
  } catch {
    return res.status(400).json({ error: 'Sube una foto o captura del comprobante (JPG, menos de 2 MB)' });
  }
  const [[open]] = await pool.query("SELECT COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(created_at > NOW() - INTERVAL 24 HOUR), 0) AS today FROM topups WHERE driver_id = ?", [req.user.id]);
  if (Number(open.pending) >= 3) return res.status(429).json({ error: 'Ya tienes 3 recargas esperando aprobación. Espera a que el equipo las revise.' });
  if (Number(open.today) >= 5) return res.status(429).json({ error: 'Ya enviaste varias recargas hoy. Espera a que el equipo las revise.' });
  // Contra el fraude: la misma transferencia o el mismo comprobante no se pueden usar dos veces
  const referenceKey = `${bank}:${reference}`.toUpperCase().replace(/[^A-Z0-9:]/g, '');
  const hash = crypto.createHash('sha256').update(cleaned).digest('hex');
  const [dup] = await pool.query("SELECT reference_key = ? AS sameRef FROM topups WHERE status IN ('pending','approved') AND (reference_key = ? OR receipt_hash = ?) LIMIT 1", [referenceKey, referenceKey, hash]);
  if (dup[0]) return res.status(409).json({ error: dup[0].sameRef ? 'Esa transferencia ya fue enviada' : 'Ese comprobante ya fue enviado' });

  await fs.mkdir(UPLOADS, { recursive: true });
  const file = `topup-${req.user.id}-${crypto.randomBytes(8).toString('hex')}.enc`;
  await fs.writeFile(path.join(UPLOADS, file), encryptBuffer(cleaned));
  const [r] = await pool.query('INSERT INTO topups (driver_id, amount, bank, reference, reference_key, receipt_file, receipt_hash) VALUES (?,?,?,?,?,?,?)', [req.user.id, amount, bank, reference, referenceKey, file, hash]);
  pushStaff({ title: 'Nueva recarga por aprobar', body: `${req.user.name} · L ${amount}`, tag: `topup-${r.insertId}`, url: '/' }, 'wallet');
  res.json({ ok: true, id: r.insertId });
});

// ---------- Documentos del conductor (foto, licencia y matrícula) ----------

app.get('/api/driver/documents', authUser, driverOnly, async (req, res) => {
  const [rows] = await pool.query('SELECT type, status, note, created_at FROM documents WHERE user_id = ?', [req.user.id]);
  res.json(rows);
});

// La app reduce la foto a JPEG antes de subirla; aquí se valida que de verdad sea un JPEG
app.put('/api/driver/documents/:type', authUser, driverOnly, photoJson, async (req, res) => {
  const type = req.params.type;
  if (!DOC_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo de documento inválido' });
  const m = String(req.body?.image || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  const buf = m ? Buffer.from(m[1], 'base64') : null;
  if (!buf || buf.length < 100 || buf.length > 2 * 1024 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff)
    return res.status(400).json({ error: 'Sube una foto JPG de menos de 2 MB' });

  // Nunca se confía en lo que manda la app: se valida la estructura, se quitan los metadatos (ubicación GPS, modelo del celular) y se cifra
  let cleaned;
  try {
    cleaned = sanitizeJpeg(buf).buf;
  } catch {
    return res.status(400).json({ error: 'La imagen no es un JPG válido' });
  }
  await fs.mkdir(UPLOADS, { recursive: true });
  const file = `${req.user.id}-${type}-${crypto.randomBytes(8).toString('hex')}.enc`;
  await fs.writeFile(path.join(UPLOADS, file), encryptBuffer(cleaned));
  const [[before]] = await pool.query("SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND status = 'uploaded'", [req.user.id]);
  const [old] = await pool.query('SELECT file FROM documents WHERE user_id = ? AND type = ?', [req.user.id, type]);
  await pool.query(
    `INSERT INTO documents (user_id, type, file) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE file = VALUES(file), status = 'uploaded', note = NULL, created_at = NOW()`,
    [req.user.id, type, file]
  );
  if (old[0]) await fs.rm(path.join(UPLOADS, old[0].file), { force: true });
  const [[after]] = await pool.query("SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND status = 'uploaded'", [req.user.id]);
  if (before.n < DOC_TYPES.length && after.n === DOC_TYPES.length)
    pushStaff({ title: 'Nueva solicitud de conductor', body: `${req.user.name} subió sus documentos`, tag: `docs-${req.user.id}`, url: '/' }, 'users.manage');
  res.json({ ok: true });
});
