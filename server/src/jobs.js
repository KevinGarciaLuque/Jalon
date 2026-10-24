// Tareas que corren solas cada cierto tiempo, y la recuperación de las solicitudes abiertas al arrancar
import { pool } from './db.js';
import { purgeNotifications } from './notify.js';
import { purgeOldMessages } from './chat.js';
import { reportError, CHAT_RETENTION_DAYS, REQUEST_TTL_MIN, SCHEDULE_LEAD_MIN } from './config.js';
import { push } from './notify.js';
import { io } from './app.js';
import { drivers, passengers, openRides, room } from './live.js';
import { rideView, nearbyDrivers, expireOffers, expireStaleRides, announceRide, activeRideFor, getRide } from './services/rides.js';
import { remindOpenAlerts } from './services/sos.js';
import { expireRentals } from './services/rentals.js';
import { reconcileSessions, purgeTracks } from './services/activity.js';
import { expireRequests } from './routes/recharges.js';
import { escalateSafety } from './services/safety.js';
import { purgeSelfies } from './routes/selfies.js';

// Las ofertas vencidas se revisan cada OFFER_SWEEP_MS (5 s por defecto)
setInterval(() => expireOffers().catch(reportError), Number(process.env.OFFER_SWEEP_MS || 5000)).unref();

// Los mensajes del chat no se guardan para siempre (CHAT_RETENTION_DAYS, 90 por defecto)
const purgeChat = () => purgeOldMessages(pool, CHAT_RETENTION_DAYS).then((n) => n && console.log(`Se borraron ${n} mensajes antiguos del chat`)).catch(reportError);
purgeChat();
setInterval(purgeChat, 6 * 3600 * 1000).unref();
// Las notificaciones de la campanita se borran a los 30 días
const purgeBell = () => purgeNotifications().then((n) => n && console.log(`Se borraron ${n} notificaciones antiguas`)).catch(reportError);
purgeBell();
setInterval(purgeBell, 6 * 3600 * 1000).unref();

// Un conductor que cerró la app solo se conserva 30 minutos (después su ubicación ya no es confiable)
setInterval(() => {
  for (const [id, d] of drivers) if (d.disconnected && d.available && Date.now() - (d.lastSeen || 0) > 30 * 60 * 1000) drivers.delete(id);
}, 60000).unref();

// Cada 3 s se envían a cada pasajero los conductores libres cercanos
setInterval(() => {
  for (const p of passengers.values()) {
    io.to(room(p.id)).emit('drivers:nearby', nearbyDrivers(p.lat, p.lng));
  }
}, 3000);

setInterval(() => remindOpenAlerts().catch(console.error), 30000);

setInterval(() => expireStaleRides().catch(console.error), 30000);

// Viajes programados: un rato antes de la hora salen a buscar conductor como un pedido normal.
// Si a 5 minutos de la hora nadie lo tomó, se le avisa al pasajero para que suba su oferta.
const warnedScheduled = new Set();
export async function releaseScheduled() {
  const [due] = await pool.query("SELECT * FROM rides WHERE status = 'scheduled' AND scheduled_for <= NOW() + INTERVAL ? MINUTE", [SCHEDULE_LEAD_MIN]);
  for (const r of due) {
    // Si en ese momento tiene otro viaje en curso, se espera; pasada la hora por 10 minutos, se cancela
    if (await activeRideFor({ id: r.passenger_id, role: 'passenger' })) {
      if (new Date(r.scheduled_for).getTime() < Date.now() - 10 * 60000) {
        await pool.query("UPDATE rides SET status = 'cancelled', cancelled_by = 'system' WHERE id = ? AND status = 'scheduled'", [r.id]);
        push(r.passenger_id, { title: 'Se canceló tu viaje programado', body: 'Tenías otro viaje en curso a esa hora.', tag: `ride-${r.id}`, url: '/' }, { always: true });
      }
      continue;
    }
    const [u] = await pool.query("UPDATE rides SET status = 'requested', created_at = NOW() WHERE id = ? AND status = 'scheduled'", [r.id]);
    if (!u.affectedRows) continue;
    const view = await rideView(await getRide(r.id));
    announceRide(view);
    io.to(room(r.passenger_id)).emit('ride:state', view);
    push(r.passenger_id, { title: 'Buscando conductor para tu viaje programado', body: `${r.dest_text ? `A ${r.dest_text}` : 'Tu viaje'} · ya les avisamos a los conductores cercanos`, tag: `ride-${r.id}`, url: '/' }, { always: true });
  }
  const [late] = await pool.query("SELECT id, passenger_id FROM rides WHERE status = 'requested' AND scheduled_for IS NOT NULL AND scheduled_for <= NOW() + INTERVAL 5 MINUTE");
  for (const r of late) {
    if (warnedScheduled.has(r.id)) continue;
    warnedScheduled.add(r.id);
    push(r.passenger_id, { title: 'Nadie ha tomado tu viaje programado', body: 'Sube tu oferta para que un conductor lo acepte, o cancélalo si ya no lo necesitas.', tag: `ride-${r.id}`, url: '/' }, { always: true });
  }
}
setInterval(() => releaseScheduled().catch(reportError), Number(process.env.SCHEDULE_SWEEP_MS || 30000)).unref();

