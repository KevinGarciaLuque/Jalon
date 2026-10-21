// Alquiler de carros por días (con conductor). Reglas compartidas por la pantalla del pasajero, la del conductor y el panel.
// Estados: requested (pedido) → confirmed (el dueño aceptó) → active (entregado) → completed. También rejected y cancelled.
// Pago: efectivo al empezar, o transferencia a la cuenta de Jalón con comprobante que aprueba el personal antes de empezar.
import { pool } from '../db.js';
import { getSettings, postEntry, commissionFor, money } from '../wallet.js';
import { CATEGORY_LABEL } from '../fares.js';
import { io } from '../app.js';
import { drivers, room } from '../live.js';
import { push, pushStaff } from '../notify.js';
import { tellWallet } from './balance.js';
import { can } from '../perms.js';

// El carro de un conductor solo se alquila si él tiene el módulo «Ofrecer su carro en alquiler»
const ownerMayRent = (driverId) => !driverId || can({ id: driverId, role: 'driver' }, 'rent.offer');

export class RentalError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Fechas como texto AAAA-MM-DD en la hora de Honduras (UTC-6, sin horario de verano)
export const todayHN = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
export const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(`${d}T00:00:00Z`)) && addDays(d, 0) === d;

// Estados que ocupan el carro en esas fechas (un pedido sin responder también: así nadie pide lo mismo a la vez)
const HOLDS = "('requested','confirmed','active')";
const BOOKING_COLUMNS = `b.id, b.listing_id, b.vehicle_id, b.renter_id, b.owner_driver_id, b.mode, DATE_FORMAT(b.start_date, '%Y-%m-%d') AS start_date,
  DATE_FORMAT(b.end_date, '%Y-%m-%d') AS end_date, b.days, b.price_day, b.total, b.payment, b.status, b.payment_status, b.payment_note, b.pickup_text, b.note,
  b.assigned_driver, b.decline_note, b.cancelled_by, b.bank, b.reference, b.created_at, b.started_at, b.ended_at`;

// Revisa fechas y días con los ajustes. Devuelve { start, end, days }.
export function checkDates(s, start, days) {
  days = Number(days);
  if (!isDate(start)) throw new RentalError('Elige la fecha de inicio');
  if (!Number.isInteger(days) || days < 1 || days > Number(s.rental_max_days)) throw new RentalError(`Puedes alquilar de 1 a ${Number(s.rental_max_days)} días`);
  const today = todayHN();
  if (start < today) throw new RentalError('La fecha de inicio ya pasó');
  if (start > addDays(today, Number(s.rental_advance_days))) throw new RentalError(`Solo se puede reservar con hasta ${Number(s.rental_advance_days)} días de anticipación`);
  return { start, end: addDays(start, days - 1), days };
}

// Carros que se pueden alquilar con conductor y están libres en esas fechas
export async function searchAvailable(start, end, days) {
  const [rows] = await pool.query(
    `SELECT l.id AS listing_id, l.price_with_driver, l.notes, v.id AS vehicle_id, v.category, v.make, v.model, v.color, v.year, v.driver_id, u.name AS driver_name,
            (SELECT ROUND(AVG(stars), 1) FROM ratings WHERE ratee_id = v.driver_id) AS rating
     FROM rental_listings l JOIN vehicles v ON v.id = l.vehicle_id LEFT JOIN users u ON u.id = v.driver_id
     WHERE l.active = 1 AND l.with_driver = 1 AND l.price_with_driver > 0
       AND (v.driver_id IS NULL OR (u.status = 'active' AND u.deleted_at IS NULL))
       AND NOT EXISTS (SELECT 1 FROM rental_bookings b WHERE b.vehicle_id = v.id AND b.status IN ${HOLDS} AND b.start_date <= ? AND b.end_date >= ?)
     ORDER BY l.price_with_driver, l.id`,
    [end, start]
  );
  const allowed = [];
  for (const r of rows) if (await ownerMayRent(r.driver_id)) allowed.push(r);
  return allowed.map((r) => ({
    listingId: r.listing_id,
    vehicle: { category: r.category, categoryLabel: CATEGORY_LABEL[r.category], make: r.make, model: r.model, color: r.color, year: r.year },
    owner: r.driver_id ? 'driver' : 'fleet',
    driverName: r.driver_id ? r.driver_name.split(' ')[0] : null,
    rating: r.rating == null ? null : Number(r.rating),
    notes: r.notes,
    priceDay: Number(r.price_with_driver),
    total: money(Number(r.price_with_driver) * days),
  }));
}

