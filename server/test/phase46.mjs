import 'dotenv/config';
// Radio para recibir solicitudes (Ajustes → Viajes, nearby_km): se aplica al instante a las solicitudes y a los carros cerca.
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
const next = (s, ev, pred = () => true, ms = 3000) => new Promise((res, rej) => { const h = (d) => { if (pred(d)) { s.off(ev, h); res(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); rej(new Error(`no llegó ${ev}`)); }, ms); });
const emitAck = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const sockets = [];
const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza' };
const away3km = { lat: 14.0723 + 0.027, lng: -87.1921 }; // ~3 km al norte

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);
try {
  check('el radio viene en 5 km', before.nearby_km === '5', before.nearby_km);
  const bad = await http('PUT', 'admin/settings', SA, { nearby_km: 50 });
  check('se valida de 1 a 30 km', /radio/.test(bad.error || ''), bad.error);
  await http('PUT', 'admin/settings', SA, { nearby_km: 2, min_balance: -500 });

  const D = await registerUser({ name: 'Radio Conductor', phone: `9${rnd}46`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `RA${rnd.slice(0, 4)}` });
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  const P = await registerUser({ name: 'Radio Pasajera', phone: `8${rnd}46`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const ds = await connect(D.token);
  const ps = await connect(P.token);
  sockets.push(ds, ps);
  ds.emit('driver:online', away3km);
  await wait(500);

  // Con 2 km: el conductor a 3 km no la recibe ni el pasajero lo ve cerca
  const near2 = next(ps, 'drivers:nearby');
  ps.emit('passenger:location', origin);
  check('con 2 km, el pasajero no ve al conductor que está a 3 km', !(await near2).some((d) => d.id === D.user.id));
  let got = next(ds, 'ride:new');
  const a1 = await emitAck(ps, 'ride:request', { origin, dest, price: 80 });
  check('con 2 km, el conductor a 3 km no recibe la solicitud', a1?.ok && !(await got.then(() => true, () => false)));
  const [[open]] = await pool.query("SELECT id FROM rides WHERE passenger_id = ? AND status = 'requested'", [P.user.id]);
  ps.emit('ride:cancel', { rideId: open.id });
  await wait(500);

  // Se sube a 5 km: se aplica al instante
  await http('PUT', 'admin/settings', SA, { nearby_km: 5 });
  const near5 = next(ps, 'drivers:nearby');
  ps.emit('passenger:location', origin);
  check('con 5 km, el pasajero sí lo ve', (await near5).some((d) => d.id === D.user.id));
  got = next(ds, 'ride:new');
  const a2 = await emitAck(ps, 'ride:request', { origin, dest, price: 80 });
  check('con 5 km, sí recibe la solicitud (sin reiniciar nada)', a2?.ok && (await got.then(() => true, () => false)));
  const [[open2]] = await pool.query("SELECT id FROM rides WHERE passenger_id = ? AND status = 'requested'", [P.user.id]);
  if (open2) ps.emit('ride:cancel', { rideId: open2.id });
  await wait(300);
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
  await http('PUT', 'admin/settings', SA, { nearby_km: Number(before.nearby_km || 5), min_balance: Number(before.min_balance) });
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