// Al reiniciar (p. ej. en cada despliegue) las solicitudes que siguen buscando conductor se vuelven a cargar en memoria:
// los conductores las reciben al reconectarse y el vencimiento normal (REQUEST_TTL_MIN) cancela las que ya eran viejas.
// Las ofertas pendientes de antes del reinicio no se pueden aceptar (el conductor aún no se reconectó) y la pantalla las quita.
{
  const [pending] = await pool.query("SELECT * FROM rides WHERE status = 'requested' AND (created_at > NOW() - INTERVAL ? MINUTE OR scheduled_for > NOW() - INTERVAL ? MINUTE)", [REQUEST_TTL_MIN, REQUEST_TTL_MIN]);
  for (const r of pending) openRides.set(r.id, await rideView(r));
  if (pending.length) console.log(`Se recuperaron ${pending.length} solicitud(es) abiertas tras el reinicio`);
  await expireStaleRides();
}

// Horas conectado: cada minuto se anota quién sigue con la app abierta y se cierran las sesiones de quienes ya no están.
// Al arrancar no hay nadie conectado todavía: las sesiones abiertas antes del reinicio se cierran en su última vez vista.
reconcileSessions().catch(reportError);
setInterval(() => reconcileSessions().catch(reportError), 60000).unref();

// El camino real de los viajes se borra a los RIDE_TRACK_RETENTION_DAYS días (90 por defecto)
const TRACK_DAYS = Number(process.env.RIDE_TRACK_RETENTION_DAYS || 90);
const purgeOldTracks = () => purgeTracks(TRACK_DAYS).then((n) => n && console.log(`Se borraron ${n} puntos de recorridos antiguos`)).catch(reportError);
purgeOldTracks();
setInterval(purgeOldTracks, 6 * 3600 * 1000).unref();

// Alquileres: los pedidos sin respuesta cuya fecha pasó y los confirmados que nunca empezaron se cancelan solos
const expireRentalsNow = () => expireRentals().then((n) => n && console.log(`Se cancelaron ${n} alquiler(es) vencidos`)).catch(reportError);
expireRentalsNow();
setInterval(expireRentalsNow, 10 * 60 * 1000).unref();

// Recargas: la cuenta asignada a un conductor se oculta a las 24 horas si no subió el comprobante
setInterval(() => expireRequests().catch(reportError), 10 * 60 * 1000).unref();

// Viajes: si el pasajero no responde «¿Todo bien?» a tiempo, se avisa al personal como una emergencia
setInterval(() => escalateSafety().catch(reportError), Number(process.env.SAFETY_SWEEP_MS || 15000)).unref();

// Selfies de los conductores: se borran a los 30 días
setInterval(() => purgeSelfies().catch(reportError), 6 * 3600 * 1000).unref();