// Crea la reserva. Dentro de una transacción con el carro bloqueado: dos personas que piden las mismas fechas a la vez no pueden quedarse ambas con él.
export async function createBooking(renter, { listingId, start, days, payment, pickup, note }) {
  const s = await getSettings(pool);
  if (s.rental_enabled !== '1') throw new RentalError('El alquiler de carros no está disponible por ahora', 409);
  const dates = checkDates(s, start, days);
  if (!['cash', 'transfer'].includes(payment)) throw new RentalError('Elige si pagas en efectivo o por transferencia');
  if (payment === 'transfer' && !(s.bank_name && s.bank_account && s.bank_holder)) throw new RentalError('El pago por transferencia no está disponible por ahora: elige efectivo', 409);
  const clip = (t, n) => (typeof t === 'string' && t.trim() ? t.trim().slice(0, n) : null);
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [[l]] = await conn.query(
      `SELECT l.id, l.vehicle_id, l.price_with_driver, v.driver_id FROM rental_listings l JOIN vehicles v ON v.id = l.vehicle_id
       WHERE l.id = ? AND l.active = 1 AND l.with_driver = 1 FOR UPDATE`, [Number(listingId)]
    );
    if (!l || !(Number(l.price_with_driver) > 0) || !(await ownerMayRent(l.driver_id))) throw new RentalError('Ese carro ya no está disponible para alquilar', 404);
    await conn.query('SELECT id FROM vehicles WHERE id = ? FOR UPDATE', [l.vehicle_id]);
    const [[busy]] = await conn.query(`SELECT COUNT(*) AS n FROM rental_bookings WHERE vehicle_id = ? AND status IN ${HOLDS} AND start_date <= ? AND end_date >= ?`, [l.vehicle_id, dates.end, dates.start]);
    if (busy.n) throw new RentalError('Ese carro ya está reservado en esas fechas. Elige otras fechas u otro carro.', 409);
    const [[mine]] = await conn.query(`SELECT COUNT(*) AS n FROM rental_bookings WHERE renter_id = ? AND status IN ('requested','confirmed')`, [renter.id]);
    if (mine.n >= 3) throw new RentalError('Ya tienes 3 alquileres pendientes. Espera a que te respondan o cancela alguno.', 429);
    const priceDay = Number(l.price_with_driver);
    const [r] = await conn.query(
      `INSERT INTO rental_bookings (listing_id, vehicle_id, renter_id, owner_driver_id, mode, start_date, end_date, days, price_day, total, payment, pickup_text, note)
       VALUES (?,?,?,?, 'with_driver', ?,?,?,?,?,?,?,?)`,
      [l.id, l.vehicle_id, renter.id, l.driver_id, dates.start, dates.end, dates.days, priceDay, money(priceDay * dates.days), payment, clip(pickup, 200), clip(note, 300)]
    );
    await conn.commit();
    const booking = await getBooking(r.insertId);
    const what = { title: 'Nueva solicitud de alquiler', body: `${renter.name} · ${dates.days} día${dates.days > 1 ? 's' : ''} desde el ${dates.start}`, tag: `rental-${r.insertId}`, url: '/' };
    if (l.driver_id) push(l.driver_id, what, { always: true });
    else pushStaff(what, 'rentals');
    tell(booking);
    return booking;
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}

export async function getBooking(id) {
  const [[b]] = await pool.query(
    `SELECT ${BOOKING_COLUMNS}, v.category, v.make, v.model, v.color, v.year, v.plate, r.name AS renter_name, r.phone AS renter_phone, d.name AS driver_name, d.phone AS driver_phone
     FROM rental_bookings b JOIN vehicles v ON v.id = b.vehicle_id JOIN users r ON r.id = b.renter_id LEFT JOIN users d ON d.id = b.owner_driver_id
     WHERE b.id = ?`, [Number(id)]
  );
  return b ? shape(b) : null;
}

