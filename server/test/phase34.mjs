import 'dotenv/config';
// Etapa 10: viaje programado, paradas, viaje para otra persona, punto de referencia y destinos recientes
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
const got = (s, ev, pred = () => true, ms = 1500) => new Promise((res) => { const h = (d) => { if (pred(d)) { s.off(ev, h); res(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(null); }, ms); });
const emitAck = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza' };
const stopA = { lat: 14.0801, lng: -87.1990, text: 'Farmacia' };
const stopB = { lat: 14.0850, lng: -87.2020, text: 'Banco' };
const inMin = (m) => new Date(Date.now() + m * 60000).toISOString();
const sockets = [];

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

try {
  const P = await registerUser({ name: 'C34 Pasajero', phone: `84${rnd}4`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const D = await registerUser({ name: 'C34 Conductor', phone: `94${rnd}4`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HK3${rnd.slice(0, 4)}` });
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  const ps = await connect(P.token);
  const ds = await connect(D.token);
  sockets.push(ps, ds);
  ds.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(600);

  // Ruta con paradas
  const direct = await http('GET', `route?from=${origin.lat},${origin.lng}&to=${dest.lat},${dest.lng}`, P.token);
  const via = await http('GET', `route?from=${origin.lat},${origin.lng}&to=${dest.lat},${dest.lng}&via=${stopA.lat},${stopA.lng}|${stopB.lat},${stopB.lng}`, P.token);
  check('la ruta con paradas es más larga o igual que la directa', via.distanceKm >= direct.distanceKm, `(${direct.distanceKm} → ${via.distanceKm} km)`);
  check('más de 2 paradas no', /2 paradas/.test((await emitAck(ps, 'ride:request', { origin, dest, price: 90, stops: [stopA, stopB, stopA] }))?.error || ''));
  check('una parada inválida no', /parada/.test((await emitAck(ps, 'ride:request', { origin, dest, price: 90, stops: [{ lat: 'x' }] }))?.error || ''));

  // Para otra persona: se valida
  check('para otra persona sin nombre no', /nombre/.test((await emitAck(ps, 'ride:request', { origin, dest, price: 90, rider: { name: '', phone: '99887766' } }))?.error || ''));
  check('para otra persona con teléfono inválido no', /teléfono/.test((await emitAck(ps, 'ride:request', { origin, dest, price: 90, rider: { name: 'Doña Marta', phone: '12' } }))?.error || ''));

  // Programar: fuera de rango no
  check('programar para dentro de 5 minutos no', /Programa/.test((await emitAck(ps, 'ride:request', { origin, dest, price: 90, scheduledFor: inMin(5) }))?.error || ''));
  check('programar para dentro de 8 días no', /Programa/.test((await emitAck(ps, 'ride:request', { origin, dest, price: 90, scheduledFor: inMin(8 * 1440) }))?.error || ''));

  // Programado con todo: paradas, nota y para otra persona
  const toD = got(ds, 'ride:new', () => true, 1000);
  const ack = await emitAck(ps, 'ride:request', { origin, dest, price: 95, stops: [stopA, stopB], pickupNote: 'Frente a la pulpería, portón verde', rider: { name: 'Doña Marta', phone: '9988-7766' }, scheduledFor: inMin(60) });
  check('el pasajero programa un viaje', ack?.ok === true && ack.scheduled?.id > 0, JSON.stringify(ack));
  const id = ack.scheduled?.id;
  check('al conductor no le llega todavía', (await toD) === null);
  const [[row]] = await pool.query('SELECT status, rider_phone, pickup_note, stops_json FROM rides WHERE id = ?', [id]);
  check('queda «programado» con sus datos', row.status === 'scheduled' && row.rider_phone === '99887766' && row.pickup_note.startsWith('Frente') && JSON.parse(row.stops_json).length === 2);
  check('aparece en «Tus viajes programados»', (await http('GET', 'rides/scheduled', P.token)).rides.some((r) => r.id === id));
  check('el conductor no ve la lista de programados del pasajero', (await http('GET', 'rides/scheduled', D.token)).status === 403);

  // Llega la hora: sale a buscar conductor
  const released = got(ds, 'ride:new', (r) => r.id === id, 5000);
  const state = got(ps, 'ride:state', (r) => r.id === id, 5000);
  await pool.query('UPDATE rides SET scheduled_for = NOW() + INTERVAL 10 MINUTE WHERE id = ?', [id]);
  const seen = await released;
  check('a la hora, al conductor le llega la solicitud', !!seen);
  check('con sus paradas, la nota y a quién recoger', seen?.stops?.length === 2 && seen.stops[0].text === 'Farmacia' && seen.pickup_note?.startsWith('Frente') && seen.rider_name === 'Doña Marta');
  check('pero no el teléfono de quien viaja', seen && !('rider_phone' in seen) && !('stops_json' in seen));
  check('el pasajero ve que ya se busca conductor', (await state)?.status === 'requested');
  check('ya no está en los programados', !(await http('GET', 'rides/scheduled', P.token)).rides.some((r) => r.id === id));
  const rider = await http('GET', `rides/${id}/rider`, P.token);
  check('el pasajero ve el teléfono para mandarle el seguimiento', rider.phone === '99887766' && rider.name === 'Doña Marta');
  check('el conductor no', (await http('GET', `rides/${id}/rider`, D.token)).status === 403);
  ps.emit('ride:cancel', { rideId: id });
  await wait(400);

  // Cancelar un programado
  const ack2 = await emitAck(ps, 'ride:request', { origin, dest, price: 90, scheduledFor: inMin(120) });
  check('cancelar un viaje programado', (await http('POST', `rides/${ack2.scheduled.id}/cancel-scheduled`, P.token)).ok === true);
  check('no se cancela dos veces', (await http('POST', `rides/${ack2.scheduled.id}/cancel-scheduled`, P.token)).status === 404);

  // Destinos recientes: los viajes completados
  await pool.query("INSERT INTO rides (passenger_id, origin_lat, origin_lng, dest_lat, dest_lng, dest_text, distance_km, offered_price, status) VALUES (?, 14.07, -87.19, 14.1, -87.21, 'Estadio Nacional', 3, 80, 'completed')", [P.user.id]);
  const recent = await http('GET', 'rides/recent-destinations', P.token);
  check('destinos recientes: aparecen los completados', recent.places?.some((p) => p.text === 'Estadio Nacional') && !recent.places.some((p) => p.text === 'Mall Multiplaza'));
  ds.emit('driver:offline');
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
