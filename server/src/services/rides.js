// Reglas del viaje: vista para las pantallas, conductores cercanos, tiempo de llegada, vencimientos y cancelaciones
import { pool } from '../db.js';
import { distanceKm } from '../geo.js';
import { getRoute } from '../maps.js';
import { NEARBY_KM, ETA_EVERY_MS, SHOW_PARTNER_PHONES, REQUEST_TTL_MIN } from '../config.js';
import { io } from '../app.js';
import { drivers, passengers, openRides, declined, room } from '../live.js';
import { push } from '../notify.js';

export async function getRide(id) {
  const [rows] = await pool.query('SELECT * FROM rides WHERE id = ?', [id]);
  return rows[0];
}

export async function activeRideFor(user) {
  const col = user.role === 'driver' ? 'driver_id' : 'passenger_id';
  const [rows] = await pool.query(
    `SELECT * FROM rides WHERE ${col} = ? AND status IN ('requested','accepted','arrived','started') ORDER BY id DESC LIMIT 1`,
    [user.id]
  );
  return rows[0];
}

// Promedio y cantidad de calificaciones recibidas: Map(userId -> { avg, count })
export async function ratingsOf(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const [rows] = await pool.query('SELECT ratee_id, AVG(stars) AS avg, COUNT(*) AS n FROM ratings WHERE ratee_id IN (?) GROUP BY ratee_id', [ids]);
  for (const r of rows) map.set(r.ratee_id, { avg: Math.round(Number(r.avg) * 10) / 10, count: r.n });
  return map;
}

export async function rideView(ride) {
  const ids = [ride.passenger_id, ride.driver_id].filter(Boolean);
  // El teléfono de la otra persona NO se entrega (se coordina por el chat). SHOW_PARTNER_PHONES=true lo vuelve a mostrar.
  const [users] = await pool.query(`SELECT id,name,vehicle,plate${SHOW_PARTNER_PHONES ? ',phone' : ''} FROM users WHERE id IN (?)`, [ids]);
  const ratings = await ratingsOf(ids);
  const byId = Object.fromEntries(users.map((u) => [u.id, { ...u, rating: ratings.get(u.id) || { avg: null, count: 0 } }]));
  const { route_json, share_token, ...rest } = ride;
  return {
    ...rest,
    route: route_json ? JSON.parse(route_json) : null,
    passenger: byId[ride.passenger_id] || null,
    driver: ride.driver_id ? byId[ride.driver_id] : null,
  };
}

// Solo se mandan los más cercanos: con cientos de conductores, enviar la lista completa a cada pasajero cada 3 s satura el servidor
// y en un teléfono no se distinguen más. El cliente muestra "25+" cuando llega al tope.
const MAX_NEARBY = 25;
export function nearbyDrivers(lat, lng) {
  const near = [];
  for (const d of drivers.values()) {
    if (!d.available || d.disconnected || d.lat == null) continue; // los que solo se alcanzan por notificación no se muestran en el mapa
    const km = distanceKm(lat, lng, d.lat, d.lng);
    if (km <= NEARBY_KM) near.push({ km, d });
  }
  return near
    .sort((a, b) => a.km - b.km)
    .slice(0, MAX_NEARBY)
    .map(({ d }) => ({ id: d.id, name: d.name, vehicle: d.vehicle, category: d.category || 'car', lat: d.lat, lng: d.lng }));
}

export function openRidesNear(lat, lng, driverId, category = 'car') {
  return [...openRides.values()].filter((r) => (r.category || 'car') === category && distanceKm(lat, lng, r.origin_lat, r.origin_lng) <= NEARBY_KM && !declined.get(r.id)?.has(driverId));
}

export function closeOpenRide(rideId) {
  openRides.delete(rideId);
  declined.delete(rideId);
  io.to('drivers').emit('ride:closed', { rideId });
}

// El conductor termina un viaje: vuelve a estar libre, o se quita del mapa si ya se desconectó
export function releaseDriver(driverId) {
  const d = drivers.get(driverId);
  if (!d) return;
  if (d.disconnected) drivers.delete(driverId);
  else d.available = true;
}

