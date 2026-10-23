// Panel del personal: indicadores, usuarios, personal, documentos, registro y chat de viajes con emergencia
import fs from 'fs/promises';
import path from 'path';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { normalizePhone } from '../phone.js';
import { normalizeEmail, domainAcceptsMail } from '../mail.js';
import { decryptBuffer, isEncrypted } from '../secure.js';
import { reportError, UPLOADS, DOC_TYPES, SOS_PHONES } from '../config.js';
import { app, io } from '../app.js';
import { drivers, room } from '../live.js';
import { push } from '../notify.js';
import { clean, tempPassword, pageOf } from '../util.js';
import { isStaff, staffOnly, audit, auditOnce, actOn } from '../access.js';
import { ratingsOf, kickUser } from '../services/rides.js';
import { grantWelcome } from '../services/balance.js';
import { anonymizeUser } from '../services/accounts.js';
import { readVehicle, saveVehicle, vehicleOf, vehicleLabel, isPlateDup } from '../services/vehicles.js';

app.get('/api/admin/stats', staffOnly('view'), async (_req, res) => {
  const [[u]] = await pool.query(
    `SELECT SUM(role='passenger') AS passengers, SUM(role='driver') AS drivers,
            SUM(role='driver' AND status='pending') AS pending, SUM(status='blocked' AND deleted_at IS NULL) AS blocked FROM users`
  );
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(status='completed') AS completed, SUM(status='cancelled') AS cancelled,
            SUM(status IN ('requested','accepted','arrived','started')) AS active,
            COALESCE(SUM(IF(status='completed', final_price, 0)),0) AS revenue
     FROM rides`
  );
  res.json({
    passengers: Number(u.passengers || 0),
    drivers: Number(u.drivers || 0),
    pendingDrivers: Number(u.pending || 0),
    blockedUsers: Number(u.blocked || 0),
    openAlerts: (await pool.query("SELECT COUNT(*) AS n FROM alerts WHERE status = 'open'"))[0][0].n,
    openReports: (await pool.query("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"))[0][0].n,
    pendingTopups: (await pool.query("SELECT COUNT(*) AS n FROM topups WHERE status = 'pending'"))[0][0].n,
    waitingSelfies: (await pool.query("SELECT COUNT(*) AS n FROM driver_selfies WHERE status = 'pending'"))[0][0].n, // selfies por revisar
    waitingRequests: (await pool.query("SELECT COUNT(*) AS n FROM topup_requests WHERE status = 'waiting'"))[0][0].n, // conductores esperando una cuenta
    sosPhones: SOS_PHONES.length, // cuántos teléfonos reciben las emergencias por SMS (0 = nadie)
    driversOnline: [...drivers.values()].length,
    driversFree: [...drivers.values()].filter((d) => d.available && !d.disconnected).length,
    rides: { total: r.total, completed: Number(r.completed || 0), cancelled: Number(r.cancelled || 0), active: Number(r.active || 0) },
    revenue: Number(r.revenue),
  });
});

// Búsqueda (nombre, teléfono, placa o vehículo) y filtros en el servidor, por páginas
const USER_FILTERS = {
  people: "role IN ('passenger','driver')",
  passenger: "role = 'passenger'",
  driver: "role = 'driver'",
  blocked: "role IN ('passenger','driver') AND status = 'blocked' AND deleted_at IS NULL",
  pending: "role = 'driver' AND status = 'pending' AND deleted_at IS NULL",
  staff: "role IN ('superadmin','admin','support') AND deleted_at IS NULL",
};
app.get('/api/admin/users', staffOnly('view'), async (req, res) => {
  const { limit, offset } = pageOf(req, 500);
  const where = [USER_FILTERS[req.query.filter] || '1 = 1'];
  const params = [];
  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 60) : '';
  if (q) {
    where.push('(name LIKE ? OR phone LIKE ? OR plate LIKE ? OR vehicle LIKE ?)');
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    params.push(like, like, like, like);
  }
  const [found] = await pool.query(
    `SELECT id, name, phone, role, status, vehicle, plate, created_at, must_change_password, deleted_at, balance,
            (SELECT COUNT(*) FROM documents d WHERE d.user_id = users.id AND d.status = 'uploaded') AS docs
     FROM users WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT ? OFFSET ?`, [...params, limit + 1, offset]
  );
  const hasMore = found.length > limit;
  const rows = found.slice(0, limit);
  const ratings = await ratingsOf(rows.map((u) => u.id));
  // Cada quien recibe también lo que puede hacer, para que la pantalla muestre solo lo permitido
  res.json({ perms: req.perms, me: { id: req.staff.id, role: req.staff.role }, hasMore, users: rows.map(({ balance, ...u }) => ({ ...u, ...(req.perms.includes('wallet') && u.role === 'driver' ? { balance: Number(balance) } : {}), online: drivers.has(u.id), rating: ratings.get(u.id) || null })) });
});

const RIDE_FILTERS = { active: "r.status IN ('requested','accepted','arrived','started')", completed: "r.status = 'completed'", cancelled: "r.status = 'cancelled'" };
app.get('/api/admin/rides', staffOnly('view'), async (req, res) => {
  const { limit, offset } = pageOf(req, 200);
  const [rows] = await pool.query(
    `SELECT r.id, r.status, r.cancelled_by, r.category, r.distance_km, r.offered_price, r.final_price, r.created_at,
            p.name AS passenger, d.name AS driver
     FROM rides r JOIN users p ON p.id = r.passenger_id LEFT JOIN users d ON d.id = r.driver_id
     WHERE ${RIDE_FILTERS[req.query.status] || '1 = 1'} ORDER BY r.id DESC LIMIT ? OFFSET ?`, [limit, offset]
  );
  res.json(rows);
});

// Ficha completa de un usuario: datos, estadísticas, últimos viajes, documentos y movimientos del personal sobre su cuenta
// Confirmar el sexo de una conductora (visto en su licencia): así recibe los viajes «solo conductoras»
app.post('/api/admin/users/:id/gender', staffOnly('users.manage'), async (req, res) => {
  const id = Number(req.params.id);
  const [[u]] = await pool.query('SELECT id, role, gender FROM users WHERE id = ? AND deleted_at IS NULL', [id]);
  if (!u || u.role !== 'driver') return res.status(404).json({ error: 'Conductor no encontrado' });
  const verified = !!req.body?.verified;
  if (verified && !u.gender) return res.status(400).json({ error: 'La conductora todavía no indicó su sexo en Mi cuenta' });
  await pool.query('UPDATE users SET gender_verified = ? WHERE id = ?', [verified ? 1 : 0, id]);
  const d = drivers.get(id);
  if (d) d.woman = verified && u.gender === 'f';
  await audit(req.staff, verified ? 'user.gender.verify' : 'user.gender.unverify', { target: id });
  res.json({ ok: true });
});

app.get('/api/admin/users/:id', staffOnly('view'), async (req, res) => {
  const id = Number(req.params.id);
  const [[u]] = await pool.query(
    `SELECT id, name, phone, email, role, status, vehicle, plate, gender, gender_verified, created_at, terms_accepted_at, terms_version, must_change_password, deleted_at, totp_enabled, can_monitor
     FROM users WHERE id = ?`, [id]
  );
  if (!u) return res.status(404).json({ error: 'Usuario no existe' });
  const [[stats]] = await pool.query(
    `SELECT COALESCE(SUM(passenger_id = ?),0) AS asPassenger, COALESCE(SUM(driver_id = ?),0) AS asDriver,
            COALESCE(SUM(status = 'completed'),0) AS completed, COALESCE(SUM(status = 'cancelled'),0) AS cancelled,
            COALESCE(SUM(IF(status = 'completed', final_price, 0)),0) AS money
     FROM rides WHERE passenger_id = ? OR driver_id = ?`, [id, id, id, id]
  );
  const [rides] = await pool.query(
    `SELECT r.id, r.status, r.cancelled_by, r.dest_text, r.distance_km, r.final_price, r.offered_price, r.created_at, o.name AS other_name
     FROM rides r LEFT JOIN users o ON o.id = IF(r.passenger_id = ?, r.driver_id, r.passenger_id)
     WHERE r.passenger_id = ? OR r.driver_id = ? ORDER BY r.id DESC LIMIT 10`, [id, id, id]
  );
  const can = req.perms;
  const docs = can.includes('docs') ? (await pool.query('SELECT id, type, status, note, created_at FROM documents WHERE user_id = ?', [id]))[0] : null;
  const history = can.includes('audit')
    ? (await pool.query(
        `SELECT a.id, a.action, a.details, a.created_at, s.name AS actor FROM audit_log a JOIN users s ON s.id = a.actor_id
         WHERE a.target_user_id = ? ORDER BY a.id DESC LIMIT 15`, [id]
      ))[0].map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }))
    : null;
  let wallet = null;
  if (can.includes('wallet') && u.role === 'driver') {
    const [[b]] = await pool.query('SELECT balance FROM users WHERE id = ?', [id]);
    const [entries] = await pool.query('SELECT id, amount, kind, ride_id, note, created_at FROM wallet_entries WHERE user_id = ? ORDER BY id DESC LIMIT 15', [id]);
    wallet = { balance: Number(b.balance), entries };
  }
  res.json({
    user: { ...u, online: drivers.has(id) },
    vehicle: u.role === 'driver' ? await vehicleOf(pool, id) : null,
    wallet,
    stats: { ...stats, money: Number(stats.money) },
    rating: (await ratingsOf([id])).get(id) || null,
    rides, docs, history,
  });
});

// Corregir los datos de un usuario (nombre, teléfono, vehículo y placa)
app.patch('/api/admin/users/:id', staffOnly('users.manage'), async (req, res) => {
  const t = await actOn(req, res);
  if (!t) return;
  const { name, phone, vehicle, plate } = req.body || {};
  const fields = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'Nombre inválido' });
    fields.name = name.trim();
  }
  if (phone !== undefined) {
    const p = normalizePhone(phone);
    if (!p) return res.status(400).json({ error: 'Teléfono inválido (8 dígitos de Honduras)' });
    fields.phone = p;
  }
  if (t.role === 'driver') {
    if (vehicle !== undefined) {
      if (typeof vehicle !== 'string' || !vehicle.trim() || vehicle.length > 100) return res.status(400).json({ error: 'Vehículo inválido' });
      fields.vehicle = vehicle.trim();
    }
    if (plate !== undefined) {
      if (typeof plate !== 'string' || !plate.trim() || plate.length > 20) return res.status(400).json({ error: 'Placa inválida' });
      fields.plate = plate.trim();
    }
  }
  const keys = Object.keys(fields).filter((k) => fields[k] !== t[k]);
  if (!keys.length) return res.status(400).json({ error: 'No hay cambios que guardar' });
  const userKeys = keys.filter((k) => k !== 'vehicle' && k !== 'plate');
  try {
    if (userKeys.length) await pool.query(`UPDATE users SET ${userKeys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...userKeys.map((k) => fields[k]), t.id]);
    // El texto del vehículo y la placa van a su vehículo (formato anterior: el texto pasa a ser el modelo)
    if (userKeys.length < keys.length) {
      const cur = (await vehicleOf(pool, t.id)) || { category: 'car', plate: t.plate, model: t.vehicle };
      const next = fields.vehicle ? { ...cur, make: null, color: null, year: null, model: fields.vehicle } : cur;
      const { vehicle: v, error } = readVehicle({ ...next, plate: fields.plate ?? cur.plate });
      if (error) return res.status(400).json({ error });
      await saveVehicle(pool, t.id, v);
      liveVehicle(t.id, v);
    }
  } catch (e) {
    if (isPlateDup(e)) return res.status(409).json({ error: 'Esa placa ya está registrada en otro vehículo' });
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese teléfono ya pertenece a otra cuenta' });
    throw e;
  }
  await audit(req.staff, 'user.edit', { target: t.id, details: { changed: keys } });
  res.json({ ok: true });
});

