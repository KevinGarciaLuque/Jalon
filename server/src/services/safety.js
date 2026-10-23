// Etapa 9.2: durante el viaje se vigila que el carro siga la ruta y no se quede detenido mucho tiempo.
// Si pasa algo raro, al pasajero le sale «¿Todo bien?»; si pide ayuda, o no responde a tiempo, se crea una alerta
// como la del botón de emergencia (el personal la ve en el panel y, si hay Twilio, les llega por SMS).
import { pool } from '../db.js';
import { distanceKm } from '../geo.js';
import { getSettings } from '../wallet.js';
import { io } from '../app.js';
import { room } from '../live.js';
import { push, pushStaff } from '../notify.js';
import { notifySos } from './sos.js';
import { reportError } from '../config.js';

const num = (v, d) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : d);
export const SAFETY = {
  offRouteM: num(process.env.SAFETY_OFF_ROUTE_M, 400), // a cuántos metros de la ruta ya es «desvío»
  offRouteSec: num(process.env.SAFETY_OFF_SEC, 90), // durante cuánto tiempo
  stopM: num(process.env.SAFETY_STOP_M, 30), // menos que esto es «no se movió» (el GPS tiembla)
  stopSec: num(process.env.SAFETY_STOP_SEC, 300), // detenido más de esto, lejos del destino
  nearDestM: num(process.env.SAFETY_NEAR_DEST_M, 300), // cerca del destino es normal detenerse
  answerSec: num(process.env.SAFETY_ANSWER_SEC, 120), // tiempo para responder «¿Todo bien?» antes de avisar al personal
  cooldownSec: num(process.env.SAFETY_COOLDOWN_SEC, 600), // después de un «todo bien», no se vuelve a preguntar enseguida
};
export const KIND_TEXT = { deviation: 'el carro se desvió de la ruta', stopped: 'el carro lleva varios minutos detenido' };

const meters = (a, b) => distanceKm(a.lat, a.lng, b.lat, b.lng) * 1000;
// Distancia (m) de un punto a la ruta: al segmento más cercano, en un plano local (suficiente para unos kilómetros)
export function distanceToRoute(p, route) {
  if (!route?.length) return 0;
  const k = Math.cos((p.lat * Math.PI) / 180);
  const xy = ([lat, lng]) => [(lng - p.lng) * 111320 * k, (lat - p.lat) * 110540];
  let best = Infinity;
  for (let i = 0; i < route.length; i++) {
    const [ax, ay] = xy(route[i]);
    const [bx, by] = i + 1 < route.length ? xy(route[i + 1]) : [ax, ay];
    const dx = bx - ax, dy = by - ay;
    const t = dx || dy ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy))) : 0;
    best = Math.min(best, Math.hypot(ax + t * dx, ay + t * dy));
  }
  return best;
}

const watch = new Map(); // rideId → { route, offSince, anchor, openEvent, quietUntil }
export const forgetSafety = (rideId) => watch.delete(rideId);

async function raise(ride, kind, pos, w) {
  const [r] = await pool.query('INSERT INTO ride_safety_events (ride_id, kind, lat, lng) VALUES (?,?,?,?)', [ride.id, kind, pos.lat, pos.lng]);
  w.openEvent = r.insertId;
  io.to(room(ride.passenger_id)).emit('safety:check', { eventId: r.insertId, rideId: ride.id, kind });
  push(ride.passenger_id, { title: '¿Todo bien en tu viaje?', body: `Notamos que ${KIND_TEXT[kind]}. Abre la app y dinos si estás bien.`, tag: `ride-${ride.id}`, url: '/', requireInteraction: true }, { always: true });
}

// Cada posición del conductor con el viaje en curso
export async function checkSafety(ride, pos) {
  if ((await getSettings(pool)).ride_safety_checks === '0') return;
  const now = Date.now();
  let w = watch.get(ride.id);
  if (!w) {
    let route = null;
    try { route = ride.route_json ? JSON.parse(ride.route_json) : null; } catch { route = null; }
    w = { route, offSince: null, anchor: { ...pos, t: now }, openEvent: null, quietUntil: 0 };
    watch.set(ride.id, w);
  }
  if (w.openEvent || now < w.quietUntil) return;
  // Desvío: lejos de la ruta durante un rato
  if (w.route?.length > 1 && distanceToRoute(pos, w.route) > SAFETY.offRouteM) {
    w.offSince ??= now;
    if (now - w.offSince >= SAFETY.offRouteSec * 1000) return raise(ride, 'deviation', pos, w);
  } else w.offSince = null;
  // Detenido: casi sin moverse durante varios minutos, lejos del destino
  if (meters(w.anchor, pos) > SAFETY.stopM) w.anchor = { ...pos, t: now };
  else if (now - w.anchor.t >= SAFETY.stopSec * 1000 && meters(pos, { lat: ride.dest_lat, lng: ride.dest_lng }) > SAFETY.nearDestM) {
    w.anchor = { ...pos, t: now };
    return raise(ride, 'stopped', pos, w);
  }
}

