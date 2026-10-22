import 'dotenv/config';
// Revisión de la experiencia: el punto de recogida con GPS no le llega al conductor como «Mi ubicación»
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, registerUser } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
// El servidor responde { ok: true }: el viaje se busca por pasajero
const request = async (s, origin, passengerId) => {
  const ack = await new Promise((r) => s.emit('ride:request', { origin, dest: { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza' }, price: 90 }, r));
  const [[row]] = await pool.query('SELECT id FROM rides WHERE passenger_id = ? ORDER BY id DESC LIMIT 1', [passengerId]);
  return { ...ack, rideId: row?.id };
};
const sockets = [];

try {
  const P = await registerUser({ name: 'C26 Pasajero', phone: `84${rnd}6`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const ps = await connect(P.token);
  sockets.push(ps);

  const gps = await request(ps, { lat: 14.0723, lng: -87.1921, text: 'Mi ubicación' }, P.user.id);
  const [[r1]] = await pool.query('SELECT origin_text FROM rides WHERE id = ?', [gps.rideId]);
  check('con el GPS del pasajero no se guarda «Mi ubicación» (al conductor lo confunde)', !!gps.rideId && r1.origin_text !== 'Mi ubicación', `(${r1?.origin_text})`);
  check('se guarda la dirección aproximada o «Ubicación del pasajero»', r1.origin_text === 'Ubicación del pasajero' || r1.origin_text.startsWith('Cerca de '));
  ps.emit('ride:cancel', { rideId: gps.rideId });
  await new Promise((r) => setTimeout(r, 400));

  const typed = await request(ps, { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy, frente a la iglesia' }, P.user.id);
  const [[r2]] = await pool.query('SELECT origin_text FROM rides WHERE id = ?', [typed.rideId]);
  check('una dirección escrita por el pasajero se guarda tal cual', r2.origin_text === 'Colonia Kennedy, frente a la iglesia');
  ps.emit('ride:cancel', { rideId: typed.rideId });
  await new Promise((r) => setTimeout(r, 300));

  // Con la app abierta en dos aparatos: el viaje pedido en uno aparece en el otro,
  // y si el otro intenta pedir de nuevo se le muestra el viaje activo en vez de solo un error
  const ps2 = await connect(P.token);
  sockets.push(ps2);
  const seen = new Promise((r) => ps2.once('ride:state', r));
  const third = await request(ps, { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' }, P.user.id);
  const mirrored = await Promise.race([seen, new Promise((r) => setTimeout(() => r(null), 2000))]);
  check('el viaje pedido en un aparato aparece en el otro', mirrored?.id === third.rideId);
  const shown = new Promise((r) => ps2.once('ride:state', r));
  const again = await new Promise((r) => ps2.emit('ride:request', { origin: { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' }, dest: { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza' }, price: 90 }, r));
  const current = await Promise.race([shown, new Promise((r) => setTimeout(() => r(null), 2000))]);
  check('pedir con un viaje activo devuelve error y muestra ese viaje', !!again?.error && current?.id === third.rideId);
  ps.emit('ride:cancel', { rideId: third.rideId });
  await new Promise((r) => setTimeout(r, 300));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