// Si el conductor está conectado, su categoría y su vehículo cambian también en memoria (para las próximas solicitudes)
function liveVehicle(driverId, v) {
  const d = drivers.get(driverId);
  if (d) Object.assign(d, { category: v.category, vehicle: vehicleLabel(v), plate: v.plate });
}

// Vehículo de un conductor: categoría, marca, modelo, color, año y placa
app.put('/api/admin/users/:id/vehicle', staffOnly('users.manage'), async (req, res) => {
  const t = await actOn(req, res);
  if (!t) return;
  if (t.role !== 'driver') return res.status(400).json({ error: 'Solo los conductores tienen vehículo' });
  const { vehicle: v, error } = readVehicle(req.body);
  if (error) return res.status(400).json({ error });
  try {
    await saveVehicle(pool, t.id, v);
  } catch (e) {
    if (isPlateDup(e)) return res.status(409).json({ error: 'Esa placa ya está registrada en otro vehículo' });
    throw e;
  }
  liveVehicle(t.id, v);
  await audit(req.staff, 'user.vehicle', { target: t.id, details: { category: v.category, plate: v.plate } });
  res.json({ ok: true, vehicle: v });
});

// Restablecer la contraseña: se genera una temporal que se muestra una sola vez y el usuario debe cambiarla al entrar
app.post('/api/admin/users/:id/reset-password', staffOnly('users.manage'), async (req, res) => {
  const t = await actOn(req, res);
  if (!t) return;
  const temp = tempPassword();
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(temp, 10), t.id]);
  io.in(room(t.id)).disconnectSockets(true);
  await audit(req.staff, 'user.reset_password', { target: t.id });
  res.json({ tempPassword: temp });
});

