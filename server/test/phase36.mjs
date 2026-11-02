import 'dotenv/config';
// Al quedar libre (terminó o le cancelaron el viaje), el conductor recibe las solicitudes que se pidieron mientras estaba ocupado
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
const got = (s, ev, pred = () => true, ms = 2000) => new Promise((res) => { const h = (d) => { if (pred(d)) { s.off(ev, h); res(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(null); }, ms); });
const emitAck = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza' };
const sockets = [];
const lastRide = async (id) => (await pool.query('SELECT id FROM rides WHERE passenger_id = ? ORDER BY id DESC LIMIT 1', [id]))[0][0].id;

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

try {
  const D = await registerUser({ name: 'C36 Conductor', phone: `96${rnd}6`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HR3${rnd.slice(0, 4)}` });
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  const passenger = async (n) => registerUser({ name: `C36 Pasajero ${n}`, phone: `8${n}${rnd}6`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const P1 = await passenger(1);
  const P2 = await passenger(2);
  const ds = await connect(D.token);
  const p1 = await connect(P1.token);
  const p2 = await connect(P2.token);
  sockets.push(ds, p1, p2);
  ds.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(500);

  // El conductor toma un viaje
  const take = async (ps, pid) => {
    await emitAck(ps, 'ride:request', { origin, dest, price: 90 });
    const rideId = await lastRide(pid);
    const offer = got(ps, 'offer:new');
    ds.emit('offer:make', { rideId, price: 90 });
    const o = await offer;
    const st = got(ds, 'ride:state', (r) => r.id === rideId && r.status === 'accepted');
    ps.emit('offer:accept', { offerId: o.id });
    await st;
    return rideId;
  };
  const first = await take(p1, P1.user.id);
  check('el conductor queda en un viaje', first > 0);

  // Mientras está ocupado alguien pide: no le llega
  const during = got(ds, 'ride:new', () => true, 800);
  await emitAck(p2, 'ride:request', { origin, dest, price: 100 });
  const waiting = await lastRide(P2.user.id);
  check('estando ocupado no le llega la solicitud', (await during) === null);

  // Termina: le aparece sin tocar nada
  for (const status of ['arrived', 'started']) await emitAck(ds, 'ride:status', { rideId: first, status });
  const open = got(ds, 'rides:open', (l) => l.some((r) => r.id === waiting));
  await emitAck(ds, 'ride:status', { rideId: first, status: 'completed' });
  check('al terminar el viaje recibe la solicitud que estaba esperando', !!(await open));

  // Le cancelan: también
  p2.emit('ride:cancel', { rideId: waiting });
  await wait(400);
  await emitAck(p2, 'ride:request', { origin, dest, price: 110 });
  const second = await lastRide(P2.user.id);
  const offer2 = got(p2, 'offer:new');
  ds.emit('offer:make', { rideId: second, price: 110 });
  const o2 = await offer2;
  const st2 = got(ds, 'ride:state', (r) => r.id === second && r.status === 'accepted');
  p2.emit('offer:accept', { offerId: o2.id });
  await st2;
  await emitAck(p1, 'ride:request', { origin, dest, price: 120 });
  const third = await lastRide(P1.user.id);
  const open2 = got(ds, 'rides:open', (l) => l.some((r) => r.id === third));
  p2.emit('ride:cancel', { rideId: second });
  check('si le cancelan el viaje también la recibe', !!(await open2));

  // La que rechazó no le vuelve a aparecer
  const closed = got(ds, 'ride:closed', (c) => c.rideId === third);
  ds.emit('ride:decline', { rideId: third });
  await closed;
  await emitAck(p2, 'ride:request', { origin, dest, price: 130 });
  const fourth = await lastRide(P2.user.id);
  const offer3 = got(p2, 'offer:new');
  ds.emit('offer:make', { rideId: fourth, price: 130 });
  const o3 = await offer3;
  const st3 = got(ds, 'ride:state', (r) => r.id === fourth && r.status === 'accepted');
  p2.emit('offer:accept', { offerId: o3.id });
  await st3;
  const open3 = got(ds, 'rides:open');
  p2.emit('ride:cancel', { rideId: fourth });
  const list = await open3;
  check('una solicitud que rechazó no le vuelve a aparecer', !!list && !list.some((r) => r.id === third));
  p1.emit('ride:cancel', { rideId: third });
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
