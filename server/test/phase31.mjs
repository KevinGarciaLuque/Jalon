import 'dotenv/config';
// Etapa 9.2: «¿Todo bien?» si el carro se desvía de la ruta o lleva mucho detenido; si piden ayuda o no responden, alerta al personal.
// Los tiempos son cortos en las pruebas (run.mjs): desvío 2 s, detenido 3 s, responder 3 s.
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { distanceToRoute } from '../src/services/safety.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
const next = (s, ev, pred = () => true, ms = 8000) => new Promise((res, rej) => { const h = (d) => { if (pred(d)) { s.off(ev, h); res(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); rej(new Error(`no llegó ${ev}`)); }, ms); });
const emitAck = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza' };
const ROUTE = [[origin.lat, origin.lng], [14.0814, -87.1988], [dest.lat, dest.lng]];
const sockets = [];

// Unidad: distancia de un punto a la ruta
check('un punto sobre la ruta está a ~0 m', distanceToRoute({ lat: 14.0814, lng: -87.1988 }, ROUTE) < 5);
const far = distanceToRoute({ lat: 14.0814, lng: -87.1788 }, ROUTE);
check('un punto lejos de la ruta (a 2,2 km del punto más cercano en línea recta, 1,7 km del tramo diagonal) se mide bien', far > 1600 && far < 1900, `(${Math.round(far)} m)`);

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);
const alertsOf = async (rideId) => (await http('GET', 'admin/alerts', SA)).filter((a) => a.ride_id === rideId);

async function startedRide(ps, ds) {
  ds.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(500);
  const got = next(ds, 'ride:new');
  const ack = await emitAck(ps, 'ride:request', { origin, dest, price: 90 });
  if (ack?.error) throw new Error(ack.error);
  const rn = await got;
  const offer = next(ps, 'offer:new');
  ds.emit('offer:make', { rideId: rn.id, price: 90 });
  const o = await offer;
  const acc = next(ds, 'ride:state', (r) => r.status === 'accepted');
  ps.emit('offer:accept', { offerId: o.id });
  const ride = await acc;
  await pool.query('UPDATE rides SET route_json = ? WHERE id = ?', [JSON.stringify(ROUTE), ride.id]); // la ruta por calles (sin OSRM en las pruebas)
  for (const st of ['arrived', 'started']) { const u = next(ps, 'ride:state', (r) => r.status === st); ds.emit('ride:status', { rideId: ride.id, status: st }); await u; }
  return ride;
}
// El conductor manda su posición cada medio segundo durante `ms`
async function drive(ds, pos, ms) { for (let t = 0; t < ms; t += 500) { ds.emit('driver:location', pos); await wait(500); } }

try {
  await http('PUT', 'admin/settings', SA, { ride_safety_checks: true });
  const P = await registerUser({ name: 'C31 Pasajera', phone: `83${rnd}1`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const D = await registerUser({ name: 'C31 Conductor', phone: `93${rnd}1`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HS3${rnd.slice(0, 4)}` });
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  const ps = await connect(P.token);
  const ds = await connect(D.token);
  sockets.push(ps, ds);

  const ride = await startedRide(ps, ds);
  // Siguiendo la ruta no pasa nada
  const quiet = next(ps, 'safety:check', () => true, 2500).then(() => true, () => false);
  for (const p of ROUTE) { ds.emit('driver:location', { lat: p[0], lng: p[1] }); await wait(700); }
  check('siguiendo la ruta no se pregunta nada', !(await quiet));

  // Desvío: a 2 km de la ruta durante más de 2 s
  const dev = next(ps, 'safety:check');
  drive(ds, { lat: 14.0814, lng: -87.1788 }, 3500);
  const c1 = await dev;
  check('al desviarse, a la pasajera le sale «¿Todo bien?» (desvío)', c1.kind === 'deviation' && c1.rideId === ride.id);
  check('otra persona no puede responder el aviso', (await emitAck(ds, 'safety:answer', { eventId: c1.eventId, answer: 'ok' }))?.error === 'Aviso no encontrado');
  const closed = next(ps, 'safety:closed', (e) => e.eventId === c1.eventId);
  const okAns = await emitAck(ps, 'safety:answer', { eventId: c1.eventId, answer: 'ok' });
  check('responde «Sí, todo bien» y se cierra', okAns?.ok === true && (await closed).answer === 'ok');
  check('con «todo bien» no se crea ninguna alerta', (await alertsOf(ride.id)).length === 0);

  // Detenido: sin moverse más de 3 s lejos del destino, y sin responder → alerta automática al personal
  await wait(2200); // pasa el tiempo de calma después del «todo bien»
  const stop = next(ps, 'safety:check', (c) => c.kind === 'stopped');
  drive(ds, { lat: 14.0814, lng: -87.1988 }, 4500);
  const c2 = await stop;
  check('detenido varios minutos (3 s en la prueba), le pregunta otra vez (detenido)', c2.kind === 'stopped');
  const escalated = next(ps, 'safety:closed', (e) => e.eventId === c2.eventId && e.escalated, 9000);
  await escalated.then(() => check('si no responde, se avisa al equipo y se le dice a la pasajera', true), () => check('si no responde, se avisa al equipo y se le dice a la pasajera', false));
  const a1 = await alertsOf(ride.id);
  check('el personal ve una alerta automática con el motivo y la ubicación', a1.some((a) => /Alerta automática: el carro lleva varios minutos detenido/.test(a.reason || '') && a.lat != null));
  const [[ev]] = await pool.query('SELECT escalated_at FROM ride_safety_events WHERE id = ?', [c2.eventId]);
  check('el aviso queda marcado como enviado al personal', !!ev.escalated_at);

  // Pedir ayuda: alerta inmediata
  await wait(2200);
  const dev2 = next(ps, 'safety:check', (c) => c.kind === 'deviation');
  drive(ds, { lat: 14.0814, lng: -87.1788 }, 3500);
  const c3 = await dev2;
  await emitAck(ps, 'safety:answer', { eventId: c3.eventId, answer: 'help' });
  await wait(500);
  check('al tocar «Pedir ayuda» se crea la alerta al momento', (await alertsOf(ride.id)).some((a) => /El pasajero pidió ayuda: el carro se desvió de la ruta/.test(a.reason || '')));
  check('la campanita del personal recibe la alerta', (await http('GET', 'notifications', SA)).items?.some((n) => n.title === '🆘 Alerta en un viaje'));
  for (const a of await alertsOf(ride.id)) await http('POST', `admin/alerts/${a.id}/resolve`, SA, {});
  const fin = next(ps, 'ride:state', (r) => r.status === 'completed');
  ds.emit('ride:status', { rideId: ride.id, status: 'completed' });
  await fin;

  // Apagado en Ajustes: no se pregunta
  await http('PUT', 'admin/settings', SA, { ride_safety_checks: false });
  await wait(300);
  const ride2 = await startedRide(ps, ds);
  const none = next(ps, 'safety:check', () => true, 4000).then(() => true, () => false);
  drive(ds, { lat: 14.0814, lng: -87.1788 }, 3500);
  check('con el aviso apagado en Ajustes, no se pregunta nada', !(await none));
  ds.emit('ride:status', { rideId: ride2.id, status: 'completed' });
  await wait(400);
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await http('PUT', 'admin/settings', SA, { ride_safety_checks: before.ride_safety_checks !== '0' });
  sockets.forEach((s) => s.close());
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