app.post('/api/admin/users/:id/delete', staffOnly('staff.manage'), async (req, res) => {
  const t = await actOn(req, res);
  if (!t) return;
  await anonymizeUser(t);
  await audit(req.staff, 'user.delete', { target: t.id, details: { role: t.role } });
  res.json({ ok: true });
});

// Aprobar / desbloquear (active) o bloquear (blocked) a un usuario
app.post('/api/admin/users/:id/status', staffOnly('users.manage'), async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'blocked'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
  const t = await actOn(req, res);
  if (!t) return;
  if (status === 'active' && t.role === 'driver') {
    const [[c]] = await pool.query("SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND status = 'uploaded'", [t.id]);
    if (c.n < DOC_TYPES.length)
      return res.status(409).json({ error: 'El conductor debe subir los 3 documentos (foto, licencia y matrícula) antes de aprobarlo' });
  }
  await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, t.id]);
  io.to(room(t.id)).emit('account:status', { status });
  if (status === 'blocked') {
    await kickUser(t.id);
    await pool.query('DELETE FROM passkeys WHERE user_id = ?', [t.id]); // ya no puede entrar con Face ID
  }
  await audit(req.staff, status === 'blocked' ? 'user.block' : t.status === 'pending' ? 'user.approve' : 'user.unblock', { target: t.id });
  if (status === 'active' && t.role === 'driver' && t.status === 'pending') {
    grantWelcome(t.id).catch(reportError);
    push(t.id, { title: '¡Tu cuenta fue aprobada!', body: 'Ya puedes ponerte disponible y recibir viajes.', tag: 'account', url: '/' }, { always: true });
  }
  res.json({ ok: true });
});

