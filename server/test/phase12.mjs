import 'dotenv/config';
// Etapa 1 (estabilización): aceptar ofertas a la vez no asigna dos veces, y los eventos del socket tienen tope
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
const origin = { lat: 14.0723, lng: -87.1921, text: 'Origen E1' };
const dest = { lat: 14.1, lng: -87.2, text: 'Destino E1' };

async function driver(n) {
  const D = await registerUser({ name: 'E1 Conductor', phone: `9${n}${rnd}9`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Corolla', plate: `HE${n}${rnd}`.slice(0, 7) });
  await uploadDocs(D.token);
  await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [D.user.id]);
  const s = await connect(D.token);
  s.emit('driver:online', { lat: 14.073, lng: -87.1925 });
  await wait(300);
  return { id: D.user.id, s };
}
async function passenger(n) {
  const P = await registerUser({ name: 'E1 Pasajero', phone: `8${n}${rnd}9`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  return { id: P.user.id, s: await connect(P.token) };
}
// El pasajero pide un viaje y devuelve la solicitud tal como la recibe `d`
async function request(p, d) {
  const got = until(d.s, 'ride:new', (r) => r.passenger.id === p.id);
  p.s.emit('ride:request', { origin, dest, price: 80 }, () => {});
  return got;
}
async function offer(d, p, ride, price) {
  const got = until(p.s, 'offer:new', (o) => o.rideId === ride.id && o.driver.id === d.id);
  d.s.emit('offer:make', { rideId: ride.id, price });
  return got;
}

const sockets = [];
try {
  // 1) Un pasajero acepta a la vez las ofertas de dos conductores (doble toque): el viaje queda con uno solo y el otro sigue libre
  const D1 = await driver(1), D2 = await driver(2), P1 = await passenger(1);
  sockets.push(D1.s, D2.s, P1.s);
  const ride1 = await request(P1, D1);
  const [o1, o2] = await Promise.all([offer(D1, P1, ride1, 90), offer(D2, P1, ride1, 95)]);
  P1.s.emit('offer:accept', { offerId: o1.id });
  P1.s.emit('offer:accept', { offerId: o2.id });
  await wait(800);
  const [[r1]] = await pool.query('SELECT status, driver_id, final_price FROM rides WHERE id = ?', [ride1.id]);
  const [acc1] = await pool.query("SELECT driver_id FROM offers WHERE ride_id = ? AND status = 'accepted'", [ride1.id]);
  check('doble aceptación: el viaje queda aceptado con un conductor', r1.status === 'accepted' && [D1.id, D2.id].includes(r1.driver_id));
  check('doble aceptación: una sola oferta aceptada, la del conductor asignado', acc1.length === 1 && acc1[0].driver_id === r1.driver_id, `(${acc1.length})`);
  const loser = r1.driver_id === D1.id ? D2 : D1;
  const winner = r1.driver_id === D1.id ? D1 : D2;

  // El que no quedó sigue libre: puede ofertar en otro viaje y lo pueden aceptar
  const P2 = await passenger(2);
  sockets.push(P2.s);
  const ride2 = await request(P2, loser);
  const o3 = await offer(loser, P2, ride2, 85);
  const winnerOffer = until(P2.s, 'offer:new', (o) => o.driver.id === winner.id, 1500).then(() => true, () => false);
  winner.s.emit('offer:make', { rideId: ride2.id, price: 70 });
  check('el conductor asignado no puede ofertar en otro viaje', !(await winnerOffer));
  const st2 = until(P2.s, 'ride:state', (v) => v.id === ride2.id && v.status === 'accepted');
  P2.s.emit('offer:accept', { offerId: o3.id });
  check('el conductor que no quedó sigue libre y lo pueden aceptar', (await st2.catch(() => null))?.driver?.id === loser.id);

  // 2) Dos pasajeros aceptan a la vez ofertas del mismo conductor: solo uno se lo lleva
  const D3 = await driver(3), P3 = await passenger(3), P4 = await passenger(4);
  sockets.push(D3.s, P3.s, P4.s);
  const ride3 = await request(P3, D3);
  const ride4 = await request(P4, D3);
  const [o4, o5] = await Promise.all([offer(D3, P3, ride3, 80), offer(D3, P4, ride4, 80)]);
  const invalid = Promise.race([
    until(P3.s, 'offer:invalid', (x) => x.offerId === o4.id, 3000).then(() => 'P3'),
    until(P4.s, 'offer:invalid', (x) => x.offerId === o5.id, 3000).then(() => 'P4'),
  ]).catch(() => null);
  P3.s.emit('offer:accept', { offerId: o4.id });
  P4.s.emit('offer:accept', { offerId: o5.id });
  const loserP = await invalid;
  await wait(500);
  const [both] = await pool.query("SELECT id, status FROM rides WHERE id IN (?) ORDER BY id", [[ride3.id, ride4.id]]);
  const taken = both.filter((r) => r.status === 'accepted');
  check('un conductor no queda asignado a dos viajes a la vez', taken.length === 1, `(${taken.length} aceptados)`);
  check('el otro pasajero se entera de que la oferta ya no vale', !!loserP);
  check('y su viaje sigue buscando conductor', both.some((r) => r.status === 'requested'));

  // 3) Un cambio de estado repetido no se aplica dos veces
  for (const s of ['arrived', 'started']) {
    const got = until(winner.s, 'ride:state', (v) => v.id === ride1.id && v.status === s);
    winner.s.emit('ride:status', { rideId: ride1.id, status: s });
    await got;
  }
  P1.s.emit('ride:cancel', { rideId: ride1.id });
  await wait(400);
  const [[r1b]] = await pool.query('SELECT status FROM rides WHERE id = ?', [ride1.id]);
  check('el pasajero no puede cancelar un viaje ya iniciado', r1b.status === 'started');

  // 4) Tope de eventos por conexión: una app que inunda al servidor recibe un aviso y se le descartan los excedentes
  const acks = await Promise.all(Array.from({ length: 40 }, () => new Promise((r) => P1.s.emit('ride:raise', { rideId: 0, price: 1 }, r))));
  const limited = acks.filter((a) => /Demasiadas acciones/.test(a?.error || '')).length;
  check('los mensajes de más se rechazan', limited === 10, `(${limited} de 40)`);
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
} finally {
  sockets.forEach((s) => s.close());
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
