// Panel del personal: mapa en vivo, recargas y saldo, ajustes, reportes, emergencias y cancelar viajes
import fs from 'fs/promises';
import path from 'path';
import { pool } from '../db.js';
import { decryptBuffer } from '../secure.js';
import { getSettings, clearSettingsCache, validateSettings, postEntry, money } from '../wallet.js';
import { UPLOADS, REPORT_TYPES } from '../config.js';
import { app } from '../app.js';
import { drivers } from '../live.js';
import { staffOnly, audit, auditOnce, actOn } from '../access.js';
import { push } from '../notify.js';
import { cancelRide } from '../services/rides.js';
import { tellWallet } from '../services/balance.js';
import { periodRange, connectedSeconds } from '../services/earnings.js';

// ---------- Monitoreo de conductores (permiso 'monitor') ----------
const RIDE_LIVE = "('accepted','arrived','started')";

// El superadmin decide qué administradores pueden ver el mapa en vivo
app.post('/api/admin/staff/:id/monitor', staffOnly('staff.manage'), async (req, res) => {
  if (typeof req.body?.enabled !== 'boolean') return res.status(400).json({ error: 'Indica si se activa o se quita' });
  const t = await actOn(req, res);
  if (!t) return;
  if (t.role !== 'admin') return res.status(400).json({ error: 'Solo se puede dar a un administrador (el superadministrador ya lo tiene y soporte no puede tenerlo)' });
  // Ahora es una excepción de permisos de esa persona (users.can_monitor se mantiene al día por compatibilidad)
  await pool.query('UPDATE users SET can_monitor = ? WHERE id = ?', [req.body.enabled ? 1 : 0, t.id]);
  await pool.query('INSERT INTO user_permissions (user_id, perm, allow, updated_by) VALUES (?, "monitor", ?, ?) ON DUPLICATE KEY UPDATE allow = VALUES(allow), updated_by = VALUES(updated_by)', [t.id, req.body.enabled ? 1 : 0, req.staff.id]);
  await audit(req.staff, 'staff.monitor', { target: t.id, details: { enabled: req.body.enabled } });
  res.json({ ok: true });
});

// Foto del momento: dónde está cada conductor conectado, en qué estado, y las solicitudes que esperan. El panel la pide cada pocos segundos.
app.get('/api/admin/monitor', staffOnly('monitor'), async (req, res) => {
  await auditOnce(req.staff, 'monitor.view', req.staff.id, 30);
  const list = [...drivers.values()];
  let rides = [];
  if (list.length) {
    [rides] = await pool.query(
      `SELECT r.id, r.driver_id, r.status, r.origin_lat, r.origin_lng, r.origin_text, r.dest_lat, r.dest_lng, r.dest_text, r.offered_price, r.final_price, p.name AS passenger
       FROM rides r JOIN users p ON p.id = r.passenger_id WHERE r.driver_id IN (?) AND r.status IN ${RIDE_LIVE}`, [list.map((d) => d.id)]
    );
  }
  const byDriver = new Map(rides.map((r) => [r.driver_id, r]));
  const now = Date.now();
  const out = list.map((d) => {
    const r = byDriver.get(d.id);
    return {
      id: d.id, name: d.name, vehicle: d.vehicle, plate: d.plate, lat: d.lat, lng: d.lng,
      state: r || !d.available ? 'busy' : d.disconnected ? 'away' : 'free',
      seenSecondsAgo: d.seenAt ? Math.round((now - d.seenAt) / 1000) : null,
      onlineMinutes: d.since ? Math.round((now - d.since) / 60000) : null,
      ride: r ? {
        id: r.id, status: r.status, passenger: r.passenger, price: Number(r.final_price ?? r.offered_price),
        origin: { lat: r.origin_lat, lng: r.origin_lng, text: r.origin_text }, dest: { lat: r.dest_lat, lng: r.dest_lng, text: r.dest_text },
      } : null,
    };
  });
  const [waiting] = await pool.query(
    `SELECT id, origin_lat AS lat, origin_lng AS lng, origin_text AS text, dest_text AS dest, offered_price AS price, TIMESTAMPDIFF(SECOND, created_at, NOW()) AS ageSeconds
     FROM rides WHERE status = 'requested' ORDER BY id DESC LIMIT 100`
  );
  res.json({
    at: now,
    counts: { free: out.filter((d) => d.state === 'free').length, busy: out.filter((d) => d.state === 'busy').length, away: out.filter((d) => d.state === 'away').length, waiting: waiting.length },
    drivers: out,
    waiting: waiting.map((w) => ({ ...w, price: Number(w.price) })),
  });
});