export async function listBookings(where, params, limit = 100, offset = 0) {
  const [rows] = await pool.query(
    `SELECT ${BOOKING_COLUMNS}, v.category, v.make, v.model, v.color, v.year, v.plate, r.name AS renter_name, r.phone AS renter_phone, d.name AS driver_name, d.phone AS driver_phone
     FROM rental_bookings b JOIN vehicles v ON v.id = b.vehicle_id JOIN users r ON r.id = b.renter_id LEFT JOIN users d ON d.id = b.owner_driver_id
     WHERE ${where} ORDER BY b.start_date DESC, b.id DESC LIMIT ${Number(limit)} OFFSET ${Number(offset)}`, params
  );
  return rows.map(shape);
}

function shape(b) {
  return {
    ...b, price_day: Number(b.price_day), total: Number(b.total),
    vehicle: { category: b.category, categoryLabel: CATEGORY_LABEL[b.category], make: b.make, model: b.model, color: b.color, year: b.year, plate: b.plate },
    fleet: b.owner_driver_id == null,
  };
}

// Lo que cada persona ve de una reserva: el pasajero ve el teléfono del conductor solo cuando ya está confirmada
export function forRenter(b) {
  const { renter_phone: _renterPhone, bank: _bank, reference: _reference, ...rest } = b; // el pasajero no ve los datos de la transferencia ni su propio teléfono repetido
  const shareContact = ['confirmed', 'active'].includes(b.status);
  return { ...rest, driver_name: b.driver_name?.split(' ')[0] || null, driver_phone: shareContact ? b.driver_phone : null, vehicle: { ...b.vehicle, plate: shareContact ? b.vehicle.plate : null } };
}
export function forOwner(b) {
  const { bank: _bank, reference: _reference, ...rest } = b; // el conductor no ve los datos de la transferencia
  return { ...rest, renter_phone: ['confirmed', 'active'].includes(b.status) ? b.renter_phone : null };
}

// Avisa en vivo a quienes participan (pasajero y conductor) que la reserva cambió
function tell(b) {
  io.to(room(b.renter_id)).emit('rental:update', { id: b.id, status: b.status, payment_status: b.payment_status });
  if (b.owner_driver_id) io.to(room(b.owner_driver_id)).emit('rental:update', { id: b.id, status: b.status, payment_status: b.payment_status });
}

// Cambia el estado solo si la reserva sigue en el estado esperado (dos clics a la vez no la cambian dos veces)
async function move(id, from, to, extra = {}) {
  const sets = Object.keys(extra).map((k) => `${k} = ?`);
  const [r] = await pool.query(`UPDATE rental_bookings SET status = ?${sets.length ? `, ${sets.join(', ')}` : ''} WHERE id = ? AND status IN (?)`, [to, ...Object.values(extra), id, from]);
  if (r.affectedRows !== 1) throw new RentalError('Esa reserva ya cambió. Actualiza la pantalla.', 409);
  const b = await getBooking(id);
  tell(b);
  return b;
}

// El dueño (el conductor, o el personal si es de la flota) acepta o rechaza
export async function decide(b, accept, actorId, { note, assignedDriver } = {}) {
  const clip = (t, n) => (typeof t === 'string' && t.trim() ? t.trim().slice(0, n) : null);
  if (b.status !== 'requested') throw new RentalError('Esa solicitud ya fue respondida', 409);
  if (accept && b.end_date < todayHN()) throw new RentalError('Las fechas de esa solicitud ya pasaron', 409);
  if (accept && b.fleet && !clip(assignedDriver, 120)) throw new RentalError('Indica quién manejará el carro de la flota (nombre y teléfono)');
  const next = await move(b.id, ['requested'], accept ? 'confirmed' : 'rejected', {
    decided_by: actorId, decided_at: new Date(), decline_note: accept ? null : clip(note, 300), ...(accept && b.fleet ? { assigned_driver: clip(assignedDriver, 120) } : {}),
  });
  push(b.renter_id, accept
    ? { title: 'Tu alquiler fue confirmado', body: `${b.vehicle.make || ''} ${b.vehicle.model} · ${b.days} día${b.days > 1 ? 's' : ''} desde el ${b.start_date}${b.payment === 'transfer' ? '. Sube el comprobante de tu transferencia.' : ''}`.trim(), tag: `rental-${b.id}`, url: '/' }
    : { title: 'Tu solicitud de alquiler no fue aceptada', body: clip(note, 120) || 'Prueba con otras fechas u otro carro.', tag: `rental-${b.id}`, url: '/' }, { always: true });
  return next;
}

