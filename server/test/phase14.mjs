import 'dotenv/config';
// Etapa 4: categorías (moto, carro, carro amplio), tarifas configurables y vehículo de cada conductor con placa única
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (s, ev, pred = () => true, ms = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout esperando ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const connect = async (token) => { const s = io(API, { auth: { token }, forceNew: true }); await until(s, 'connect'); return s; };
const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const sockets = [];
const settingsBefore = await http('GET', 'admin/settings', SA);

try {
  // Precios por categoría
  const P = await registerUser({ name: 'E1 Pasajero', phone: `83${rnd}4`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const route = await http('GET', 'route?from=14.0723,-87.1921&to=14.1,-87.2', P.token);
  const old = Math.max(30, Math.round((25 + route.distanceKm * 12) / 5) * 5);
  check('la ruta trae el precio de cada categoría', route.prices && route.prices.moto > 0 && route.prices.car > 0 && route.prices.xl > 0, JSON.stringify(route.prices));
  check('el carro cuesta lo mismo que antes de las categorías', route.prices?.car === old && route.suggestedPrice === old, `(${route.prices?.car} vs ${old})`);
  check('moto < carro < carro amplio', route.prices.moto < route.prices.car && route.prices.car < route.prices.xl);

  // Tarifas en Ajustes
  const saved = await http('PUT', 'admin/settings', SA, { fare_moto_base: 40, fare_moto_km: 8, fare_moto_minimum: 20 });
  check('el superadmin cambia la tarifa de la moto', saved.fare_moto_base === '40', saved.error || '');
  const route2 = await http('GET', 'route?from=14.0723,-87.1921&to=14.1,-87.2', P.token);
  check('el precio sugerido cambia con la tarifa nueva', route2.prices.moto === route.prices.moto + 25, `(${route.prices.moto} → ${route2.prices.moto})`);
  const bad = await http('PUT', 'admin/settings', SA, { fare_xl_km: -3 });
  check('no acepta tarifas negativas', bad.status === 400);

  // Registro con vehículo (y placa única sin importar espacios o guiones)
  const M = await registerUser({ name: 'E1 Conductor', phone: `93${rnd}4`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', category: 'moto', make: 'Honda', model: 'XR150', color: 'Roja', year: 2022, plate: `m-${rnd}` });
  check('un conductor se registra con su moto', !!M.token && M.user?.vehicle === 'Honda XR150 Roja 2022' && M.user.plate === `M${rnd}`, `${M.error || ''} ${M.user?.vehicle} ${M.user?.plate}`);
  const [[mv]] = await pool.query('SELECT category, make, model, color, year, plate FROM vehicles WHERE driver_id = ?', [M.user.id]);
  check('el vehículo queda guardado con sus datos', mv?.category === 'moto' && mv.year === 2022 && mv.plate === `M${rnd}`);
  const dup = await registerUser({ name: 'E1 Conductor', phone: `94${rnd}4`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', model: 'Otra', plate: `M ${rnd}` });
  check('no se puede registrar una placa que ya existe', dup.status === 409 && /placa/.test(dup.error), dup.error);
  const [[noUser]] = await pool.query('SELECT COUNT(*) AS n FROM users WHERE phone = ?', [`94${rnd}4`.slice(0, 8)]);
  check('y no queda una cuenta a medias', noUser.n === 0);
  const badYear = await registerUser({ name: 'E1 Conductor', phone: `95${rnd}4`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', model: 'Corolla', plate: `Y${rnd}`, year: 1900 });
  check('valida el año del vehículo', badYear.status === 400, badYear.error);
  const C = await registerUser({ name: 'E1 Conductor', phone: `96${rnd}4`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Toyota Corolla blanco', plate: `C${rnd}` });
  const [[cv]] = await pool.query('SELECT category, model FROM vehicles WHERE driver_id = ?', [C.user.id]);
  check('la app anterior (texto libre) sigue registrando como carro', cv?.category === 'car' && cv.model === 'Toyota Corolla blanco');

  // Cada solicitud llega solo a los conductores de su categoría
  for (const d of [M, C]) { await uploadDocs(d.token); await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [d.user.id]); }
  const ms = await connect(M.token), cs = await connect(C.token), ps = await connect(P.token);
  sockets.push(ms, cs, ps);
  ms.emit('driver:online', { lat: 14.073, lng: -87.1925 });
  cs.emit('driver:online', { lat: 14.073, lng: -87.1925 });
  await wait(400);
  const toMoto = until(ms, 'ride:new', (r) => r.passenger.id === P.user.id);
  const toCar = until(cs, 'ride:new', (r) => r.passenger.id === P.user.id, 1500).then(() => true, () => false);
  ps.emit('ride:request', { origin: { lat: 14.0723, lng: -87.1921 }, dest: { lat: 14.1, lng: -87.2 }, category: 'moto' }, () => {});
  const ride = await toMoto.catch(() => null);
  check('la solicitud de moto le llega al conductor de moto', ride?.category === 'moto');
  check('y no al de carro', !(await toCar));
  check('sin precio escrito, se usa la tarifa de la moto', Number(ride?.offered_price) === route2.prices.moto, `(${ride?.offered_price})`);

  // El personal cambia la categoría del vehículo y se aplica de inmediato
  const put = await http('PUT', `admin/users/${C.user.id}/vehicle`, SA, { category: 'xl', make: 'Toyota', model: 'Hiace', color: 'Blanca', year: 2019, plate: `C${rnd}` });
  check('el personal edita el vehículo', put.ok === true, put.error || '');
  const detail = await http('GET', `admin/users/${C.user.id}`, SA);
  check('la ficha muestra el vehículo', detail.vehicle?.category === 'xl' && detail.user.vehicle === 'Toyota Hiace Blanca 2019');
  ps.emit('ride:cancel', { rideId: ride?.id });
  await wait(300);
  const toXl = until(cs, 'ride:new', (r) => r.passenger.id === P.user.id);
  ps.emit('ride:request', { origin: { lat: 14.0723, lng: -87.1921 }, dest: { lat: 14.1, lng: -87.2 }, category: 'xl', price: 120 }, () => {});
  check('ahora le llegan las solicitudes de carro amplio', (await toXl.catch(() => null))?.category === 'xl');
  const taken = await http('PUT', `admin/users/${C.user.id}/vehicle`, SA, { category: 'xl', model: 'Hiace', plate: `M${rnd}` });
  check('no se puede poner la placa de otro vehículo', taken.status === 409, taken.error);
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
} finally {
  sockets.forEach((s) => s.close());
  // Las tarifas vuelven a como estaban
  const fares = Object.fromEntries(Object.entries(settingsBefore).filter(([k]) => k.startsWith('fare_')));
  await http('PUT', 'admin/settings', SA, fares);
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