// Ficha de rendimiento de un conductor (últimos 30 días, más el total de viajes)
app.get('/api/admin/monitor/drivers/:id', staffOnly('monitor'), async (req, res) => {
  const id = Number(req.params.id);
  const [[u]] = await pool.query("SELECT id, name, phone, vehicle, plate, status, balance, created_at FROM users WHERE id = ? AND role = 'driver' AND deleted_at IS NULL", [id]);
  if (!u) return res.status(404).json({ error: 'Conductor no existe' });
  await auditOnce(req.staff, 'monitor.driver', id, 10);
  const [[r]] = await pool.query(
    `SELECT COALESCE(SUM(status = 'completed'),0) AS completed, COALESCE(SUM(status = 'cancelled' AND cancelled_by = 'driver'),0) AS cancelledByDriver,
            COALESCE(SUM(status = 'cancelled'),0) AS cancelled, COALESCE(SUM(IF(status = 'completed', final_price, 0)),0) AS earned,
            COALESCE(SUM(IF(status = 'completed', distance_km, 0)),0) AS km
     FROM rides WHERE driver_id = ? AND created_at > NOW() - INTERVAL 30 DAY`, [id]
  );
  const [[total]] = await pool.query("SELECT COUNT(*) AS n FROM rides WHERE driver_id = ? AND status = 'completed'", [id]);
  const [[o]] = await pool.query("SELECT COUNT(*) AS made, COALESCE(SUM(status = 'accepted'),0) AS accepted FROM offers WHERE driver_id = ? AND created_at > NOW() - INTERVAL 30 DAY", [id]);
  const [[rt]] = await pool.query('SELECT AVG(stars) AS avg, COUNT(*) AS n FROM ratings WHERE ratee_id = ?', [id]);
  const [[rp]] = await pool.query(
    `SELECT COUNT(*) AS total, COALESCE(SUM(rp.status = 'open'),0) AS open FROM reports rp JOIN rides r ON r.id = rp.ride_id WHERE r.driver_id = ? AND rp.user_id <> ?`, [id, id]
  );
  const [recent] = await pool.query(
    `SELECT id, status, cancelled_by, dest_text, final_price, offered_price, created_at FROM rides WHERE driver_id = ? ORDER BY id DESC LIMIT 8`, [id]
  );
  const d = drivers.get(id);
  const wallet = req.perms.includes('wallet');
  // Horas conectado en los últimos 30 días (con la app abierta)
  const { today } = await periodRange('day');
  const from = new Date(Date.parse(`${today}T00:00:00Z`) - 29 * 86400e3).toISOString().slice(0, 10);
  const hours30 = Math.round((await connectedSeconds(id, from, today)) / 360) / 10;
  let commission = null;
  if (wallet) {
    const [[c]] = await pool.query("SELECT COALESCE(-SUM(amount),0) AS v FROM wallet_entries WHERE user_id = ? AND kind = 'commission' AND created_at > NOW() - INTERVAL 30 DAY", [id]);
    commission = Number(c.v);
  }
  res.json({
    driver: { id: u.id, name: u.name, phone: u.phone, vehicle: u.vehicle, plate: u.plate, status: u.status, since: u.created_at },
    live: d ? { state: d.disconnected ? 'away' : d.available ? 'free' : 'busy', lat: d.lat, lng: d.lng, seenSecondsAgo: d.seenAt ? Math.round((Date.now() - d.seenAt) / 1000) : null, onlineMinutes: d.since ? Math.round((Date.now() - d.since) / 60000) : null } : null,
    last30: {
      completed: Number(r.completed), cancelled: Number(r.cancelled), cancelledByDriver: Number(r.cancelledByDriver), earned: Number(r.earned), km: Math.round(Number(r.km) * 10) / 10,
      offersMade: Number(o.made), offersAccepted: Number(o.accepted), hoursOnline: hours30,
      acceptanceRate: Number(o.made) ? Math.round((Number(o.accepted) / Number(o.made)) * 100) : null,
      ...(wallet ? { commission } : {}),
    },
    completedTotal: Number(total.n),
    rating: rt.n ? { avg: Math.round(Number(rt.avg) * 10) / 10, count: Number(rt.n) } : null,
    reports: { total: Number(rp.total), open: Number(rp.open) },
    ...(wallet ? { balance: Number(u.balance) } : {}),
    recent: recent.map((x) => ({ ...x, price: Number(x.final_price ?? x.offered_price) })),
  });
});

// --- Recargas de saldo: el personal revisa el comprobante y autoriza ---
app.get('/api/admin/topups', staffOnly('wallet'), async (req, res) => {
  const status = ['approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const [rows] = await pool.query(
    `SELECT t.id, t.amount, t.bank, t.reference, t.status, t.approved_amount, t.review_note, t.created_at, t.reviewed_at,
            u.id AS driver_id, u.name AS driver, u.phone AS driver_phone, u.balance AS driver_balance, r.name AS reviewer
     FROM topups t JOIN users u ON u.id = t.driver_id LEFT JOIN users r ON r.id = t.reviewed_by
     WHERE t.status = ? ORDER BY t.id DESC LIMIT 200`, [status]
  );
  res.json(rows.map((t) => ({ ...t, amount: Number(t.amount), approved_amount: t.approved_amount == null ? null : Number(t.approved_amount), driver_balance: Number(t.driver_balance) })));
});

