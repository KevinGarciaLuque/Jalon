import 'dotenv/config';
// Modo pasajero: un conductor pide viajes con su misma cuenta y vuelve a modo conductor
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
const at = { lat: 14.0712, lng: -87.1935 };
const sockets = [];

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const driver = async (name, n, plate) => {
  const d = await registerUser({ name, phone: `9${n}${rnd}`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate });
  await uploadDocs(d.token);
  await http('POST', `admin/users/${d.user.id}/status`, SA, { status: 'active' });
  return d;
};
const track = (s) => { sockets.push(s); return s; };

try {
  const D = await driver('C35 Conductor', '71', `HN3${rnd.slice(0, 4)}`);
  const O = await driver('C35 Otro', '72', `HP3${rnd.slice(0, 4)}`);
  const P = await registerUser({ name: 'C35 Pasajero', phone: `85${rnd}5`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  await pool.query('UPDATE users SET balance = 123 WHERE id = ?', [D.user.id]);

  check('un pasajero normal no puede cambiar de modo', (await http('POST', 'me/mode', P.token, { mode: 'driver' })).status === 403);
  check('un modo inválido se rechaza', (await http('POST', 'me/mode', D.token, { mode: 'admin' })).status === 400);
  check('el personal no puede cambiar de modo', (await http('POST', 'me/mode', SA, { mode: 'passenger' })).status === 403);
  check('la sesión dice que puede conducir', (await http('GET', 'me', D.token)).user?.canDrive === true);

  // Oferta pendiente y conductor disponible: al cambiar sale del mapa y se retira la oferta
  const ds = track(await connect(D.token));
  ds.emit('driver:online', at);
  await wait(500);
  const ps = track(await connect(P.token));
  await emitAck(ps, 'ride:request', { origin, dest, price: 90 });
  const [[open]] = await pool.query('SELECT id FROM rides WHERE passenger_id = ? ORDER BY id DESC LIMIT 1', [P.user.id]);
  const offered = got(ps, 'offer:new');
  ds.emit('offer:make', { rideId: open.id, price: 90 });
  check('el conductor oferta', !!(await offered));
  const expired = got(ps, 'offer:expired');
  const modeEvent = got(ds, 'account:mode');
  const closed = got(ds, 'disconnect');
  const sw = await http('POST', 'me/mode', D.token, { mode: 'passenger' });
  check('cambia a modo pasajero', sw.user?.role === 'passenger' && sw.user.canDrive === true && sw.user.passengerMode === true, JSON.stringify(sw.user?.role));
  check('al pasajero se le retira su oferta', !!(await expired));
  check('sus otros aparatos reciben el modo nuevo', (await modeEvent)?.role === 'passenger');
  check('y su conexión anterior se cierra', (await closed) !== null);
  check('sale del mapa', !(await http('GET', 'admin/monitor', SA).then((m) => JSON.stringify(m))).includes('"C35 Conductor"'));

  // Como pasajero: las solicitudes no le llegan y puede pedir
  const dp = track(await connect(D.token));
  const noRide = got(dp, 'ride:new', () => true, 800);
  ps.emit('ride:raise', { rideId: open.id, price: 95 });
  check('en modo pasajero no le llegan solicitudes', (await noRide) === null);
  dp.emit('driver:online', at);
  await wait(400);
  const [[{ n: inSession }]] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE id = ? AND passenger_mode = 1', [D.user.id]);
  check('queda guardado', inSession === 1);
  check('las rutas de conductor quedan cerradas', (await http('POST', 'driver/selfie', D.token, { image: 'x' })).status === 403);
  check('sigue en modo pasajero al volver a consultar', (await http('GET', 'me', D.token)).user?.role === 'passenger');
  check('el panel lo sigue viendo como conductor, en modo pasajero', await http('GET', `admin/users/${D.user.id}`, SA).then((r) => (r.user || r).role === 'driver' && !!(r.user || r).passenger_mode));
  ps.emit('ride:cancel', { rideId: open.id });
  await wait(300);

  const os = track(await connect(O.token));
  os.emit('driver:online', at);
  await wait(500);
  const toOther = got(os, 'ride:new');
  const ack = await emitAck(dp, 'ride:request', { origin, dest, price: 80 });
  check('pide un viaje', ack?.ok === true, JSON.stringify(ack));
  const req = await toOther;
  check('a otro conductor le llega su solicitud', req?.passenger_id === D.user.id);
  check('con un viaje en curso no puede cambiar de modo', (await http('POST', 'me/mode', D.token, { mode: 'driver' })).status === 409);
  dp.emit('ride:cancel', { rideId: req?.id });
  await wait(400);

  // Viaje programado: hay que cancelarlo antes de volver
  const sch = await emitAck(dp, 'ride:request', { origin, dest, price: 80, scheduledFor: new Date(Date.now() + 3600000).toISOString() });
  check('con un viaje programado no vuelve a conductor', (await http('POST', 'me/mode', D.token, { mode: 'driver' })).status === 409);
  await http('POST', `rides/${sch.scheduled.id}/cancel-scheduled`, D.token);

  const back = await http('POST', 'me/mode', D.token, { mode: 'driver' });
  check('vuelve a modo conductor', back.user?.role === 'driver' && back.user.passengerMode === false);
  const [[u]] = await pool.query('SELECT balance, status, role FROM users WHERE id = ?', [D.user.id]);
  check('su saldo y aprobación no cambiaron', Number(u.balance) === 123 && u.status === 'active' && u.role === 'driver');
  await wait(400);
  const dd = track(await connect(D.token));
  const denied = got(dd, 'driver:denied', () => true, 800);
  dd.emit('driver:online', at);
  check('puede ponerse disponible otra vez', (await denied) === null);
  check('el Registro anota los cambios', (await http('GET', 'admin/audit', SA)).some((a) => a.action === 'user.mode'));

  // Conductor sin aprobar: puede usar el modo pasajero
  const N = await registerUser({ name: 'C35 Nuevo', phone: `97${rnd}5`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HQ3${rnd.slice(0, 4)}` });
  check('un conductor sin aprobar puede usar el modo pasajero', (await http('POST', 'me/mode', N.token, { mode: 'passenger' })).user?.role === 'passenger');
  // Cuenta bloqueada: en ningún modo
  await http('POST', `admin/users/${N.user.id}/status`, SA, { status: 'blocked' });
  check('una cuenta bloqueada no entra en ningún modo', (await http('POST', 'me/mode', N.token, { mode: 'driver' })).status === 401);
  check('al entrar, recuerda su último modo', await pool.query('SELECT passenger_mode FROM users WHERE id = ?', [N.user.id]).then(([[r]]) => r.passenger_mode === 1));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