// Una alerta como la del botón de emergencia, con el motivo
async function alertStaff(ride, userId, pos, reason) {
  const [a] = await pool.query('INSERT INTO alerts (ride_id, user_id, lat, lng, reason) VALUES (?,?,?,?,?)', [ride.id, userId, pos?.lat ?? null, pos?.lng ?? null, reason.slice(0, 120)]);
  notifySos(a.insertId, false).catch(reportError);
  pushStaff({ title: '🆘 Alerta en un viaje', body: `Viaje ${ride.id}: ${reason}`, tag: `sos-${a.insertId}`, url: '/', requireInteraction: true }, 'alerts');
  return a.insertId;
}

// El pasajero responde «Sí, todo bien» o «Pedir ayuda»
export async function answerSafety(user, eventId, answer) {
  if (!['ok', 'help'].includes(answer)) return { error: 'Respuesta inválida' };
  const [[e]] = await pool.query('SELECT e.*, r.passenger_id, r.status, r.id AS rid FROM ride_safety_events e JOIN rides r ON r.id = e.ride_id WHERE e.id = ?', [Number(eventId) || 0]);
  if (!e || e.passenger_id !== user.id) return { error: 'Aviso no encontrado' };
  const [u] = await pool.query('UPDATE ride_safety_events SET answer = ? WHERE id = ? AND answer IS NULL', [answer, e.id]);
  if (!u.affectedRows) return { ok: true }; // ya respondido (p. ej. desde otro aparato)
  const w = watch.get(e.ride_id);
  if (w) { w.openEvent = null; w.offSince = null; w.quietUntil = Date.now() + SAFETY.cooldownSec * 1000; }
  io.to(room(user.id)).emit('safety:closed', { eventId: e.id, answer });
  if (answer === 'help') {
    const [[ride]] = await pool.query('SELECT * FROM rides WHERE id = ?', [e.ride_id]);
    await alertStaff(ride, user.id, e, `El pasajero pidió ayuda: ${KIND_TEXT[e.kind]}`);
  }
  return { ok: true };
}

// Sin respuesta a tiempo: se avisa al personal (lo corre jobs.js)
export async function escalateSafety() {
  const [rows] = await pool.query(
    `SELECT e.*, r.passenger_id FROM ride_safety_events e JOIN rides r ON r.id = e.ride_id
     WHERE e.answer IS NULL AND e.escalated_at IS NULL AND r.status = 'started' AND e.created_at <= NOW() - INTERVAL ? SECOND`, [SAFETY.answerSec]
  );
  for (const e of rows) {
    const [claim] = await pool.query('UPDATE ride_safety_events SET escalated_at = NOW() WHERE id = ? AND escalated_at IS NULL', [e.id]);
    if (!claim.affectedRows) continue;
    const [[ride]] = await pool.query('SELECT * FROM rides WHERE id = ?', [e.ride_id]);
    await alertStaff(ride, e.passenger_id, e, `Alerta automática: ${KIND_TEXT[e.kind]} y el pasajero no respondió`);
    io.to(room(e.passenger_id)).emit('safety:closed', { eventId: e.id, escalated: true });
    push(e.passenger_id, { title: 'Avisamos al equipo de Ktracho GO', body: 'Como no respondiste, el equipo ya sabe dónde está tu viaje. Si estás en peligro, llama al 911.', tag: `ride-${e.ride_id}`, url: '/' }, { always: true });
    const w = watch.get(e.ride_id);
    if (w) { w.openEvent = null; w.quietUntil = Date.now() + SAFETY.cooldownSec * 1000; }
  }
  return rows.length;
}

// El aviso pendiente del viaje (para mostrarlo otra vez si el pasajero recarga la app)
export async function openSafetyCheck(rideId) {
  const [[e]] = await pool.query('SELECT id, kind FROM ride_safety_events WHERE ride_id = ? AND answer IS NULL AND escalated_at IS NULL ORDER BY id DESC LIMIT 1', [rideId]);
  return e ? { eventId: e.id, kind: e.kind } : null;
}