app.get('/api/admin/topups/:id/receipt', staffOnly('wallet'), async (req, res) => {
  const [rows] = await pool.query('SELECT driver_id, receipt_file FROM topups WHERE id = ?', [Number(req.params.id)]);
  if (!rows[0]?.receipt_file) return res.status(404).json({ error: 'No hay comprobante' });
  let blob;
  try {
    blob = await fs.readFile(path.join(UPLOADS, rows[0].receipt_file));
  } catch {
    return res.status(404).json({ error: 'El archivo no está disponible' });
  }
  await auditOnce(req.staff, 'topup.view', rows[0].driver_id, 10, { topup: Number(req.params.id) });
  res.set('Cache-Control', 'private, no-store');
  res.type('image/jpeg').send(decryptBuffer(blob));
});

app.post('/api/admin/topups/:id/approve', staffOnly('wallet'), async (req, res) => {
  const id = Number(req.params.id);
  const [[t]] = await pool.query('SELECT * FROM topups WHERE id = ?', [id]);
  if (!t) return res.status(404).json({ error: 'Recarga no encontrada' });
  // El monto acreditado es el que muestra el comprobante (puede ser distinto al que escribió el conductor)
  const amount = req.body?.amount === undefined ? Number(t.amount) : money(req.body.amount);
  if (!(amount > 0 && amount <= 50000)) return res.status(400).json({ error: 'Monto inválido' });
  // Se "reclama" la solicitud de forma atómica: aunque dos personas pulsen Aprobar a la vez, solo una acredita
  const [claim] = await pool.query("UPDATE topups SET status = 'approved', approved_amount = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ? AND status = 'pending'", [amount, req.staff.id, id]);
  if (claim.affectedRows !== 1) return res.status(409).json({ error: 'Esa recarga ya fue revisada' });
  let balance;
  try {
    balance = await postEntry(pool, { userId: t.driver_id, amount, kind: 'topup', topupId: id, note: `Recarga por transferencia (${t.bank} ${t.reference})`, by: req.staff.id });
  } catch (e) {
    await pool.query("UPDATE topups SET status = 'pending', approved_amount = NULL, reviewed_by = NULL, reviewed_at = NULL WHERE id = ?", [id]); // no quedó acreditada: vuelve a la cola
    throw e;
  }
  await audit(req.staff, 'topup.approve', { target: t.driver_id, details: { topup: id, amount } });
  tellWallet(t.driver_id, balance, { change: amount, kind: 'topup' });
  push(t.driver_id, { title: 'Recarga aprobada', body: `Se acreditaron L ${amount.toFixed(2)}. Tu saldo es L ${balance.toFixed(2)}`, tag: `topup-${id}`, url: '/' }, { always: true });
  res.json({ ok: true, balance });
});

app.post('/api/admin/topups/:id/reject', staffOnly('wallet'), async (req, res) => {
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
  if (note.length < 3) return res.status(400).json({ error: 'Escribe el motivo (el conductor lo verá)' });
  const id = Number(req.params.id);
  const [[t]] = await pool.query('SELECT driver_id FROM topups WHERE id = ?', [id]);
  if (!t) return res.status(404).json({ error: 'Recarga no encontrada' });
  const [r] = await pool.query("UPDATE topups SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ? AND status = 'pending'", [note, req.staff.id, id]);
  if (r.affectedRows !== 1) return res.status(409).json({ error: 'Esa recarga ya fue revisada' });
  await audit(req.staff, 'topup.reject', { target: t.driver_id, details: { topup: id, note } });
  push(t.driver_id, { title: 'Recarga rechazada', body: note, tag: `topup-${id}`, url: '/' }, { always: true });
  res.json({ ok: true });
});

// Corrección manual del saldo (solo superadmin, con motivo): queda en el libro y en el registro
app.post('/api/admin/wallet/:userId/adjust', staffOnly('wallet.adjust'), async (req, res) => {
  const amount = money(req.body?.amount);
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
  if (!amount || Math.abs(amount) > 50000) return res.status(400).json({ error: 'Monto inválido' });
  if (note.length < 5) return res.status(400).json({ error: 'Explica el motivo del ajuste' });
  const [[d]] = await pool.query("SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL", [Number(req.params.userId)]);
  if (!d || d.role !== 'driver') return res.status(404).json({ error: 'Conductor no encontrado' });
  const balance = await postEntry(pool, { userId: d.id, amount, kind: 'adjustment', note: `Ajuste: ${note}`, by: req.staff.id });
  await audit(req.staff, 'wallet.adjust', { target: d.id, details: { amount, note } });
  tellWallet(d.id, balance, { change: amount, kind: 'adjustment' });
  res.json({ ok: true, balance });
});