// --- Gestión del personal (solo superadmin) ---
app.post('/api/admin/users/:id/reset-2fa', staffOnly('staff.manage'), async (req, res) => {
  const t = await actOn(req, res);
  if (!t) return;
  if (!isStaff(t.role)) return res.status(400).json({ error: 'Esa cuenta no es del personal' });
  await pool.query(
    `UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, backup_codes = NULL, two_fa_failures = 0,
            two_fa_locked_until = NULL, token_version = token_version + 1 WHERE id = ?`, [t.id]
  );
  await audit(req.staff, '2fa.reset', { target: t.id });
  res.json({ ok: true });
});

app.post('/api/admin/staff', staffOnly('staff.manage'), async (req, res) => {
  const { name, phone, role } = req.body || {};
  const p = normalizePhone(phone);
  if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'Nombre inválido' });
  if (!p) return res.status(400).json({ error: 'Teléfono inválido (8 dígitos de Honduras)' });
  if (!['admin', 'support'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });
  const temp = tempPassword();
  try {
    const [r] = await pool.query(
      "INSERT INTO users (name, phone, password_hash, role, status, must_change_password) VALUES (?,?,?,?, 'active', 1)",
      [name.trim(), p, await bcrypt.hash(temp, 10), role]
    );
    await audit(req.staff, 'staff.create', { target: r.insertId, details: { role } });
    res.json({ id: r.insertId, tempPassword: temp });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese teléfono ya está registrado' });
    throw e;
  }
});

// El superadmin da de alta a un pasajero (por ejemplo, alguien que no puede registrarse solo). Recibe una contraseña temporal y debe cambiarla al entrar.
app.post('/api/admin/users', staffOnly('users.create'), async (req, res) => {
  const { name, phone } = req.body || {};
  const p = normalizePhone(phone);
  const rawEmail = typeof req.body?.email === 'string' ? req.body.email.trim() : '';
  const email = rawEmail ? normalizeEmail(rawEmail) : null;
  if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'Nombre inválido' });
  if (!p) return res.status(400).json({ error: 'Teléfono inválido (8 dígitos de Honduras)' });
  if (rawEmail && !email) return res.status(400).json({ error: 'El correo no es válido' });
  if (email && !(await domainAcceptsMail(email))) return res.status(400).json({ error: 'Ese correo no parece existir. Revisa cómo lo escribiste.' });
  const temp = tempPassword();
  try {
    const [r] = await pool.query(
      "INSERT INTO users (name, phone, email, password_hash, role, status, must_change_password) VALUES (?,?,?,?, 'passenger', 'active', 1)",
      [name.trim(), p, email, await bcrypt.hash(temp, 10)]
    );
    await audit(req.staff, 'user.create', { target: r.insertId, details: { role: 'passenger' } });
    res.json({ id: r.insertId, tempPassword: temp });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: /email/.test(e.message) ? 'Ese correo ya está registrado' : 'Ese teléfono ya está registrado' });
    throw e;
  }
});

