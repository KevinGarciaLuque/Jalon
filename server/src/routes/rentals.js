// Alquiler de carros por días: lo que usa el pasajero, el conductor que ofrece su carro y el personal (flota de Ktracho GO, pagos y reservas)
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { pool } from '../db.js';
import { sanitizeJpeg } from '../jpeg.js';
import { encryptBuffer, decryptBuffer } from '../secure.js';
import { getSettings, money } from '../wallet.js';
import { UPLOADS } from '../config.js';
import { app, photoJson } from '../app.js';
import { clean, pageOf } from '../util.js';
import { authUser, driverOnly, passengerOnly, needs, staffOnly, audit, auditOnce } from '../access.js';
import { push, pushStaff } from '../notify.js';
import { readVehicle, vehicleLabel, isPlateDup, vehicleOf } from '../services/vehicles.js';
import {
  RentalError, checkDates, searchAvailable, createBooking, getBooking, listBookings, forRenter, forOwner, decide, start, finish, cancel,
} from '../services/rentals.js';

// Los errores de las reglas del alquiler llegan como mensaje para la persona; el resto sigue al manejador general
const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof RentalError) return res.status(e.status).json({ error: e.message });
    next(e);
  }
};
const priceRange = (s) => ({ min: Number(s.rental_price_min), max: Number(s.rental_price_max) });
const STATUS_FILTER = ['requested', 'confirmed', 'active', 'completed', 'cancelled', 'rejected'];

// ---------- Pasajero ----------
// Carros libres en esas fechas, con el precio por día y el total
app.get('/api/rentals/search', authUser, passengerOnly, needs('rent'), handle(async (req, res) => {
  const s = await getSettings(pool);
  const info = { enabled: s.rental_enabled === '1', maxDays: Number(s.rental_max_days), advanceDays: Number(s.rental_advance_days), transfer: !!(s.bank_name && s.bank_account && s.bank_holder) };
  if (!info.enabled || !req.query.start) return res.json({ ...info, results: [] });
  const { start: from, end, days } = checkDates(s, String(req.query.start), req.query.days);
  res.json({ ...info, start: from, end, days, results: await searchAvailable(from, end, days) });
}));

app.post('/api/rentals', authUser, passengerOnly, needs('rent'), handle(async (req, res) => {
  const b = await createBooking(req.user, req.body || {});
  res.json({ ok: true, booking: forRenter(b) });
}));

app.get('/api/rentals/mine', authUser, passengerOnly, needs('rent'), handle(async (req, res) => {
  const s = await getSettings(pool);
  const bank = { name: s.bank_name, type: s.bank_account_type, account: s.bank_account, holder: s.bank_holder, note: s.bank_note };
  res.json({ bookings: (await listBookings('b.renter_id = ?', [req.user.id], 30)).map(forRenter), bank });
}));

app.post('/api/rentals/:id/cancel', authUser, passengerOnly, needs('rent'), handle(async (req, res) => {
  const b = await getBooking(req.params.id);
  if (!b || b.renter_id !== req.user.id) return res.status(404).json({ error: 'Reserva no encontrada' });
  res.json({ ok: true, booking: forRenter(await cancel(b, 'renter')) });
}));

