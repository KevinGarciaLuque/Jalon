import 'dotenv/config';
// Propinas: al terminar el viaje el pasajero puede dejarle propina en efectivo al conductor. Es toda del conductor
// (sin comisión), una sola vez por viaje y solo en los primeros 15 minutos.
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
const dest = { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza' };
const sockets = [];
const track = (s) => { sockets.push(s); return s; };

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);
let n = 0;
const passenger = async (name) => {
  n += 1;
  const u = await registerUser({ name: `${name} C42`, phone: `8${n}${rnd}7`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  return { ...u, s: track(await connect(u.token)) };
};
// Un viaje completo de L 100; devuelve lo último que vio el pasajero (el viaje terminado)
async function ride(p, ds) {
  const rideNew = next(ds, 'ride:new');
  const ack = await emitAck(p.s, 'ride:request', { origin, dest, price: 100 });
  if (!ack?.ok) throw new Error(`no se pudo pedir: ${ack?.error}`);
  const rn = await rideNew;
  const offer = next(p.s, 'offer:new');
  ds.emit('offer:make', { rideId: rn.id, price: 100 });
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
  await wait(600); // la comisión se guarda sin esperar
  return last;
}
const balanceOf = async (id) => Number((await pool.query('SELECT COALESCE(SUM(amount), 0) AS b FROM wallet_entries WHERE user_id = ?', [id]))[0][0].b);
const tipOf = async (id) => (await pool.query('SELECT tip FROM rides WHERE id = ?', [id]))[0][0].tip;

try {
  await http('POST', 'admin/bank-accounts', SA, { bank: 'Banco 42', type: 'Ahorros', number: `42-${rnd}`, holder: 'Ktracho GO' });
  const set = await http('PUT', 'admin/settings', SA, { commission_enabled: true, commission_percent: 10, welcome_credit: 0, min_balance: -500, tips_enabled: true });
  check('las propinas se encienden en Ajustes', set.tips_enabled === '1', JSON.stringify(set.error || ''));

  const D = await registerUser({ name: 'Dario C42', phone: `9${rnd}427`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HT${rnd.slice(0, 4)}` });
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  const ds = track(await connect(D.token));
  ds.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(500);
  const P = await passenger('Pia');
  const Q = await passenger('Quique');
  const metricsBefore = await http('GET', 'admin/metrics?preset=today', SA);

  const r1 = await ride(P, ds);
  check('al terminar, el pasajero ve que puede dejar propina', r1.tipOpen === true && r1.tip === null, JSON.stringify({ tipOpen: r1.tipOpen, tip: r1.tip }));
  const bal0 = await balanceOf(D.user.id);

  // ---------- Validaciones ----------
  check('no se aceptan centavos', (await http('POST', `rides/${r1.id}/tip`, P.token, { amount: 10.5 })).status === 400);
  check('ni cero', (await http('POST', `rides/${r1.id}/tip`, P.token, { amount: 0 })).status === 400);
  check('ni más de L 500', (await http('POST', `rides/${r1.id}/tip`, P.token, { amount: 501 })).status === 400);
  check('otro pasajero no puede dar propina en ese viaje', (await http('POST', `rides/${r1.id}/tip`, Q.token, { amount: 20 })).status === 404);
  check('el conductor no puede anotarse propina', (await http('POST', `rides/${r1.id}/tip`, D.token, { amount: 20 })).status === 403);
  check('nada de eso guardó una propina', (await tipOf(r1.id)) === null);

  // ---------- La propina ----------
  const driverSees = next(ds, 'ride:state', (x) => x.id === r1.id && x.tip === 20);
  const t = await http('POST', `rides/${r1.id}/tip`, P.token, { amount: 20 });
  check('el pasajero deja L 20 de propina', t.ok === true && t.ride?.tip === 20 && t.ride?.tipOpen === false, JSON.stringify(t.error || ''));
  check('el conductor lo ve al instante', !!(await driverSees.catch(() => null)));
  check('el precio del viaje no cambia (la propina va aparte)', t.ride?.toPay === 100);
  const again = await http('POST', `rides/${r1.id}/tip`, P.token, { amount: 50 });
  check('solo se da una vez por viaje', again.status === 409 && /Ya dejaste/.test(again.error), again.error);
  const twice = await Promise.all([1, 2].map(() => http('POST', `rides/${r1.id}/tip`, P.token, { amount: 30 })));
  check('dos toques a la vez no la cambian', twice.every((x) => x.status === 409) && Number(await tipOf(r1.id)) === 20);

  // ---------- Sin comisión ----------
  const [[com]] = await pool.query("SELECT -SUM(amount) AS c FROM wallet_entries WHERE ride_id = ? AND kind = 'commission'", [r1.id]);
  check('la comisión es solo sobre el viaje (L 10 de L 100)', Number(com.c) === 10, String(com.c));
  check('la propina no toca el saldo del conductor', (await balanceOf(D.user.id)) === bal0);

  // ---------- Ganancias, historial y métricas ----------
  const e = await http('GET', 'driver/earnings?period=day', D.token);
  check('Ganancias muestra las propinas aparte', e.tips === 20, JSON.stringify({ tips: e.tips }));
  check('y las suma a lo que le quedó', Math.abs(e.net - (e.gross - e.commission + e.tips + e.rentals.gross - e.rentals.commission)) < 0.01, JSON.stringify({ net: e.net, gross: e.gross, commission: e.commission }));
  const det = await http('GET', `rides/${r1.id}/detail`, P.token);
  check('el recibo muestra la propina', det.tip === 20);
  const mine = await http('GET', 'rides/mine', P.token);
  check('el historial trae la propina', Number(mine.rides?.find((x) => x.id === r1.id)?.tip) === 20);
  check('lo gastado en el mes la incluye', mine.month?.total === 120, JSON.stringify(mine.month));
  const m = await http('GET', 'admin/metrics?preset=today', SA);
  check('las métricas suman las propinas', m.kpis?.tips - metricsBefore.kpis?.tips === 20, JSON.stringify([metricsBefore.kpis?.tips, m.kpis?.tips]));

  // ---------- Pasados los 15 minutos ----------
  const r2 = await ride(P, ds);
  await pool.query('UPDATE rides SET completed_at = NOW() - INTERVAL 16 MINUTE WHERE id = ?', [r2.id]);
  const late = await http('POST', `rides/${r2.id}/tip`, P.token, { amount: 20 });
  check('pasados 15 minutos ya no se puede', late.status === 409 && /tiempo/.test(late.error), late.error);
  check('y no quedó guardada', (await tipOf(r2.id)) === null);

  // ---------- Apagadas ----------
  const r3 = await ride(Q, ds);
  await http('PUT', 'admin/settings', SA, { tips_enabled: false });
  const off = await http('POST', `rides/${r3.id}/tip`, Q.token, { amount: 20 });
  check('apagadas: no se puede dejar propina', off.status === 403, off.error);
  await http('PUT', 'admin/settings', SA, { tips_enabled: true });
  check('al encenderlas de nuevo vuelve a funcionar', (await http('POST', `rides/${r3.id}/tip`, Q.token, { amount: 50 })).ride?.tip === 50);
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
  await pool.query("UPDATE rides SET status = 'cancelled', cancelled_by = 'system' WHERE status IN ('requested','accepted','arrived','started') AND passenger_id IN (SELECT id FROM users WHERE name LIKE '% C42')");
  await http('PUT', 'admin/settings', SA, {
    commission_enabled: before.commission_enabled === '1', commission_percent: Number(before.commission_percent), welcome_credit: Number(before.welcome_credit), min_balance: Number(before.min_balance),
    tips_enabled: before.tips_enabled !== '0',
  });
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
