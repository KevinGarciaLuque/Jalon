// Etapa 9.3: selfie del conductor al ponerse disponible (cada cierto número de horas, según Ajustes).
// Se guarda cifrada como los documentos; el personal la compara con la foto aprobada y, si no es la misma persona,
// se bloquea la cuenta. Se borran solas a los 30 días. (No hay reconocimiento facial automático.)
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { pool } from '../db.js';
import { sanitizeJpeg } from '../jpeg.js';
import { encryptBuffer, decryptBuffer, isEncrypted } from '../secure.js';
import { getSettings } from '../wallet.js';
import { UPLOADS } from '../config.js';
import { app, photoJson } from '../app.js';
import { authUser, driverOnly, staffOnly, audit, auditOnce } from '../access.js';
import { push, pushStaff } from '../notify.js';
import { kickUser } from '../services/rides.js';

export const SELFIE_KEEP_DAYS = 30;

// ¿Le toca tomarse una selfie para ponerse disponible? (0 horas en Ajustes = apagado)
export async function needsSelfie(driverId) {
  const hours = Number((await getSettings(pool)).driver_selfie_hours);
  if (!(hours > 0)) return false;
  const [[r]] = await pool.query("SELECT COUNT(*) AS n FROM driver_selfies WHERE driver_id = ? AND status <> 'mismatch' AND created_at > NOW() - INTERVAL ? HOUR", [driverId, hours]);
  return !r.n;
}

app.post('/api/driver/selfie', authUser, driverOnly, photoJson, async (req, res) => {
  if (req.user.status !== 'active') return res.status(403).json({ error: 'Tu cuenta debe estar aprobada' });
  const m = String(req.body?.image || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  let cleaned;
  try {
    const buf = m ? Buffer.from(m[1], 'base64') : null;
    if (!buf || buf.length < 100 || buf.length > 2 * 1024 * 1024) throw new Error('imagen');
    cleaned = sanitizeJpeg(buf).buf; // sin datos ocultos (ubicación, modelo del celular)
  } catch {
    return res.status(400).json({ error: 'Toma la selfie con la cámara (JPG, menos de 2 MB)' });
  }
  await fs.mkdir(UPLOADS, { recursive: true });
  const file = `selfie-${req.user.id}-${crypto.randomBytes(8).toString('hex')}.enc`;
  await fs.writeFile(path.join(UPLOADS, file), encryptBuffer(cleaned));
  const [r] = await pool.query('INSERT INTO driver_selfies (driver_id, file) VALUES (?,?)', [req.user.id, file]);
  pushStaff({ title: 'Selfie por revisar', body: `${req.user.name} se conectó: compara su selfie con su foto`, tag: `docs-selfie-${r.insertId}`, target: 'selfies', url: '/' }, 'users.manage');
  res.json({ ok: true, id: r.insertId });
});

// ---------- Personal ----------
app.get('/api/admin/selfies', staffOnly('users.manage'), async (req, res) => {
  const status = ['ok', 'mismatch'].includes(req.query.status) ? req.query.status : 'pending';
  const [rows] = await pool.query(
    `SELECT s.id, s.status, s.created_at, s.reviewed_at, u.id AS driver_id, u.name AS driver, u.phone AS driver_phone, u.plate, rv.name AS reviewer,
            (SELECT d.id FROM documents d WHERE d.user_id = u.id AND d.type = 'photo' ORDER BY d.id DESC LIMIT 1) AS photo_id
     FROM driver_selfies s JOIN users u ON u.id = s.driver_id LEFT JOIN users rv ON rv.id = s.reviewed_by
     WHERE s.status = ? ORDER BY s.id DESC LIMIT 100`, [status]
  );
  res.json(rows);
});

app.get('/api/admin/selfies/:id/file', staffOnly('users.manage'), async (req, res) => {
  const [[s]] = await pool.query('SELECT driver_id, file FROM driver_selfies WHERE id = ?', [Number(req.params.id)]);
  if (!s) return res.status(404).json({ error: 'No existe' });
  let blob;
  try { blob = await fs.readFile(path.join(UPLOADS, s.file)); } catch { return res.status(404).json({ error: 'El archivo ya no está disponible' }); }
  await auditOnce(req.staff, 'selfie.view', s.driver_id, 10);
  res.set('Cache-Control', 'private, no-store');
  res.type('image/jpeg').send(isEncrypted(blob) ? decryptBuffer(blob) : blob);
});

// «Es la misma persona» o «No coincide» (bloquea la cuenta: alguien más estaría usando su cuenta)
app.post('/api/admin/selfies/:id/review', staffOnly('users.manage'), async (req, res) => {
  const result = req.body?.result;
  if (!['ok', 'mismatch'].includes(result)) return res.status(400).json({ error: 'Resultado inválido' });
  const id = Number(req.params.id);
  const [[s]] = await pool.query('SELECT driver_id FROM driver_selfies WHERE id = ?', [id]);
  if (!s) return res.status(404).json({ error: 'No existe' });
  const [u] = await pool.query("UPDATE driver_selfies SET status = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ? AND status = 'pending'", [result, req.staff.id, id]);
  if (!u.affectedRows) return res.status(409).json({ error: 'Esa selfie ya fue revisada' });
  await audit(req.staff, result === 'ok' ? 'selfie.ok' : 'selfie.mismatch', { target: s.driver_id, details: { selfie: id } });
  if (result === 'mismatch') {
    await pool.query("UPDATE users SET status = 'blocked' WHERE id = ? AND role = 'driver'", [s.driver_id]);
    await pool.query('DELETE FROM passkeys WHERE user_id = ?', [s.driver_id]);
    await kickUser(s.driver_id);
    push(s.driver_id, { title: 'Tu cuenta fue bloqueada', body: 'La selfie no coincide con tu foto. Escríbenos desde Ayuda y soporte si es un error.', tag: 'account-selfie', url: '/' }, { always: true });
  }
  res.json({ ok: true });
});

// Las selfies se borran a los 30 días (lo corre jobs.js)
export async function purgeSelfies() {
  const [rows] = await pool.query('SELECT id, file FROM driver_selfies WHERE created_at < NOW() - INTERVAL ? DAY', [SELFIE_KEEP_DAYS]);
  for (const s of rows) {
    await fs.rm(path.join(UPLOADS, s.file), { force: true });
    await pool.query('DELETE FROM driver_selfies WHERE id = ?', [s.id]);
  }
  return rows.length;
}
