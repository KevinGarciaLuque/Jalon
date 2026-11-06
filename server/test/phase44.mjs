import 'dotenv/config';
// «Mis propinas» del conductor: hoy, este mes, en total y la lista (con solo el primer nombre del pasajero).
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
const next = (s, ev, pred = () => true, ms = 6000) => new Promise((res, rej) => { const h = (d) => { if (pred(d)) { s.off(ev, h); res(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); rej(new Error(`no llegó ${ev}`)); }, ms); });
const emitAck = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza, Tegucigalpa' };
const sockets = [];
const track = (s) => { sockets.push(s); return s; };

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);

async function ride(p, ds, price) {
  const rideNew = next(ds, 'ride:new');
  const ack = await emitAck(p.s, 'ride:request', { origin, dest, price });
  if (!ack?.ok) throw new Error(`no se pudo pedir: ${ack?.error}`);
  const rn = await rideNew;
  const offer = next(p.s, 'offer:new');
  ds.emit('offer:make', { rideId: rn.id, price });
  const o = await offer;
  const accepted = next(p.s, 'ride:state', (r) => r.status === 'accepted');
  p.s.emit('offer:accept', { offerId: o.id });
  const r = await accepted;
  let last;
  for (const st of ['arrived', 'started', 'completed']) {
    const moved = next(p.s, 'ride:state', (x) => x.status === st);
    ds.emit('ride:status', { rideId: r.id, status: st });
    last = await moved;
  }
  return last;
}

try {
  await http('PUT', 'admin/settings', SA, { tips_enabled: true, min_balance: -500 });
  const D = await registerUser({ name: 'Diana Propinas C44', phone: `9${rnd}447`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `TP${rnd.slice(0, 4)}` });
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  const D2 = await registerUser({ name: 'Otro Conductor C44', phone: `3${rnd}48`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Aveo', plate: `TQ${rnd.slice(0, 4)}` });
  const ds = track(await connect(D.token));
  ds.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(500);
  const mk = async (name, n) => {
    const u = await registerUser({ name, phone: `8${n}${rnd}4`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
    return { ...u, s: track(await connect(u.token)) };
  };
  const ana = await mk('Ana María López C44', 1);
  const beto = await mk('Beto C44', 2);

  const empty = await http('GET', 'driver/tips', D.token);
  check('sin propinas todo está en cero', empty.status === 200 && empty.summary.total === 0 && empty.tips.length === 0 && empty.range === 'month', JSON.stringify(empty.summary));

  const r1 = await ride(ana, ds, 100);
  await http('POST', `rides/${r1.id}/tip`, ana.token, { amount: 20 });
  const r2 = await ride(beto, ds, 80);
  await http('POST', `rides/${r2.id}/tip`, beto.token, { amount: 30 });
  const r3 = await ride(ana, ds, 90);
  await http('POST', `rides/${r3.id}/tip`, ana.token, { amount: 15 });
  await ride(beto, ds, 70); // sin propina: no aparece

  const t = await http('GET', 'driver/tips', D.token);
  check('suma las propinas de hoy, del mes y en total', t.summary.today === 65 && t.summary.month === 65 && t.summary.total === 65 && t.summary.todayCount === 3, JSON.stringify(t.summary));
  check('dice cuántas y de cuántos pasajeros', t.inRange.amount === 65 && t.inRange.count === 3 && t.inRange.people === 2, JSON.stringify(t.inRange));
  check('la lista va de la más nueva a la más vieja y sin el viaje sin propina', t.tips.map((x) => x.amount).join(',') === '15,30,20', t.tips.map((x) => x.amount).join(','));
  check('del pasajero muestra solo el primer nombre', t.tips[0].passenger === 'Ana' && !JSON.stringify(t.tips).includes('López'), t.tips[0].passenger);
  check('cada propina trae destino, precio del viaje y hora', t.tips[0].dest === dest.text && t.tips[0].fare === 90 && !!t.tips[0].at && t.tips[0].rideId === r3.id);
  check('no hay más páginas', t.more === false);

  // Una propina del mes pasado (el día 15 a mediodía: sin dudas por la zona horaria)
  await pool.query("UPDATE rides SET tipped_at = DATE_FORMAT(NOW() - INTERVAL 1 MONTH, '%Y-%m-15 12:00:00') WHERE id = ?", [r1.id]);
  const now = await http('GET', 'driver/tips?range=month', D.token);
  check('la del mes pasado sale del mes y de hoy, pero no del total', now.summary.month === 45 && now.summary.today === 45 && now.summary.total === 65 && now.tips.length === 2, JSON.stringify(now.summary));
  const last = await http('GET', 'driver/tips?range=last', D.token);
  const all = await http('GET', 'driver/tips?range=all', D.token);
  check('«Todo» las trae todas', all.tips.length === 3 && all.inRange.amount === 65);
  check('«Mes pasado» trae solo la del mes anterior', last.status === 200 && last.tips.length === 1 && last.tips[0].rideId === r1.id && last.inRange.amount === 20, JSON.stringify(last.tips.map((x) => x.rideId)));
  check('un rango desconocido usa este mes', (await http('GET', 'driver/tips?range=xyz', D.token)).range === 'month');

  // Quién puede verlas
  check('otro conductor no ve las propinas de este', (await http('GET', 'driver/tips', D2.token)).status === 200 && (await http('GET', 'driver/tips', D2.token)).summary.total === 0);
  check('un pasajero no puede', (await http('GET', 'driver/tips', ana.token)).status === 403);
  check('sin sesión, no', (await http('GET', 'driver/tips')).status === 401);
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
  await pool.query("UPDATE rides SET status = 'cancelled', cancelled_by = 'system' WHERE status IN ('requested','accepted','arrived','started') AND passenger_id IN (SELECT id FROM users WHERE name LIKE '% C44')");
  await http('PUT', 'admin/settings', SA, { tips_enabled: before.tips_enabled !== '0', min_balance: Number(before.min_balance) });
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