// Tiempo estimado de llegada: del conductor al pasajero (viaje aceptado) o al destino (viaje en curso).
// Se recalcula como máximo cada ETA_EVERY_MS por viaje para no saturar el servicio de rutas.
const etaAt = new Map(); // "viaje:fase" -> última vez
export async function sendEta(ride, from) {
  const phase = ride.status === 'accepted' ? 'pickup' : ride.status === 'started' ? 'dropoff' : null;
  if (!phase) return;
  const key = `${ride.id}:${phase}`;
  if (Date.now() - (etaAt.get(key) || 0) < ETA_EVERY_MS) return;
  etaAt.set(key, Date.now());
  if (etaAt.size > 500) etaAt.delete(etaAt.keys().next().value);
  const to = phase === 'pickup' ? { lat: ride.origin_lat, lng: ride.origin_lng } : { lat: ride.dest_lat, lng: ride.dest_lng };
  const route = await getRoute(from, to);
  const eta = { rideId: ride.id, phase, minutes: Math.max(1, Math.ceil(route.durationMin)), km: Math.round(route.distanceKm * 10) / 10, estimated: route.estimated };
  io.to(room(ride.passenger_id)).emit('ride:eta', eta);
  io.to(room(ride.driver_id)).emit('ride:eta', { ...eta, coords: route.coords }); // el conductor además recibe el camino para verlo en el mapa
}

// Las ofertas que vencen se avisan a las dos partes (y quedan como "vencidas")
export async function expireOffers() {
  const [rows] = await pool.query(
    `SELECT o.id, o.ride_id, o.driver_id, r.passenger_id FROM offers o JOIN rides r ON r.id = o.ride_id
     WHERE o.status = 'pending' AND o.expires_at < NOW()`
  );
  for (const o of rows) {
    await pool.query("UPDATE offers SET status = 'expired' WHERE id = ? AND status = 'pending'", [o.id]);
    io.to(room(o.passenger_id)).to(room(o.driver_id)).emit('offer:expired', { offerId: o.id, rideId: o.ride_id });
  }
}

// Cancela un viaje activo (by: passenger | driver | admin | system) y avisa a las dos partes
// `from`: estados desde los que esta persona puede cancelar. La condición va en el UPDATE para que una cancelación
// que llega a la vez que el conductor inicia (o completa) el viaje no lo deje cancelado ya empezado.
export async function cancelRide(rideId, by, from = ['requested', 'accepted', 'arrived', 'started']) {
  const ride = await getRide(rideId);
  if (!ride || !from.includes(ride.status)) return null;
  const [r] = await pool.query('UPDATE rides SET status = "cancelled", cancelled_by = ? WHERE id = ? AND status IN (?)', [by, rideId, from]);
  if (r.affectedRows !== 1) return null;
  closeOpenRide(rideId);
  if (ride.driver_id) releaseDriver(ride.driver_id);
  const view = await rideView(await getRide(rideId));
  io.to(room(ride.passenger_id)).to(room(ride.driver_id || 0)).emit('ride:state', view);
  const cancelled = { title: 'Viaje cancelado', body: by === 'system' ? 'Nadie tomó tu solicitud a tiempo.' : 'El viaje fue cancelado.', tag: `ride-${rideId}`, url: '/' };
  if (by !== 'passenger') push(ride.passenger_id, cancelled);
  if (by !== 'driver' && ride.driver_id) push(ride.driver_id, cancelled);
  return view;
}

// Saca a un usuario bloqueado: cancela sus viajes, lo quita del mapa y cierra sus conexiones
export async function kickUser(userId) {
  const [rows] = await pool.query(
    "SELECT id FROM rides WHERE (passenger_id = ? OR driver_id = ?) AND status IN ('requested','accepted','arrived','started')",
    [userId, userId]
  );
  for (const r of rows) await cancelRide(r.id, 'admin');
  drivers.delete(userId);
  passengers.delete(userId);
  io.in(room(userId)).disconnectSockets(true);
}

// Viajes sin conductor tras REQUEST_TTL_MIN minutos se cancelan solos
export async function expireStaleRides() {
  const [stale] = await pool.query(
    `SELECT id, passenger_id FROM rides WHERE status = 'requested' AND created_at < NOW() - INTERVAL ? MINUTE`,
    [REQUEST_TTL_MIN]
  );
  for (const r of stale) await cancelRide(r.id, 'system', ['requested']);
}
