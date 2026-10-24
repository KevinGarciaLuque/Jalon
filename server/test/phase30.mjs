import 'dotenv/config';
// Etapa 9.1: PIN de viaje. El pasajero ve un PIN de 4 dígitos y el conductor lo escribe para iniciar el viaje.
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

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);

// Pide un viaje, el conductor ofrece, el pasajero acepta y el conductor llega. Devuelve el viaje (vista del pasajero y del conductor)
async function arrivedRide(ps, ds) {
  const offered = next(ds, 'ride:new');
  const ack = await emitAck(ps, 'ride:request', { origin, dest, price: 90 });
  if (ack?.error) throw new Error(ack.error);
  const rideNew = await offered;
  const offer = next(ps, 'offer:new');
  ds.emit('offer:make', { rideId: rideNew.id, price: 90 });
  const o = await offer;
  const acceptedP = next(ps, 'ride:state', (r) => r.status === 'accepted');
  const acceptedD = next(ds, 'ride:state', (r) => r.status === 'accepted');
  ps.emit('offer:accept', { offerId: o.id });
  const [rp, rd] = await Promise.all([acceptedP, acceptedD]);
  const arrived = next(ps, 'ride:state', (r) => r.status === 'arrived');
  ds.emit('ride:status', { rideId: rd.id, status: 'arrived' });
  await arrived;
  return { rp, rd };
}

try {
  await http('PUT', 'admin/settings', SA, { ride_pin_required: true });
  const P = await registerUser({ name: 'C30 Pasajera', phone: `83${rnd}0`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const D = await registerUser({ name: 'C30 Conductor', phone: `93${rnd}0`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HP3${rnd.slice(0, 4)}` });
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  const ps = await connect(P.token);
  const ds = await connect(D.token);
  sockets.push(ps, ds);
  ds.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(600);

  const { rp, rd } = await arrivedRide(ps, ds);
  check('el viaje aceptado dice que hace falta el PIN', rp.pinRequired === true && rd.pinRequired === true);
  check('el conductor nunca recibe el PIN', !('start_pin' in rd) && !JSON.stringify(rd).match(/"start_pin"/));
  const { pin } = await http('GET', `rides/${rp.id}/pin`, P.token);
  check('la pasajera ve su PIN de 4 dígitos', /^\d{4}$/.test(pin || ''));
  check('el conductor no puede pedir el PIN', (await http('GET', `rides/${rp.id}/pin`, D.token)).status === 403);
  check('otra persona no ve el PIN', (await http('GET', `rides/${rp.id}/pin`, (await registerUser({ name: 'C30 Otra', phone: `82${rnd}0`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' })).token)).status === 404);

  const noPin = await emitAck(ds, 'ride:status', { rideId: rd.id, status: 'started' });
  check('sin PIN no se puede iniciar el viaje', !!noPin?.error && /PIN incorrecto/.test(noPin.error), `(${noPin?.error})`);
  const wrong = pin === '0000' ? '1111' : '0000';
  const bad = await emitAck(ds, 'ride:status', { rideId: rd.id, status: 'started', pin: wrong });
  check('con un PIN equivocado tampoco, y dice cuántos intentos quedan', /quedan 3/.test(bad?.error || ''), `(${bad?.error})`);
  const started = next(ps, 'ride:state', (r) => r.status === 'started');
  const good = await emitAck(ds, 'ride:status', { rideId: rd.id, status: 'started', pin });
  check('con el PIN correcto empieza el viaje', good?.ok === true && (await started).status === 'started');
  check('con el viaje empezado ya no se muestra el PIN', (await http('GET', `rides/${rp.id}/pin`, P.token)).pin === null);
  const done = next(ps, 'ride:state', (r) => r.status === 'completed');
  ds.emit('ride:status', { rideId: rd.id, status: 'completed' });
  await done;

  // Cinco intentos equivocados: el viaje ya no se puede iniciar y la pasajera recibe un aviso
  ds.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(600);
  const second = await arrivedRide(ps, ds);
  const pin2 = (await http('GET', `rides/${second.rp.id}/pin`, P.token)).pin;
  const wrong2 = pin2 === '0000' ? '1111' : '0000';
  let last;
  for (let i = 0; i < 5; i++) last = await emitAck(ds, 'ride:status', { rideId: second.rd.id, status: 'started', pin: wrong2 });
  check('a los 5 intentos equivocados se bloquea el inicio', last?.locked === true);
  check('ni con el PIN correcto se puede iniciar después', (await emitAck(ds, 'ride:status', { rideId: second.rd.id, status: 'started', pin: pin2 }))?.locked === true);
  const bell = await http('GET', 'notifications', P.token);
  check('la pasajera recibe el aviso «No se pudo confirmar tu PIN»', bell.items?.some((n) => n.title === 'No se pudo confirmar tu PIN'));
  const [[row]] = await pool.query('SELECT status FROM rides WHERE id = ?', [second.rd.id]);
  check('el viaje sigue sin empezar (se puede cancelar)', row.status === 'arrived');
  ds.emit('ride:driver_cancel', { rideId: second.rd.id });
  await wait(400);

  // Con el PIN apagado para todos, solo lo usa quien lo activó en Mi cuenta
  await http('PUT', 'admin/settings', SA, { ride_pin_required: false });
  check('un conductor no puede activar el PIN de pasajero', (await http('PUT', 'me/ride-pin', D.token, { enabled: true })).status === 403);
  check('la pasajera activa «Usar PIN en mis viajes»', (await http('PUT', 'me/ride-pin', P.token, { enabled: true })).ridePin === true);
  check('su sesión lo trae', (await http('GET', 'me', P.token)).user?.ridePin === true);
  ds.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(600);
  const byPref = await arrivedRide(ps, ds);
  check('con el PIN apagado para todos, a quien lo activó se le pide', byPref.rp.pinRequired === true);
  ds.emit('ride:driver_cancel', { rideId: byPref.rd.id });
  await wait(400);
  await http('PUT', 'me/ride-pin', P.token, { enabled: false });

  // Apagado para todos y sin activarlo: el viaje empieza sin PIN
  ds.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(600);
  const third = await arrivedRide(ps, ds);
  check('con el PIN apagado no se pide', third.rp.pinRequired === false);
  const s3 = next(ps, 'ride:state', (r) => r.status === 'started');
  ds.emit('ride:status', { rideId: third.rd.id, status: 'started' });
  check('y el viaje empieza sin PIN', (await s3).status === 'started');
  ds.emit('ride:status', { rideId: third.rd.id, status: 'completed' });
  await wait(400);
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await http('PUT', 'admin/settings', SA, { ride_pin_required: before.ride_pin_required !== '0' });
  sockets.forEach((s) => s.close());
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
