import 'dotenv/config';
// Etapa 3, entrega 2: el conductor rechaza una solicitud (deja de verla, se retira su oferta y la vuelve a ver si el pasajero sube el precio)
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, registerUser, uploadDocs } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (s, ev, pred = () => true, ms = 5000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout esperando ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const connect = async (token) => { const s = io(API, { auth: { token }, forceNew: true }); await until(s, 'connect'); return s; };
const near = { lat: 14.073, lng: -87.1925 };

const D = await registerUser({ name: 'E1 Conductor', phone: `95${rnd}3`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Corolla', plate: `HR${rnd}`.slice(0, 7) });
await uploadDocs(D.token);
await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [D.user.id]);
const P = await registerUser({ name: 'E1 Pasajero', phone: `85${rnd}3`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
const sockets = [];

try {
  let ds = await connect(D.token);
  const ps = await connect(P.token);
  sockets.push(ps);
  ds.emit('driver:online', near);
  await wait(300);

  const got = until(ds, 'ride:new', (r) => r.passenger.id === P.user.id);
  ps.emit('ride:request', { origin: { lat: 14.0723, lng: -87.1921, text: 'Origen E2' }, dest: { lat: 14.1, lng: -87.2, text: 'Destino E2' }, price: 80 }, () => {});
  const ride = await got;
  const offerNew = until(ps, 'offer:new', (o) => o.rideId === ride.id);
  ds.emit('offer:make', { rideId: ride.id, price: 90 });
  const offer = await offerNew;

  // Rechaza: el conductor deja de verla y al pasajero se le retira la oferta
  const closed = until(ds, 'ride:closed', (x) => x.rideId === ride.id);
  const withdrawn = until(ps, 'offer:expired', (x) => x.offerId === offer.id);
  ds.emit('ride:decline', { rideId: ride.id });
  check('el conductor deja de ver la solicitud que rechazó', !!(await closed.catch(() => null)));
  check('al pasajero se le quita la oferta de ese conductor', !!(await withdrawn.catch(() => null)));
  const [[o]] = await pool.query('SELECT status FROM offers WHERE id = ?', [offer.id]);
  check('la oferta queda como rechazada', o.status === 'rejected', o.status);
  const [[r]] = await pool.query('SELECT status FROM rides WHERE id = ?', [ride.id]);
  check('el viaje sigue buscando conductor', r.status === 'requested', r.status);

  // Al reconectarse no le vuelve a llegar
  ds.close();
  ds = await connect(D.token);
  sockets.push(ds);
  const open = until(ds, 'rides:open');
  ds.emit('driver:online', near);
  const list = await open;
  check('al volver a conectarse no le aparece de nuevo', !list.some((x) => x.id === ride.id), `(${list.length} abiertas)`);

  // Si el pasajero sube el precio, sí la vuelve a ver
  const again = until(ds, 'ride:new', (x) => x.id === ride.id);
  const raised = await new Promise((res) => ps.emit('ride:raise', { rideId: ride.id, price: 95 }, res));
  check('el pasajero sube su oferta', raised?.ok === true, raised?.error || '');
  check('con el precio nuevo el conductor la vuelve a ver', Number((await again.catch(() => ({}))).offered_price) === 95);

  ps.emit('ride:cancel', { rideId: ride.id });
  await wait(300);
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
} finally {
  sockets.forEach((s) => s.close());
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