app.get('/api/admin/settings', staffOnly('wallet'), async (_req, res) => res.json(await getSettings(pool)));

app.put('/api/admin/settings', staffOnly('settings'), async (req, res) => {
  const current = await getSettings(pool);
  const { values, error } = validateSettings(req.body || {}, current);
  if (error) return res.status(400).json({ error });
  const changed = Object.keys(values).filter((k) => values[k] !== current[k]);
  for (const k of changed) await pool.query('INSERT INTO settings (name, value, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)', [k, values[k], req.staff.id]);
  clearSettingsCache();
  if (changed.length) await audit(req.staff, 'settings.update', { details: { changed } });
  res.json(await getSettings(pool));
});

// Reportes de los usuarios, con los datos de las dos personas del viaje para poder contactarlas
app.get('/api/admin/reports', staffOnly('alerts'), async (req, res) => {
  const status = req.query.status === 'resolved' ? 'resolved' : 'open';
  const [rows] = await pool.query(
    `SELECT rp.id, rp.ride_id, rp.type, rp.text, rp.status, rp.resolution, rp.created_at, rp.resolved_at,
            u.id AS reporter_id, u.name AS reporter, u.phone AS reporter_phone, u.role AS reporter_role,
            o.id AS other_id, o.name AS other, o.phone AS other_phone, o.role AS other_role
     FROM reports rp JOIN rides r ON r.id = rp.ride_id JOIN users u ON u.id = rp.user_id
     LEFT JOIN users o ON o.id = IF(rp.user_id = r.passenger_id, r.driver_id, r.passenger_id)
     WHERE rp.status = ? ORDER BY rp.id DESC LIMIT 200`, [status]
  );
  res.json(rows.map((r) => ({ ...r, type_label: REPORT_TYPES[r.type] })));
});

app.post('/api/admin/reports/:id/resolve', staffOnly('alerts'), async (req, res) => {
  const resolution = typeof req.body?.resolution === 'string' ? req.body.resolution.trim().slice(0, 500) : '';
  if (resolution.length < 3) return res.status(400).json({ error: 'Escribe cómo se resolvió (la persona lo verá)' });
  const [[rep]] = await pool.query('SELECT id, user_id, status FROM reports WHERE id = ?', [Number(req.params.id)]);
  if (!rep) return res.status(404).json({ error: 'Reporte no encontrado' });
  if (rep.status === 'resolved') return res.status(409).json({ error: 'Ese reporte ya estaba resuelto' });
  await pool.query("UPDATE reports SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = NOW() WHERE id = ?", [resolution, req.staff.id, rep.id]);
  await audit(req.staff, 'report.resolve', { target: rep.user_id, details: { report: rep.id } });
  push(rep.user_id, { title: 'Tu reporte fue atendido', body: resolution.length > 100 ? `${resolution.slice(0, 97)}…` : resolution, tag: `report-${rep.id}`, url: '/' }, { always: true });
  res.json({ ok: true });
});

// Alertas de emergencia (botón SOS) con los datos de quienes viajan
app.get('/api/admin/alerts', staffOnly('alerts'), async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, a.lat, a.lng, a.created_at, a.ride_id, r.status AS ride_status,
            u.name AS user_name, u.phone AS user_phone, u.role AS user_role,
            p.name AS passenger, p.phone AS passenger_phone,
            d.name AS driver, d.phone AS driver_phone, d.vehicle, d.plate
     FROM alerts a JOIN rides r ON r.id = a.ride_id JOIN users u ON u.id = a.user_id
     JOIN users p ON p.id = r.passenger_id LEFT JOIN users d ON d.id = r.driver_id
     WHERE a.status = 'open' ORDER BY a.id DESC`
  );
  res.json(rows);
});

app.post('/api/admin/alerts/:id/resolve', staffOnly('alerts'), async (req, res) => {
  await pool.query("UPDATE alerts SET status = 'resolved', resolved_at = NOW() WHERE id = ?", [Number(req.params.id)]);
  await audit(req.staff, 'alert.resolve', { details: { alert: Number(req.params.id) } });
  res.json({ ok: true });
});

app.post('/api/admin/rides/:id/cancel', staffOnly('rides.cancel'), async (req, res) => {
  const view = await cancelRide(Number(req.params.id), 'admin');
  if (!view) return res.status(409).json({ error: 'El viaje ya no está activo' });
  await audit(req.staff, 'ride.cancel', { details: { ride: Number(req.params.id) } });
  res.json({ ok: true });
});
