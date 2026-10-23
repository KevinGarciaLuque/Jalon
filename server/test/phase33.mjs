import 'dotenv/config';
// Etapa 9.4: «Solo conductoras». El sexo es opcional; a las conductoras lo confirma el personal con su licencia.
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
const sockets = [];

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const driver = async (name, n, plate) => {
  const d = await registerUser({ name, phone: `9${n}${rnd}`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate });
  await uploadDocs(d.token);
  await http('POST', `admin/users/${d.user.id}/status`, SA, { status: 'active' });
  return d;
};

try {
  const P = await registerUser({ name: 'C33 Pasajera', phone: `83${rnd}3`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const M = await driver('C33 Conductor', '61', `HM3${rnd.slice(0, 4)}`);
  const W = await driver('C33 Conductora', '62', `HW3${rnd.slice(0, 4)}`);

  // Mi cuenta: el sexo es opcional
  check('una opción inválida se rechaza', (await http('PUT', 'me/gender', P.token, { gender: 'z' })).status === 400);
  const ps = await connect(P.token);
  sockets.push(ps);
  check('sin indicar que es mujer, no puede pedir «Solo conductoras»', /pasajeras/.test((await emitAck(ps, 'ride:request', { origin, dest, price: 90, womenOnly: true }))?.error || ''));
  check('la pasajera indica «Mujer»', (await http('PUT', 'me/gender', P.token, { gender: 'f' })).gender === 'f');
  check('su sesión lo trae', (await http('GET', 'me', P.token)).user?.gender === 'f');
  await http('PUT', 'me/gender', M.token, { gender: 'm' });
  await http('PUT', 'me/gender', W.token, { gender: 'f' });
  check('la conductora aparece sin confirmar', (await http('GET', 'me', W.token)).user?.genderVerified === false);

  // Solicitud «Solo conductoras»: ni el conductor ni la conductora sin confirmar la reciben
  const ms = await connect(M.token);
  const ws = await connect(W.token);
  sockets.push(ms, ws);
  ms.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  ws.emit('driver:online', { lat: 14.0714, lng: -87.1933 });
  await wait(600);
  const toM = got(ms, 'ride:new');
  const toW = got(ws, 'ride:new');
  const ack = await emitAck(ps, 'ride:request', { origin, dest, price: 90, womenOnly: true });
  check('la pasajera pide «Solo conductoras»', ack?.ok === true);
  const [[ride]] = await pool.query('SELECT id, women_only FROM rides WHERE passenger_id = ? ORDER BY id DESC LIMIT 1', [P.user.id]);
  check('el viaje queda marcado «Solo conductoras»', ride.women_only === 1);
  check('al conductor no le llega', (await toM) === null);
  check('a la conductora sin confirmar tampoco', (await toW) === null);
  const offer = got(ps, 'offer:new');
  ms.emit('offer:make', { rideId: ride.id, price: 90 });
  check('si el conductor intenta ofertar, no llega la oferta', (await offer) === null);

  // El personal confirma a la conductora (vio su licencia): ahora sí le llega
  check('el personal solo confirma a quien indicó su sexo', (await http('POST', `admin/users/${P.user.id}/gender`, SA, { verified: true })).status === 404);
  check('el personal confirma a la conductora', (await http('POST', `admin/users/${W.user.id}/gender`, SA, { verified: true })).ok === true);
  const open = got(ws, 'rides:open');
  ws.emit('driver:online', { lat: 14.0714, lng: -87.1933 });
  const list = await open;
  check('confirmada, la conductora ve el viaje «Solo conductoras»', !!list?.some((r) => r.id === ride.id));
  const openM = got(ms, 'rides:open');
  ms.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  check('el conductor sigue sin verlo en su lista', !(await openM)?.some((r) => r.id === ride.id));
  const nearby = await new Promise((r) => { ps.once('drivers:nearby', r); ps.emit('passenger:location', origin); });
  check('la pasajera ve cuántas conductoras hay cerca', nearby.some((d) => d.id === W.user.id && d.woman) && nearby.some((d) => d.id === M.user.id && !d.woman));
  const offerW = got(ps, 'offer:new', () => true, 3000);
  ws.emit('offer:make', { rideId: ride.id, price: 95 });
  check('la conductora oferta y le llega a la pasajera', (await offerW)?.driver?.id === W.user.id);
  ps.emit('ride:cancel', { rideId: ride.id });
  await wait(400);

  // Si la conductora cambia su sexo, hay que confirmarlo otra vez
  await http('PUT', 'me/gender', W.token, { gender: 'x' });
  check('al cambiarlo, la confirmación se quita', (await http('GET', 'me', W.token)).user?.genderVerified === false);
  check('el Registro anota la confirmación', (await http('GET', 'admin/audit', SA)).some((a) => a.action === 'user.gender.verify'));
  check('los términos ahora son la versión 1.9', (await http('GET', 'me', P.token)).user?.termsVersion === '1.9');
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
