// Horas conectado de los conductores y camino real de los viajes en curso
import { pool } from '../db.js';
import { distanceKm } from '../geo.js';
import { drivers } from '../live.js';

// ---------- Horas conectado ----------
// Una sesión va de que el conductor se pone disponible (con la app abierta) a que se desconecta.
// Cada minuto se anota que sigue ahí (last_seen_at); si el servidor se reinicia, la sesión se cierra en esa última vez.
export async function openSession(driverId) {
  await pool.query(
    'INSERT INTO driver_sessions (driver_id) SELECT ? FROM DUAL WHERE NOT EXISTS (SELECT 1 FROM driver_sessions WHERE driver_id = ? AND ended_at IS NULL)',
    [driverId, driverId]
  );
}

export async function closeSession(driverId) {
  await pool.query('UPDATE driver_sessions SET ended_at = NOW(), last_seen_at = NOW() WHERE driver_id = ? AND ended_at IS NULL', [driverId]);
}

// Conductores con la app abierta: su sesión sigue; los demás (se fueron, se quedaron sin saldo, empezó un alquiler…) se cierran
export async function reconcileSessions() {
  const live = [...drivers.values()].filter((d) => !d.disconnected).map((d) => d.id);
  if (live.length) await pool.query('UPDATE driver_sessions SET last_seen_at = NOW() WHERE ended_at IS NULL AND driver_id IN (?)', [live]);
  await pool.query(`UPDATE driver_sessions SET ended_at = last_seen_at WHERE ended_at IS NULL${live.length ? ' AND driver_id NOT IN (?)' : ''}`, live.length ? [live] : []);
}

// ---------- Recorrido real ----------
// Solo con el viaje en curso. Un punto cada 15 s como mínimo (antes si el carro avanzó más de 150 m).
const TRACK_EVERY_MS = 15000;
const lastPoint = new Map(); // rideId -> { at, lat, lng }

export async function recordPoint(rideId, { lat, lng }) {
  const prev = lastPoint.get(rideId);
  const now = Date.now();
  if (prev && now - prev.at < TRACK_EVERY_MS && distanceKm(prev.lat, prev.lng, lat, lng) < 0.15) return;
  if (prev && now - prev.at < 3000) return; // nunca más de un punto cada 3 s
  lastPoint.set(rideId, { at: now, lat, lng });
  if (lastPoint.size > 2000) lastPoint.delete(lastPoint.keys().next().value);
  await pool.query('INSERT INTO ride_points (ride_id, lat, lng) VALUES (?,?,?)', [rideId, lat, lng]);
}

export const forgetTrack = (rideId) => lastPoint.delete(rideId);

export async function trackOf(rideId) {
  const [rows] = await pool.query('SELECT lat, lng FROM ride_points WHERE ride_id = ? ORDER BY id', [rideId]);
  return rows.map((p) => [p.lat, p.lng]);
}

export function trackKm(points) {
  let km = 0;
  for (let i = 1; i < points.length; i++) km += distanceKm(points[i - 1][0], points[i - 1][1], points[i][0], points[i][1]);
  return Math.round(km * 10) / 10;
}

// Los recorridos se borran a los RIDE_TRACK_RETENTION_DAYS días (90 por defecto)
export async function purgeTracks(days) {
  const [r] = await pool.query('DELETE FROM ride_points WHERE at < NOW() - INTERVAL ? DAY', [days]);
  return r.affectedRows;
}
