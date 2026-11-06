// Viajes entre ciudades (etapa 1: viaje privado). El pasajero publica su viaje con fecha y precio; los conductores
// aceptan esa tarifa o proponen otra tarifa y otra hora; el pasajero elige. El viaje queda «reservado» y, un rato antes
// de la salida, pasa a ser un viaje normal (aceptado): desde ahí usa lo de siempre (llegué, PIN, chat, SOS, comisión).
// Estados: 'board' (publicado) → 'booked' (reservado) → 'accepted' … 'completed'; o 'cancelled'.
import crypto from 'crypto';
import { pool } from '../db.js';
import { app, io } from '../app.js';
import { distanceKm } from '../geo.js';
import { getRoute, reversePlace } from '../maps.js';
import { getSettings, money } from '../wallet.js';
import { authUser, driverOnly, passengerOnly } from '../access.js';
import { isPoint, clean, serial } from '../util.js';
import { push } from '../notify.js';
import { drivers, room } from '../live.js';
import { reportError } from '../config.js';
import { ratingsOf, activeRideFor, rideView, getRide } from '../services/rides.js';
import { walletGate } from '../services/balance.js';

export const INTERCITY = {
  MIN_KM: 15, // menos que esto es un viaje dentro de la ciudad
  MAX_KM: 700,
  MAX_DAYS: 14, // con cuántos días de anticipación se puede publicar
  MAX_PRICE: 20000,
  MAX_OPEN: 3, // viajes publicados o reservados a la vez por pasajero
  ASAP_HOURS: 3, // «lo antes posible»: si nadie lo toma en este tiempo, se cancela solo
  START_LEAD_MIN: 30, // minutos antes de la salida en que el viaje reservado se vuelve un viaje normal
  LATE_CANCEL_MIN: 60, // si a esta hora pasada de la salida no se pudo empezar, se cancela
  OVERLAP_HOURS: 3, // un conductor no puede tener dos viajes reservados con menos de esto entre las salidas
};