app.post('/api/admin/staff/:id/role', staffOnly('staff.manage'), async (req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'support'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });
  const t = await actOn(req, res);
  if (!t) return;
  if (!isStaff(t.role)) return res.status(400).json({ error: 'Esa cuenta no es del personal' });
  if (t.role === role) return res.status(400).json({ error: 'Ya tiene ese rol' });
  await pool.query('UPDATE users SET role = ?, can_monitor = 0 WHERE id = ?', [role, t.id]);
  await pool.query('DELETE FROM user_permissions WHERE user_id = ?', [t.id]); // al cambiar de rol no se heredan las excepciones
  await audit(req.staff, 'staff.role', { target: t.id, details: { from: t.role, to: role } });
  res.json({ ok: true });
});

app.get('/api/admin/audit', staffOnly('audit'), async (req, res) => {
  const { limit, offset } = pageOf(req, 200);
  const [rows] = await pool.query(
    `SELECT a.id, a.action, a.details, a.created_at, a.target_user_id, s.name AS actor, s.role AS actor_role, t.name AS target_name
     FROM audit_log a JOIN users s ON s.id = a.actor_id LEFT JOIN users t ON t.id = a.target_user_id
     ORDER BY a.id DESC LIMIT ? OFFSET ?`, [limit, offset]
  );
  res.json(rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })));
});

// Documentos de un conductor y descarga de cada imagen
app.get('/api/admin/users/:id/documents', staffOnly('docs'), async (req, res) => {
  const [rows] = await pool.query('SELECT id, type, status, note, created_at FROM documents WHERE user_id = ?', [Number(req.params.id)]);
  res.json(rows);
});

app.get('/api/admin/documents/:id/file', staffOnly('docs'), async (req, res) => {
  const [rows] = await pool.query('SELECT user_id, file FROM documents WHERE id = ?', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'No existe' });
  let blob;
  try {
    blob = await fs.readFile(path.join(UPLOADS, rows[0].file));
  } catch {
    return res.status(404).json({ error: 'El archivo no está disponible' });
  }
  await auditOnce(req.staff, 'doc.view', rows[0].user_id); // queda anotado quién abrió los documentos de quién
  res.set('Cache-Control', 'private, no-store');
  res.type('image/jpeg').send(isEncrypted(blob) ? decryptBuffer(blob) : blob);
});

app.post('/api/admin/documents/:id/reject', staffOnly('docs'), async (req, res) => {
  const [rows] = await pool.query('SELECT user_id, type FROM documents WHERE id = ?', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'No existe' });
  const note = clean(req.body?.note);
  await pool.query("UPDATE documents SET status = 'rejected', note = ? WHERE id = ?", [note, Number(req.params.id)]);
  io.to(room(rows[0].user_id)).emit('docs:changed');
  push(rows[0].user_id, { title: 'Un documento fue rechazado', body: `${{ photo: 'Tu foto', license: 'Tu licencia', registration: 'La matrícula' }[rows[0].type] || 'Un documento'}${note ? `: ${note}` : ''}. Súbelo de nuevo desde la app.`, tag: 'docs', target: 'docs', url: '/' }, { always: true });
  await audit(req.staff, 'doc.reject', { target: rows[0].user_id, details: { type: rows[0].type, note } });
  res.json({ ok: true });
});

// Chat de un viaje con una emergencia, para entender qué pasó. Solo viajes con alerta; cada consulta queda anotada.
app.get('/api/admin/rides/:id/chat', staffOnly('alerts'), async (req, res) => {
  const id = Number(req.params.id);
  const [[ride]] = await pool.query('SELECT id, passenger_id, driver_id FROM rides WHERE id = ?', [id]);
  if (!ride) return res.status(404).json({ error: 'Viaje no encontrado' });
  const [[has]] = await pool.query('SELECT (SELECT COUNT(*) FROM alerts WHERE ride_id = ?) + (SELECT COUNT(*) FROM reports WHERE ride_id = ?) AS n', [id, id]);
  if (!has.n) return res.status(403).json({ error: 'El chat solo se puede ver en viajes con una emergencia o un reporte' });
  await auditOnce(req.staff, 'chat.view', ride.passenger_id, 10, { ride: id });
  const [rows] = await pool.query('SELECT m.id, m.sender_id AS senderId, u.name AS sender, m.text, m.created_at AS at FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.ride_id = ? ORDER BY m.id', [id]);
  res.json({ passengerId: ride.passenger_id, driverId: ride.driver_id, messages: rows });
});