// Pago por transferencia: la persona sube el comprobante y el personal lo revisa (igual que las recargas de saldo)
app.post('/api/rentals/:id/receipt', authUser, passengerOnly, needs('rent'), photoJson, handle(async (req, res) => {
  const b = await getBooking(req.params.id);
  if (!b || b.renter_id !== req.user.id) return res.status(404).json({ error: 'Reserva no encontrada' });
  if (b.payment !== 'transfer') return res.status(409).json({ error: 'Esta reserva se paga en efectivo' });
  if (!['requested', 'confirmed'].includes(b.status) || !['none', 'rejected'].includes(b.payment_status)) return res.status(409).json({ error: 'Esta reserva no espera un comprobante' });
  const bank = clean(req.body?.bank)?.slice(0, 60);
  const reference = clean(req.body?.reference)?.slice(0, 60);
  if (!bank || !reference || reference.length < 4) return res.status(400).json({ error: 'Indica el banco y el número de referencia de la transferencia' });
  const m = String(req.body?.image || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  let cleaned;
  try {
    const buf = m ? Buffer.from(m[1], 'base64') : null;
    if (!buf || buf.length > 2 * 1024 * 1024) throw new Error('imagen');
    cleaned = sanitizeJpeg(buf).buf;
  } catch {
    return res.status(400).json({ error: 'Sube una foto o captura del comprobante (JPG, menos de 2 MB)' });
  }
  // La misma transferencia o el mismo comprobante no sirven dos veces (ni en otra reserva ni en una recarga)
  const referenceKey = `${bank}:${reference}`.toUpperCase().replace(/[^A-Z0-9:]/g, '');
  const hash = crypto.createHash('sha256').update(cleaned).digest('hex');
  const [[dup]] = await pool.query(
    `SELECT (SELECT COUNT(*) FROM rental_bookings WHERE id <> ? AND payment_status IN ('pending','approved') AND (reference_key = ? OR receipt_hash = ?))
          + (SELECT COUNT(*) FROM topups WHERE status IN ('pending','approved') AND (reference_key = ? OR receipt_hash = ?)) AS n`,
    [b.id, referenceKey, hash, referenceKey, hash]
  );
  if (dup.n) return res.status(409).json({ error: 'Esa transferencia o ese comprobante ya fueron usados' });
  await fs.mkdir(UPLOADS, { recursive: true });
  const file = `rental-${b.id}-${crypto.randomBytes(8).toString('hex')}.enc`;
  await fs.writeFile(path.join(UPLOADS, file), encryptBuffer(cleaned));
  const [old] = await pool.query('SELECT receipt_file FROM rental_bookings WHERE id = ?', [b.id]);
  const [r] = await pool.query(
    "UPDATE rental_bookings SET payment_status = 'pending', bank = ?, reference = ?, reference_key = ?, receipt_file = ?, receipt_hash = ?, payment_note = NULL WHERE id = ? AND payment_status IN ('none','rejected')",
    [bank, reference, referenceKey, file, hash, b.id]
  );
  if (r.affectedRows !== 1) { await fs.rm(path.join(UPLOADS, file), { force: true }); return res.status(409).json({ error: 'Esta reserva no espera un comprobante' }); }
  if (old[0]?.receipt_file) await fs.rm(path.join(UPLOADS, old[0].receipt_file), { force: true });
  pushStaff({ title: 'Comprobante de alquiler por revisar', body: `${req.user.name} · L ${b.total}`, tag: `rental-pay-${b.id}`, url: '/' }, 'rentals');
  res.json({ ok: true });
}));

// ---------- Conductor que ofrece su carro (con él como conductor) ----------
app.get('/api/driver/rental', authUser, driverOnly, needs('rent.offer'), handle(async (req, res) => {
  const s = await getSettings(pool);
  const vehicle = await vehicleOf(pool, req.user.id);
  const [[listing]] = await pool.query(
    'SELECT l.id, l.active, l.price_with_driver, l.notes FROM rental_listings l JOIN vehicles v ON v.id = l.vehicle_id WHERE v.driver_id = ?', [req.user.id]
  );
  res.json({
    enabled: s.rental_enabled === '1', price: priceRange(s), vehicle,
    listing: listing ? { active: !!listing.active, price: Number(listing.price_with_driver), notes: listing.notes } : null,
    bookings: (await listBookings('b.owner_driver_id = ?', [req.user.id], 30)).map(forOwner),
  });
}));

app.put('/api/driver/rental', authUser, driverOnly, needs('rent.offer'), handle(async (req, res) => {
  const s = await getSettings(pool);
  if (s.rental_enabled !== '1') return res.status(409).json({ error: 'El alquiler de carros no está activo' });
  if (req.user.status !== 'active') return res.status(403).json({ error: 'Tu cuenta debe estar aprobada para ofrecer tu carro' });
  const [[v]] = await pool.query('SELECT id FROM vehicles WHERE driver_id = ?', [req.user.id]);
  if (!v) return res.status(409).json({ error: 'Primero registra tu vehículo (pídelo a soporte)' });
  const active = req.body?.active !== false;
  const price = money(req.body?.price);
  const { min, max } = priceRange(s);
  if (active && !(price >= min && price <= max)) return res.status(400).json({ error: `El precio por día debe ser de L ${min} a L ${max}` });
  const notes = clean(req.body?.notes)?.slice(0, 300) || null;
  await pool.query(
    `INSERT INTO rental_listings (vehicle_id, with_driver, price_with_driver, active, notes) VALUES (?, 1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE price_with_driver = IF(VALUES(active) = 1, VALUES(price_with_driver), price_with_driver), active = VALUES(active), notes = VALUES(notes)`,
    [v.id, price || null, active ? 1 : 0, notes]
  );
  res.json({ ok: true });
}));

const ownBooking = async (req, res) => {
  const b = await getBooking(req.params.id);
  if (!b || b.owner_driver_id !== req.user.id) { res.status(404).json({ error: 'Reserva no encontrada' }); return null; }
  return b;
};
app.post('/api/driver/rentals/:id/decide', authUser, driverOnly, needs('rent.offer'), handle(async (req, res) => {
  const b = await ownBooking(req, res);
  if (b) res.json({ ok: true, booking: forOwner(await decide(b, req.body?.accept === true, req.user.id, { note: req.body?.note })) });
}));
app.post('/api/driver/rentals/:id/start', authUser, driverOnly, needs('rent.offer'), handle(async (req, res) => {
  const b = await ownBooking(req, res);
  if (b) res.json({ ok: true, booking: forOwner(await start(b)) });
}));
app.post('/api/driver/rentals/:id/finish', authUser, driverOnly, needs('rent.offer'), handle(async (req, res) => {
  const b = await ownBooking(req, res);
  if (b) res.json({ ok: true, booking: forOwner(await finish(b)) });
}));
app.post('/api/driver/rentals/:id/cancel', authUser, driverOnly, needs('rent.offer'), handle(async (req, res) => {
  const b = await ownBooking(req, res);
  if (b) res.json({ ok: true, booking: forOwner(await cancel(b, 'owner')) });
}));

// ---------- Personal ----------
app.get('/api/admin/rentals', staffOnly('rentals'), handle(async (req, res) => {
  const status = STATUS_FILTER.includes(req.query.status) ? req.query.status : null;
  const payment = req.query.payment === 'pending';
  const where = payment ? "b.payment_status = 'pending'" : status ? 'b.status = ?' : '1 = 1';
  const { limit, offset } = pageOf(req, 200);
  res.json(await listBookings(where, status && !payment ? [status] : [], limit, offset));
}));

// Comprobante de la transferencia (cifrado en disco); cada vez que alguien lo abre queda en el Registro
app.get('/api/admin/rentals/:id/receipt', staffOnly('rentals'), handle(async (req, res) => {
  const [[b]] = await pool.query('SELECT renter_id, receipt_file FROM rental_bookings WHERE id = ?', [Number(req.params.id)]);
  if (!b?.receipt_file) return res.status(404).json({ error: 'No hay comprobante' });
  let blob;
  try {
    blob = await fs.readFile(path.join(UPLOADS, b.receipt_file));
  } catch {
    return res.status(404).json({ error: 'El archivo no está disponible' });
  }
  await auditOnce(req.staff, 'rental.receipt_view', b.renter_id, 10, { rental: Number(req.params.id) });
  res.set('Cache-Control', 'private, no-store');
  res.type('image/jpeg').send(decryptBuffer(blob));
}));

app.post('/api/admin/rentals/:id/payment', staffOnly('rentals'), handle(async (req, res) => {
  const b = await getBooking(req.params.id);
  if (!b) return res.status(404).json({ error: 'Reserva no encontrada' });
  const approve = req.body?.approve === true;
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
  if (!approve && note.length < 3) return res.status(400).json({ error: 'Escribe el motivo (la persona lo verá)' });
  const [r] = await pool.query(
    "UPDATE rental_bookings SET payment_status = ?, payment_note = ?, payment_reviewed_by = ?, payment_reviewed_at = NOW() WHERE id = ? AND payment_status = 'pending'",
    [approve ? 'approved' : 'rejected', approve ? null : note, req.staff.id, b.id]
  );
  if (r.affectedRows !== 1) return res.status(409).json({ error: 'Ese pago ya fue revisado' });
  await audit(req.staff, approve ? 'rental.payment_approve' : 'rental.payment_reject', { target: b.renter_id, details: { rental: b.id, total: b.total, ...(approve ? {} : { note }) } });
  push(b.renter_id, approve
    ? { title: 'Pago del alquiler aprobado', body: `Recibimos tu transferencia de L ${b.total}.`, tag: `rental-${b.id}`, url: '/' }
    : { title: 'Revisa el pago de tu alquiler', body: note, tag: `rental-${b.id}`, url: '/' }, { always: true });
  if (approve && b.owner_driver_id) push(b.owner_driver_id, { title: 'Alquiler pagado', body: `El alquiler del ${b.start_date} ya está pagado por transferencia.`, tag: `rental-${b.id}`, url: '/' }, { always: true });
  res.json({ ok: true });
}));

// Las reservas de la flota las atiende el personal; cualquiera la puede cancelar
const fleetBooking = async (req, res) => {
  const b = await getBooking(req.params.id);
  if (!b) { res.status(404).json({ error: 'Reserva no encontrada' }); return null; }
  if (!b.fleet) { res.status(409).json({ error: 'Esa reserva es del carro de un conductor: la atiende él' }); return null; }
  return b;
};
app.post('/api/admin/rentals/:id/decide', staffOnly('rentals'), handle(async (req, res) => {
  const b = await fleetBooking(req, res);
  if (!b) return;
  const next = await decide(b, req.body?.accept === true, req.staff.id, { note: req.body?.note, assignedDriver: req.body?.assignedDriver });
  await audit(req.staff, req.body?.accept === true ? 'rental.confirm' : 'rental.reject', { target: b.renter_id, details: { rental: b.id } });
  res.json({ ok: true, booking: next });
}));
app.post('/api/admin/rentals/:id/start', staffOnly('rentals'), handle(async (req, res) => {
  const b = await fleetBooking(req, res);
  if (b) res.json({ ok: true, booking: await start(b) });
}));
app.post('/api/admin/rentals/:id/finish', staffOnly('rentals'), handle(async (req, res) => {
  const b = await fleetBooking(req, res);
  if (b) res.json({ ok: true, booking: await finish(b) });
}));
app.post('/api/admin/rentals/:id/cancel', staffOnly('rentals'), handle(async (req, res) => {
  const b = await getBooking(req.params.id);
  if (!b) return res.status(404).json({ error: 'Reserva no encontrada' });
  const next = await cancel(b, 'admin');
  await audit(req.staff, 'rental.cancel', { target: b.renter_id, details: { rental: b.id } });
  res.json({ ok: true, booking: next });
}));

// Flota de Ktracho GO: carros sin conductor dueño, que el personal alquila (con un conductor que asigna al confirmar)
app.get('/api/admin/fleet', staffOnly('rentals'), handle(async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT v.id, v.category, v.make, v.model, v.color, v.year, v.plate, l.active, l.price_with_driver, l.notes
     FROM vehicles v LEFT JOIN rental_listings l ON l.vehicle_id = v.id WHERE v.driver_id IS NULL ORDER BY v.id DESC`
  );
  res.json(rows.map((r) => ({ ...r, active: !!r.active, price_with_driver: r.price_with_driver == null ? null : Number(r.price_with_driver) })));
}));

const fleetListing = (body) => {
  const price = money(body?.price);
  if (!(price > 0 && price <= 50000)) throw new RentalError('Escribe el precio por día');
  return { price, active: body?.active !== false ? 1 : 0, notes: clean(body?.notes)?.slice(0, 300) || null };
};
app.post('/api/admin/fleet', staffOnly('fleet'), handle(async (req, res) => {
  const { vehicle: v, error } = readVehicle(req.body);
  if (error) return res.status(400).json({ error });
  const l = fleetListing(req.body);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [r] = await conn.query('INSERT INTO vehicles (driver_id, category, make, model, color, year, plate) VALUES (NULL,?,?,?,?,?,?)', [v.category, v.make, v.model, v.color, v.year, v.plate]);
    await conn.query('INSERT INTO rental_listings (vehicle_id, with_driver, price_with_driver, active, notes) VALUES (?, 1, ?, ?, ?)', [r.insertId, l.price, l.active, l.notes]);
    await conn.commit();
    await audit(req.staff, 'fleet.add', { details: { vehicle: r.insertId, label: vehicleLabel(v), plate: v.plate } });
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    await conn.rollback().catch(() => {});
    if (isPlateDup(e)) return res.status(409).json({ error: 'Esa placa ya está registrada en otro vehículo' });
    throw e;
  } finally {
    conn.release();
  }
}));

app.put('/api/admin/fleet/:id', staffOnly('fleet'), handle(async (req, res) => {
  const [[v]] = await pool.query('SELECT id FROM vehicles WHERE id = ? AND driver_id IS NULL', [Number(req.params.id)]);
  if (!v) return res.status(404).json({ error: 'Ese carro no es de la flota' });
  const l = fleetListing(req.body);
  await pool.query(
    `INSERT INTO rental_listings (vehicle_id, with_driver, price_with_driver, active, notes) VALUES (?, 1, ?, ?, ?)
     ON DUPLICATE KEY UPDATE price_with_driver = VALUES(price_with_driver), active = VALUES(active), notes = VALUES(notes)`,
    [v.id, l.price, l.active, l.notes]
  );
  await audit(req.staff, 'fleet.edit', { details: { vehicle: v.id, price: l.price, active: !!l.active } });
  res.json({ ok: true });
}));