// Empieza el día de inicio. En efectivo se cobra en ese momento; por transferencia, el pago debe estar aprobado.
export async function start(b) {
  if (b.status !== 'confirmed') throw new RentalError('Solo se puede iniciar un alquiler confirmado', 409);
  if (b.start_date > todayHN()) throw new RentalError(`Este alquiler empieza el ${b.start_date}`, 409);
  if (b.payment === 'transfer' && b.payment_status !== 'approved') throw new RentalError('Falta que el equipo apruebe la transferencia antes de empezar', 409);
  const next = await move(b.id, ['confirmed'], 'active', { started_at: new Date() });
  // Mientras dura, el conductor no recibe viajes
  if (b.owner_driver_id) {
    drivers.delete(b.owner_driver_id);
    io.to(room(b.owner_driver_id)).emit('driver:denied', { status: 'rental' });
  }
  return next;
}

// Termina el alquiler. Si el carro es de un conductor: en efectivo se le descuenta la comisión del saldo;
// por transferencia (el dinero llegó a Jalón) se le acredita el total menos la comisión.
export async function finish(b) {
  if (b.status !== 'active') throw new RentalError('Solo se puede terminar un alquiler en curso', 409);
  const next = await move(b.id, ['active'], 'completed', { ended_at: new Date() });
  if (b.owner_driver_id) {
    const s = await getSettings(pool);
    const commission = s.commission_enabled === '1' ? commissionFor(b.total, s.commission_percent) : 0;
    const entry = b.payment === 'cash'
      ? commission > 0 && { amount: -commission, kind: 'rental_commission', note: `Comisión ${Number(s.commission_percent)}% del alquiler #${b.id}` }
      : { amount: money(b.total - commission), kind: 'rental_payout', note: `Alquiler #${b.id} pagado por transferencia (total L ${b.total}${commission ? `, comisión L ${commission}` : ''})` };
    if (entry) {
      const balance = await postEntry(pool, { userId: b.owner_driver_id, rentalId: b.id, ...entry });
      if (balance !== null) tellWallet(b.owner_driver_id, balance, { change: entry.amount, kind: entry.kind });
    }
  }
  return next;
}

export async function cancel(b, by) {
  const allowed = by === 'admin' ? ['requested', 'confirmed', 'active'] : ['requested', 'confirmed'];
  if (!allowed.includes(b.status)) throw new RentalError('Esa reserva ya no se puede cancelar', 409);
  if (by === 'renter' && b.status === 'confirmed' && b.start_date <= todayHN()) throw new RentalError('El alquiler empieza hoy: para cancelarlo comunícate con el conductor o con soporte', 409);
  const next = await move(b.id, allowed, 'cancelled', { cancelled_by: by });
  const msg = { title: 'Alquiler cancelado', body: `El alquiler del ${b.start_date} fue cancelado.`, tag: `rental-${b.id}`, url: '/' };
  if (by !== 'renter') push(b.renter_id, msg, { always: true });
  if (by !== 'owner' && b.owner_driver_id) push(b.owner_driver_id, msg, { always: true });
  return next;
}

// Las solicitudes sin respuesta cuya fecha ya pasó, y las confirmadas que nunca empezaron, se cancelan solas
export async function expireRentals() {
  const today = todayHN();
  const [rows] = await pool.query(
    "SELECT id FROM rental_bookings WHERE (status = 'requested' AND start_date < ?) OR (status = 'confirmed' AND end_date < ?)", [today, today]
  );
  for (const { id } of rows) {
    const [r] = await pool.query("UPDATE rental_bookings SET status = 'cancelled', cancelled_by = 'system' WHERE id = ? AND status IN ('requested','confirmed')", [id]);
    if (r.affectedRows) tell(await getBooking(id));
  }
  return rows.length;
}

// ¿El conductor tiene un alquiler en curso? (mientras tanto no recibe viajes)
export async function rentingNow(driverId) {
  const [[r]] = await pool.query("SELECT COUNT(*) AS n FROM rental_bookings WHERE owner_driver_id = ? AND status = 'active'", [driverId]);
  return r.n > 0;
}