const on = async () => (await getSettings(pool)).intercity_enabled === '1';
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'Pasajero';
const isMoney = (n) => Number.isFinite(n) && n >= 1 && n <= INTERCITY.MAX_PRICE;
const when = (d) => new Date(d).toLocaleString('es-HN', { timeZone: 'America/Tegucigalpa', weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
const city = (t) => String(t || '').split(',')[0].trim() || 'tu destino';
// Precio sugerido: base + por km, redondeado de 5 en 5 y nunca menos que la mínima
export const intercityFare = (s, km) => Math.max(Number(s.intercity_minimum), Math.round((Number(s.intercity_base) + km * Number(s.intercity_km)) / 5) * 5);
// Más de 4 personas: carro amplio
const categoryFor = (seats) => (seats > 4 ? 'xl' : 'car');
// Hora que manda la app (ISO) → segundos desde ahora; se guarda contada desde el reloj de MySQL (como los viajes programados)
const secondsUntil = (iso) => Math.round((Date.parse(iso) - Date.now()) / 1000);
// «Mi ubicación» no le sirve al conductor: se busca el nombre del lugar (con tope de 2,5 s)
async function placeText(p, fallback) {
  const text = clean(p.text) || '';
  if (text && !/^mi ubicaci[oó]n$/i.test(text)) return text;
  const near = await Promise.race([reversePlace(p.lat, p.lng).catch(() => null), new Promise((r) => setTimeout(() => r(null), 2500))]);
  return near ? `Cerca de ${near}`.slice(0, 200) : fallback;
}
const tell = (...ids) => { for (const id of ids.filter(Boolean)) io.to(room(id)).emit('intercity:update'); };

const handle = (fn) => async (req, res, next) => {
  try { await fn(req, res); } catch (e) { next(e); }
};
const needOn = async (req, res, next) => ((await on()) ? next() : res.status(409).json({ error: 'Los viajes entre ciudades no están disponibles por ahora' }));

// ---------- Para las dos partes ----------
app.get('/api/intercity/info', authUser, handle(async (_req, res) => {
  const s = await getSettings(pool);
  res.json({ enabled: s.intercity_enabled === '1', maxDays: INTERCITY.MAX_DAYS, minKm: INTERCITY.MIN_KM });
}));

// ---------- Pasajero ----------
// Ruta y precio sugerido (los calcula el servidor)
app.post('/api/intercity/quote', authUser, passengerOnly, needOn, handle(async (req, res) => {
  const { origin, dest } = req.body || {};
  if (!isPoint(origin) || !isPoint(dest)) return res.status(400).json({ error: 'Elige el origen y el destino' });
  const straight = distanceKm(origin.lat, origin.lng, dest.lat, dest.lng);
  if (straight < INTERCITY.MIN_KM) return res.status(400).json({ error: `Para viajes de menos de ${INTERCITY.MIN_KM} km usa «En la ciudad»` });
  if (straight > INTERCITY.MAX_KM) return res.status(400).json({ error: 'El destino está demasiado lejos' });
  const route = await getRoute(origin, dest);
  res.json({ distanceKm: route.distanceKm, durationMin: route.durationMin, estimated: !!route.estimated, price: intercityFare(await getSettings(pool), route.distanceKm), coords: route.coords });
}));

app.post('/api/intercity', authUser, passengerOnly, needOn, handle(async (req, res) => {
  const u = req.user;
  const { origin, dest, departAt, seats: rawSeats, luggage, price: rawPrice, note: rawNote, womenOnly } = req.body || {};
  if (!isPoint(origin) || !isPoint(dest)) return res.status(400).json({ error: 'Elige el origen y el destino' });
  const straight = distanceKm(origin.lat, origin.lng, dest.lat, dest.lng);
  if (straight < INTERCITY.MIN_KM) return res.status(400).json({ error: `Para viajes de menos de ${INTERCITY.MIN_KM} km usa «En la ciudad»` });
  if (straight > INTERCITY.MAX_KM) return res.status(400).json({ error: 'El destino está demasiado lejos' });
  const seats = Number(rawSeats || 1);
  if (!Number.isInteger(seats) || seats < 1 || seats > 6) return res.status(400).json({ error: 'Pueden viajar de 1 a 6 personas' });
  let ahead = null; // segundos hasta la salida; null = lo antes posible
  if (departAt) {
    ahead = secondsUntil(departAt);
    if (!Number.isFinite(ahead) || ahead < 30 * 60 || ahead > INTERCITY.MAX_DAYS * 86400) return res.status(400).json({ error: `Elige una salida entre 30 minutos y ${INTERCITY.MAX_DAYS} días desde ahora` });
  }
  let women = 0;
  if (womenOnly) {
    if (u.gender !== 'f') return res.status(400).json({ error: '«Solo conductoras» es para pasajeras: indícalo en Mi cuenta' });
    women = 1;
  }
  const [[count]] = await pool.query("SELECT COUNT(*) AS n FROM rides WHERE passenger_id = ? AND kind = 'intercity' AND status IN ('board','booked')", [u.id]);
  if (count.n >= INTERCITY.MAX_OPEN) return res.status(409).json({ error: `Ya tienes ${INTERCITY.MAX_OPEN} viajes entre ciudades publicados o reservados` });
  const route = await getRoute(origin, dest);
  const price = rawPrice == null || rawPrice === '' ? intercityFare(await getSettings(pool), route.distanceKm) : money(rawPrice);
  if (!isMoney(price)) return res.status(400).json({ error: `El precio debe estar entre L 1 y L ${INTERCITY.MAX_PRICE}` });
  const [r] = await pool.query(
    `INSERT INTO rides (passenger_id, origin_lat, origin_lng, origin_text, dest_lat, dest_lng, dest_text, distance_km, duration_min, route_json,
                        offered_price, category, women_only, pickup_note, scheduled_for, status, kind, seats, luggage)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?, IF(? IS NULL, NULL, NOW() + INTERVAL ? SECOND), 'board', 'intercity', ?, ?)`,
    [u.id, origin.lat, origin.lng, await placeText(origin, 'Punto de salida'), dest.lat, dest.lng, await placeText(dest, 'Destino'), route.distanceKm, route.durationMin,
     JSON.stringify(route.coords), price, categoryFor(seats), women, clean(rawNote)?.slice(0, 160) || null, ahead, ahead ?? 0, seats, luggage ? 1 : 0]
  );
  // Aviso a los conductores aprobados que lo pueden tomar (con la app abierta les llega al instante; si no, notificación)
  notifyDrivers(r.insertId).catch(reportError);
  tell(u.id);
  res.json({ ok: true, id: r.insertId });
}));

async function offersFor(rideIds) {
  if (!rideIds.length) return new Map();
  const [rows] = await pool.query(
    `SELECT o.id, o.ride_id, o.price, o.depart_at, o.created_at, u.id AS driver_id, u.name, v.make, v.model, v.color, v.year, v.category
       FROM offers o JOIN users u ON u.id = o.driver_id LEFT JOIN vehicles v ON v.driver_id = u.id
      WHERE o.ride_id IN (?) AND o.status = 'pending' ORDER BY o.price, o.depart_at`, [rideIds]
  );
  const ratings = await ratingsOf([...new Set(rows.map((o) => o.driver_id))]);
  const map = new Map();
  for (const o of rows) {
    if (!map.has(o.ride_id)) map.set(o.ride_id, []);
    map.get(o.ride_id).push({
      id: o.id, price: Number(o.price), departAt: o.depart_at,
      driver: { id: o.driver_id, name: o.name, rating: ratings.get(o.driver_id) || { avg: null, count: 0 }, vehicle: [o.make, o.model, o.color, o.year].filter(Boolean).join(' ') || null },
    });
  }
  return map;
}

// Lo que ve el pasajero de cada viaje suyo
async function passengerView(rows) {
  const offers = await offersFor(rows.filter((r) => r.status === 'board').map((r) => r.id));
  const ids = rows.map((r) => r.driver_id).filter(Boolean);
  const [users] = ids.length ? await pool.query('SELECT id, name, vehicle, plate FROM users WHERE id IN (?)', [ids]) : [[]];
  const ratings = await ratingsOf(ids);
  const byId = Object.fromEntries(users.map((u) => [u.id, { ...u, rating: ratings.get(u.id) || { avg: null, count: 0 } }]));
  return rows.map((r) => ({
    id: r.id, status: r.status, origin: r.origin_text, dest: r.dest_text, departAt: r.scheduled_for, asap: !r.scheduled_for,
    seats: r.seats, luggage: !!r.luggage, price: Number(r.offered_price), finalPrice: r.final_price != null ? Number(r.final_price) : null,
    distanceKm: Number(r.distance_km), durationMin: Number(r.duration_min), note: r.pickup_note, womenOnly: !!r.women_only,
    offers: offers.get(r.id) || [], driver: r.driver_id ? byId[r.driver_id] : null, createdAt: r.created_at,
  }));
}

app.get('/api/intercity/mine', authUser, passengerOnly, handle(async (req, res) => {
  const [rows] = await pool.query(
    "SELECT * FROM rides WHERE passenger_id = ? AND kind = 'intercity' AND status IN ('board','booked') ORDER BY COALESCE(scheduled_for, created_at)", [req.user.id]
  );
  res.json({ trips: await passengerView(rows) });
}));

// El pasajero elige una oferta: el viaje queda reservado con ese conductor, a esa hora y a ese precio
app.post('/api/intercity/:id/accept', authUser, passengerOnly, handle(async (req, res) => {
  const rideId = Number(req.params.id);
  const result = await serial(`intercity:${rideId}`, async () => {
    const ride = await getRide(rideId);
    if (!ride || ride.passenger_id !== req.user.id || ride.kind !== 'intercity') return { status: 404, error: 'Viaje no encontrado' };
    if (ride.status !== 'board') return { status: 409, error: 'Este viaje ya no está buscando conductor' };
    const [[offer]] = await pool.query("SELECT *, TIMESTAMPDIFF(SECOND, NOW(), depart_at) AS ahead FROM offers WHERE id = ? AND ride_id = ? AND status = 'pending'", [Number(req.body?.offerId), rideId]);
    if (!offer) return { status: 409, error: 'Esa oferta ya no está disponible' };
    if (offer.ahead < -10 * 60) {
      await pool.query("UPDATE offers SET status = 'expired' WHERE id = ?", [offer.id]);
      return { status: 409, error: 'La hora de salida de esa oferta ya pasó' };
    }
    const [[drv]] = await pool.query('SELECT status FROM users WHERE id = ?', [offer.driver_id]);
    const gate = await walletGate(offer.driver_id);
    if (drv?.status !== 'active' || gate.blocked || (await overlapping(offer.driver_id, offer.depart_at, rideId))) {
      await pool.query("UPDATE offers SET status = 'rejected' WHERE id = ?", [offer.id]);
      return { status: 409, error: 'Ese conductor ya no puede tomar el viaje. Elige otra oferta.' };
    }
    const [[pref]] = await pool.query('SELECT ride_pin FROM users WHERE id = ?', [ride.passenger_id]);
    const wantsPin = (await getSettings(pool)).ride_pin_required === '1' || !!pref?.ride_pin || !!Number(ride.women_only);
    const pin = wantsPin ? String(crypto.randomInt(0, 10000)).padStart(4, '0') : null;
    const [u] = await pool.query(
      // Si sale en menos de un día, el recordatorio «un día antes» no hace falta (llegaría justo después de reservar)
      "UPDATE rides SET driver_id = ?, final_price = ?, scheduled_for = ?, status = 'booked', start_pin = ?, reminded = IF(? < 26 * 3600, 1, 0) WHERE id = ? AND status = 'board'",
      [offer.driver_id, offer.price, offer.depart_at, pin, offer.ahead, rideId]
    );
    if (u.affectedRows !== 1) return { status: 409, error: 'Este viaje ya no está buscando conductor' };
    await pool.query("UPDATE offers SET status = IF(id = ?, 'accepted', 'rejected') WHERE ride_id = ? AND status = 'pending'", [offer.id, rideId]);
    return { offer, ride };
  });
  if (result.error) return res.status(result.status).json({ error: result.error });
  const { offer, ride } = result;
  tell(req.user.id, offer.driver_id);
  push(offer.driver_id, { title: '¡Te reservaron un viaje entre ciudades!', body: `${firstName(req.user.name)} · ${city(ride.origin_text)} → ${city(ride.dest_text)} · ${when(offer.depart_at)} · L ${Math.round(offer.price)}`, tag: `intercity-${rideId}`, url: '/' }, { always: true });
  res.json({ ok: true });
}));

// Cancelar un viaje publicado o reservado
app.post('/api/intercity/:id/cancel', authUser, passengerOnly, handle(async (req, res) => {
  const ride = await getRide(Number(req.params.id));
  if (!ride || ride.passenger_id !== req.user.id || ride.kind !== 'intercity') return res.status(404).json({ error: 'Viaje no encontrado' });
  if (!(await cancelTrip(ride, 'passenger'))) return res.status(409).json({ error: 'Este viaje ya no se puede cancelar desde aquí' });
  res.json({ ok: true });
}));

// ---------- Conductor ----------
async function driverProfile(userId) {
  const [[v]] = await pool.query('SELECT category FROM vehicles WHERE driver_id = ?', [userId]);
  const [[g]] = await pool.query('SELECT gender, gender_verified FROM users WHERE id = ?', [userId]);
  return { category: v?.category || 'car', woman: g?.gender === 'f' && !!g.gender_verified };
}
// Qué viajes puede tomar: carro (hasta 4 personas) o carro amplio (cualquiera); los «Solo conductoras», solo conductoras confirmadas
const fits = (p, r) => p.category !== 'moto' && (p.category === 'xl' || r.category === 'car') && (!Number(r.women_only) || p.woman);

async function overlapping(driverId, departAt, exceptRideId = 0) {
  const [[o]] = await pool.query(
    `SELECT id FROM rides WHERE driver_id = ? AND kind = 'intercity' AND status IN ('booked','accepted','arrived','started') AND id <> ?
       AND ABS(TIMESTAMPDIFF(MINUTE, scheduled_for, ?)) < ? LIMIT 1`, [driverId, exceptRideId, departAt, INTERCITY.OVERLAP_HOURS * 60]
  );
  return !!o;
}

app.get('/api/intercity/board', authUser, driverOnly, needOn, handle(async (req, res) => {
  const me = await driverProfile(req.user.id);
  const [rows] = await pool.query(
    `SELECT r.*, u.name AS passenger_name FROM rides r JOIN users u ON u.id = r.passenger_id
      WHERE r.kind = 'intercity' AND r.status = 'board' AND r.passenger_id <> ?
      ORDER BY r.scheduled_for IS NOT NULL, r.scheduled_for, r.created_at LIMIT 100`, [req.user.id]
  );
  const list = rows.filter((r) => fits(me, r));
  const ratings = await ratingsOf([...new Set(list.map((r) => r.passenger_id))]);
  const [mine] = list.length ? await pool.query("SELECT ride_id, price, depart_at FROM offers WHERE driver_id = ? AND status = 'pending' AND ride_id IN (?)", [req.user.id, list.map((r) => r.id)]) : [[]];
  const myOffer = new Map(mine.map((o) => [o.ride_id, { price: Number(o.price), departAt: o.depart_at }]));
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  const here = Number.isFinite(lat) && Number.isFinite(lng);
  res.json({
    trips: list.map((r) => ({
      id: r.id, origin: r.origin_text, dest: r.dest_text, departAt: r.scheduled_for, asap: !r.scheduled_for,
      originPoint: { lat: r.origin_lat, lng: r.origin_lng }, destPoint: { lat: r.dest_lat, lng: r.dest_lng },
      seats: r.seats, luggage: !!r.luggage, price: Number(r.offered_price), distanceKm: Number(r.distance_km), durationMin: Number(r.duration_min),
      note: r.pickup_note, womenOnly: !!r.women_only, publishedAt: r.created_at,
      passenger: { name: firstName(r.passenger_name), rating: ratings.get(r.passenger_id) || { avg: null, count: 0 } },
      awayKm: here ? Math.round(distanceKm(lat, lng, r.origin_lat, r.origin_lng) * 10) / 10 : null,
      myOffer: myOffer.get(r.id) || null,
    })),
  });
}));

// Los viajes que el conductor tiene reservados
app.get('/api/intercity/booked', authUser, driverOnly, handle(async (req, res) => {
  const [rows] = await pool.query(
    `SELECT r.*, u.name AS passenger_name FROM rides r JOIN users u ON u.id = r.passenger_id
      WHERE r.driver_id = ? AND r.kind = 'intercity' AND r.status = 'booked' ORDER BY r.scheduled_for`, [req.user.id]
  );
  res.json({
    trips: rows.map((r) => ({
      id: r.id, origin: r.origin_text, dest: r.dest_text, departAt: r.scheduled_for, seats: r.seats, luggage: !!r.luggage,
      price: Number(r.final_price), distanceKm: Number(r.distance_km), durationMin: Number(r.duration_min), note: r.pickup_note,
      originPoint: { lat: r.origin_lat, lng: r.origin_lng }, passenger: { name: firstName(r.passenger_name) },
    })),
  });
}));

// Aceptar la tarifa (mismo precio) u ofrecer otra tarifa y otra hora
app.post('/api/intercity/:id/offer', authUser, driverOnly, needOn, handle(async (req, res) => {
  const u = req.user;
  if (u.status !== 'active') return res.status(403).json({ error: 'Tu cuenta debe estar aprobada para ofrecer viajes' });
  const ride = await getRide(Number(req.params.id));
  if (!ride || ride.kind !== 'intercity' || ride.status !== 'board') return res.status(409).json({ error: 'Este viaje ya no está buscando conductor' });
  if (ride.passenger_id === u.id) return res.status(400).json({ error: 'Es tu propio viaje' });
  if (!fits(await driverProfile(u.id), ride)) return res.status(403).json({ error: 'Tu vehículo no sirve para este viaje' });
  const gate = await walletGate(u.id);
  if (gate.blocked) return res.status(409).json({ error: `Necesitas al menos L ${gate.min} de saldo para tomar viajes. Recarga en «Mi saldo».` });
  const price = req.body?.price == null ? Number(ride.offered_price) : money(req.body.price);
  if (!isMoney(price)) return res.status(400).json({ error: `El precio debe estar entre L 1 y L ${INTERCITY.MAX_PRICE}` });
  // Hora de salida: la que pidió el pasajero, o la que propone el conductor
  let ahead;
  if (req.body?.departAt) ahead = secondsUntil(req.body.departAt);
  else ahead = ride.scheduled_for ? Math.round((new Date(ride.scheduled_for).getTime() - Date.now()) / 1000) : 30 * 60;
  if (!Number.isFinite(ahead) || ahead < 10 * 60 || ahead > INTERCITY.MAX_DAYS * 86400) return res.status(400).json({ error: 'La hora de salida debe ser al menos 10 minutos desde ahora' });
  const [[t]] = await pool.query('SELECT NOW() + INTERVAL ? SECOND AS at', [ahead]);
  if (await overlapping(u.id, t.at, ride.id)) return res.status(409).json({ error: `Ya tienes otro viaje reservado a menos de ${INTERCITY.OVERLAP_HOURS} horas de esa salida` });
  await serial(`offer:${u.id}:${ride.id}`, async () => {
    const [[prev]] = await pool.query("SELECT id FROM offers WHERE ride_id = ? AND driver_id = ? AND status = 'pending'", [ride.id, u.id]);
    if (prev) await pool.query('UPDATE offers SET price = ?, depart_at = ? WHERE id = ?', [price, t.at, prev.id]);
    else await pool.query('INSERT INTO offers (ride_id, driver_id, price, depart_at) VALUES (?,?,?,?)', [ride.id, u.id, price, t.at]);
  });
  tell(ride.passenger_id, u.id);
  push(ride.passenger_id, { title: 'Nueva oferta para tu viaje', body: `${firstName(u.name)} te lleva a ${city(ride.dest_text)} por L ${Math.round(price)} · sale ${when(t.at)}`, tag: `intercity-${ride.id}`, url: '/' });
  res.json({ ok: true });
}));

app.post('/api/intercity/:id/offer/withdraw', authUser, driverOnly, handle(async (req, res) => {
  const rideId = Number(req.params.id);
  const [r] = await pool.query("UPDATE offers SET status = 'rejected' WHERE ride_id = ? AND driver_id = ? AND status = 'pending'", [rideId, req.user.id]);
  const ride = await getRide(rideId);
  if (r.affectedRows && ride) tell(ride.passenger_id, req.user.id);
  res.json({ ok: true });
}));

// El conductor ya no puede: el viaje vuelve a publicarse (con la misma hora) y se le avisa al pasajero
app.post('/api/intercity/:id/release', authUser, driverOnly, handle(async (req, res) => {
  const ride = await getRide(Number(req.params.id));
  if (!ride || ride.driver_id !== req.user.id || ride.kind !== 'intercity') return res.status(404).json({ error: 'Viaje no encontrado' });
  const [u] = await pool.query("UPDATE rides SET status = 'board', driver_id = NULL, final_price = NULL, start_pin = NULL, reminded = 0 WHERE id = ? AND status = 'booked' AND driver_id = ?", [ride.id, req.user.id]);
  if (u.affectedRows !== 1) return res.status(409).json({ error: 'Este viaje ya no se puede soltar desde aquí' });
  tell(ride.passenger_id, req.user.id);
  push(ride.passenger_id, { title: 'Tu conductor canceló el viaje', body: `Tu viaje a ${city(ride.dest_text)} volvió a publicarse para que otro conductor lo tome.`, tag: `intercity-${ride.id}`, url: '/' }, { always: true });
  notifyDrivers(ride.id, req.user.id).catch(reportError);
  res.json({ ok: true });
}));

// ---------- Avisos y reglas que corren solas ----------
// Nuevo viaje publicado: aviso a los conductores aprobados que lo pueden tomar (los que están en línea primero, sin repetir)
async function notifyDrivers(rideId, skipId = 0) {
  const ride = await getRide(rideId);
  if (!ride || ride.status !== 'board') return;
  const body = `${city(ride.origin_text)} → ${city(ride.dest_text)} · ${ride.scheduled_for ? when(ride.scheduled_for) : 'lo antes posible'} · L ${Math.round(ride.offered_price)}`;
  const seen = new Set([ride.passenger_id, skipId]);
  for (const d of drivers.values()) {
    if (seen.has(d.id) || !fits({ category: d.category || 'car', woman: d.woman }, ride)) continue;
    seen.add(d.id);
    io.to(room(d.id)).emit('intercity:new', { id: ride.id });
    push(d.id, { bell: false, title: 'Nuevo viaje entre ciudades', body, tag: `intercity-${ride.id}`, url: '/' });
  }
}

// Cancela un viaje publicado o reservado (by: passenger | system | admin) y avisa a quien corresponda
export async function cancelTrip(ride, by) {
  const [u] = await pool.query("UPDATE rides SET status = 'cancelled', cancelled_by = ? WHERE id = ? AND status IN ('board','booked')", [by, ride.id]);
  if (u.affectedRows !== 1) return false;
  await pool.query("UPDATE offers SET status = 'rejected' WHERE ride_id = ? AND status = 'pending'", [ride.id]);
  tell(ride.passenger_id, ride.driver_id);
  const where = `${city(ride.origin_text)} → ${city(ride.dest_text)}`;
  if (ride.driver_id && ride.status === 'booked') push(ride.driver_id, { title: 'Se canceló un viaje reservado', body: `${where} · ${when(ride.scheduled_for)}`, tag: `intercity-${ride.id}`, url: '/' }, { always: true });
  if (by !== 'passenger') push(ride.passenger_id, { title: 'Se canceló tu viaje entre ciudades', body: by === 'system' ? `${where}: ningún conductor lo tomó a tiempo.` : `${where}.`, tag: `intercity-${ride.id}`, url: '/' }, { always: true });
  return true;
}

// Cada 30 s: vencimientos, avisos de un día y una hora antes, y el paso a viaje normal un rato antes de la salida
export async function intercitySweep() {
  // Publicados que nadie tomó: con hora, pasada la salida; «lo antes posible», a las ASAP_HOURS horas
  const [stale] = await pool.query(
    `SELECT * FROM rides WHERE kind = 'intercity' AND status = 'board'
       AND ((scheduled_for IS NOT NULL AND scheduled_for < NOW()) OR (scheduled_for IS NULL AND created_at < NOW() - INTERVAL ? HOUR))`, [INTERCITY.ASAP_HOURS]
  );
  for (const r of stale) await cancelTrip(r, 'system');

  const [booked] = await pool.query(
    "SELECT *, TIMESTAMPDIFF(SECOND, NOW(), scheduled_for) AS ahead FROM rides WHERE kind = 'intercity' AND status = 'booked' AND scheduled_for < NOW() + INTERVAL 1 DAY"
  );
  for (const r of booked) {
    const where = `${city(r.origin_text)} → ${city(r.dest_text)}`;
    const [users] = await pool.query('SELECT id, name FROM users WHERE id IN (?)', [[r.passenger_id, r.driver_id]]);
    const name = Object.fromEntries(users.map((x) => [x.id, firstName(x.name)]));
    // Desde un día antes (si se reservó con más de 2 horas de anticipación)
    if (!(r.reminded & 1) && r.ahead > 2 * 3600) {
      await pool.query('UPDATE rides SET reminded = reminded | 1 WHERE id = ?', [r.id]);
      push(r.passenger_id, { title: 'Recordatorio de tu viaje', body: `${where} · ${when(r.scheduled_for)} con ${name[r.driver_id]}`, tag: `intercity-${r.id}`, url: '/' }, { always: true });
      push(r.driver_id, { title: 'Recordatorio: tienes un viaje reservado', body: `${where} · ${when(r.scheduled_for)} · recoges a ${name[r.passenger_id]}`, tag: `intercity-${r.id}`, url: '/' }, { always: true });
    }
    // Una hora antes
    if (!(r.reminded & 2) && r.ahead <= 3600 && r.ahead > INTERCITY.START_LEAD_MIN * 60) {
      await pool.query('UPDATE rides SET reminded = reminded | 3 WHERE id = ?', [r.id]);
      push(r.passenger_id, { title: 'Tu viaje sale en 1 hora', body: `${where} con ${name[r.driver_id]}. Ten tus cosas listas.`, tag: `intercity-${r.id}`, url: '/' }, { always: true });
      push(r.driver_id, { title: 'Tu viaje sale en 1 hora', body: `${where} · recoges a ${name[r.passenger_id]} en ${r.origin_text}`, tag: `intercity-${r.id}`, url: '/' }, { always: true });
    }
    if (r.ahead > INTERCITY.START_LEAD_MIN * 60) continue;
    // Ya es hora: pasa a ser un viaje normal (aceptado). Si alguno sigue en otro viaje, se espera; muy pasada la hora, se cancela.
    const busy = (await activeRideFor({ id: r.driver_id, role: 'driver' })) || (await activeRideFor({ id: r.passenger_id, role: 'passenger' }));
    if (busy) {
      if (r.ahead < -INTERCITY.LATE_CANCEL_MIN * 60) await cancelTrip(r, 'system');
      continue;
    }
    const [u] = await pool.query("UPDATE rides SET status = 'accepted' WHERE id = ? AND status = 'booked'", [r.id]);
    if (u.affectedRows !== 1) continue;
    const d = drivers.get(r.driver_id);
    if (d) d.available = false; // mientras dure este viaje no recibe otros
    const view = await rideView(await getRide(r.id));
    io.to(room(r.passenger_id)).to(room(r.driver_id)).emit('ride:state', view);
    tell(r.passenger_id, r.driver_id);
    push(r.driver_id, { title: 'Es hora de tu viaje entre ciudades', body: `Ve a recoger a ${name[r.passenger_id]} en ${r.origin_text}`, tag: `ride-${r.id}`, url: '/' }, { always: true });
    push(r.passenger_id, { title: 'Tu conductor va en camino', body: `${name[r.driver_id]} pasa por ti para ir a ${city(r.dest_text)}`, tag: `ride-${r.id}`, url: '/' }, { always: true });
  }
}
