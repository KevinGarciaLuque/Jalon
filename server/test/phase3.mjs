import 'dotenv/config';
// Fase 3: ruta real, direcciones, calificaciones, historial, compartir viaje y emergencia
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { registerUser } from './helpers.mjs';

const API = 'http://localhost:4000';
const rnd = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const until = (s, ev, pred, ms = 6000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout esperando ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
const call = async (method, path, token, body) => {
  const r = await fetch(`${API}/api/${path}`, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j) ? Object.assign(j, { status: r.status }) : { status: r.status, ...j };
};

const D = await registerUser({ name: 'P3 Driver', phone: `9${rnd}`, password: 'secreto1', role: 'driver', vehicle: 'Hilux', plate: 'HBB5678' });
const P = await registerUser({ name: 'P3 Pasajero', phone: `8${rnd}`, password: 'secreto1', role: 'passenger' });
await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [D.user.id]);
const [[adm]] = await pool.query("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1");
const A = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '5m' });

const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.1, lng: -87.2, text: 'Destino' };

// ---- Direcciones y rutas ----
check('buscar direcciones exige sesión', (await call('GET', 'places?q=multiplaza')).status === 401);
const pl = await call('GET', `places?q=${encodeURIComponent('Mall Multiplaza Tegucigalpa')}&lat=14.07&lng=-87.19`, P.token);
if (pl.status === 502) console.log('SKIP buscar direcciones (servicio externo no disponible)');
else check('buscar direcciones devuelve resultados en Honduras', pl.results?.length > 0 && Math.abs(pl.results[0].lat - 14.08) < 0.3, `(${pl.results?.[0]?.text})`);
check('búsqueda muy corta no consulta nada', (await call('GET', 'places?q=ab', P.token)).results.length === 0);
const rv = await call('GET', 'reverse?lat=14.0723&lng=-87.1921', P.token);
check('dirección de un punto del mapa', rv.status === 200 && (rv.text === null || typeof rv.text === 'string'), `(${rv.text})`);
check('reverse rechaza coordenadas inválidas', (await call('GET', 'reverse?lat=999&lng=0', P.token)).status === 400);

const rt = await call('GET', `route?from=${origin.lat},${origin.lng}&to=${dest.lat},${dest.lng}`, P.token);
check('ruta con distancia, tiempo y precio', rt.distanceKm > 2 && rt.durationMin > 0 && rt.coords.length >= 2 && rt.suggestedPrice >= 30, `(${rt.distanceKm?.toFixed(1)} km, ${rt.durationMin?.toFixed(0)} min, L${rt.suggestedPrice}${rt.estimated ? ', estimada' : ''})`);
check('ruta rechaza puntos inválidos', (await call('GET', 'route?from=x&to=y', P.token)).status === 400);

// ---- Viaje completo ----
const ds = io(API, { auth: { token: D.token } });
const ps = io(API, { auth: { token: P.token } });
await Promise.all([until(ds, 'connect', () => true), until(ps, 'connect', () => true)]);
ds.emit('driver:online', { lat: 14.073, lng: -87.1925 });
ps.emit('passenger:location', origin);
await wait(500);

async function runRide(price, stopAt = 'completed') {
  const rq = until(ds, 'ride:new', () => true);
  const state = until(ps, 'ride:state', (r) => r.status === 'requested');
  ps.emit('ride:request', { origin, dest, price }, () => {});
  const ride = await rq;
  const requested = await state;
  const offer = until(ps, 'offer:new', () => true);
  ds.emit('offer:make', { rideId: ride.id, price });
  const o = await offer;
  ps.emit('offer:accept', { offerId: o.id });
  await until(ps, 'ride:state', (r) => r.status === 'accepted');
  if (stopAt === 'accepted') return { ride, requested, offer: o };
  for (const st of ['arrived', 'started', 'completed']) {
    const u = until(ps, 'ride:state', (r) => r.status === st);
    ds.emit('ride:status', { rideId: ride.id, status: st });
    await u;
  }
  return { ride, requested, offer: o };
}

const first = await runRide(80, 'accepted');
check('el viaje guarda la ruta real', Array.isArray(first.requested.route) && first.requested.route.length >= 2);
check('la distancia es por calle (mayor que en línea recta)', first.requested.distance_km > 3.2, `(${first.requested.distance_km.toFixed(1)} km)`);
check('el viaje trae el tiempo estimado', first.requested.duration_min > 0);

// ---- Compartir y seguimiento ----
const sh = await call('POST', `rides/${first.ride.id}/share`, P.token);
check('pasajero genera enlace para compartir', sh.token?.length >= 16);
const sh2 = await call('POST', `rides/${first.ride.id}/share`, D.token);
check('el enlace es el mismo para el conductor', sh2.token === sh.token);
const tr = await call('GET', `track/${sh.token}`);
check('seguimiento público muestra estado y conductor', tr.status === 'accepted' && tr.driver?.name === 'P3' && tr.driver.plate === 'HBB5678');
check('seguimiento no expone teléfonos ni apellidos', !JSON.stringify(tr).includes(D.user.phone) && !JSON.stringify(tr).includes(P.user.phone) && tr.driver.name === 'P3');
check('enlace inventado no funciona', (await call('GET', 'track/abcdefghijklmnop')).status === 404);
check('un tercero no puede compartir el viaje', (await call('POST', `rides/${first.ride.id}/share`, A)).status === 404);

// ---- Emergencia ----
const ackSos = (s, pos) => new Promise((res) => s.emit('ride:sos', pos, res));
check('SOS del pasajero se registra', (await ackSos(ps, origin)).ok === true);
check('SOS del conductor se registra', (await ackSos(ds, null)).ok === true);
const al = await call('GET', 'admin/alerts', A);
const mine = al.filter((a) => a.ride_id === first.ride.id);
check('el admin ve las alertas con datos de contacto', mine.length === 2 && mine.some((a) => a.user_phone === P.user.phone && a.driver_phone === D.user.phone));
check('el admin ve las alertas en las estadísticas', (await call('GET', 'admin/stats', A)).openAlerts >= 2);
check('el admin resuelve una alerta', (await call('POST', `admin/alerts/${mine[0].id}/resolve`, A, {})).ok === true);
check('alerta resuelta ya no aparece', !(await call('GET', 'admin/alerts', A)).some((a) => a.id === mine[0].id));

// termina el primer viaje
for (const st of ['arrived', 'started', 'completed']) {
  const u = until(ps, 'ride:state', (r) => r.status === st);
  ds.emit('ride:status', { rideId: first.ride.id, status: st });
  await u;
}

// ---- Calificaciones ----
check('no se puede dar 6 estrellas', (await call('POST', `rides/${first.ride.id}/rate`, P.token, { stars: 6 })).status === 400);
check('pasajero califica al conductor', (await call('POST', `rides/${first.ride.id}/rate`, P.token, { stars: 5, comment: 'Excelente' })).ok === true);
check('no se puede calificar dos veces', (await call('POST', `rides/${first.ride.id}/rate`, P.token, { stars: 1 })).status === 409);
check('conductor califica al pasajero', (await call('POST', `rides/${first.ride.id}/rate`, D.token, { stars: 4 })).ok === true);
check('un tercero no puede calificar', (await call('POST', `rides/${first.ride.id}/rate`, A, { stars: 5 })).status === 404);

// ---- Historial ----
const hist = await call('GET', 'rides/mine', P.token);
const h1 = hist.rides.find((r) => r.id === first.ride.id);
check('historial lista el viaje con su calificación', h1?.status === 'completed' && h1.my_stars === 5 && h1.their_stars === 4 && h1.other_name === 'P3 Driver');
check('historial trae mi promedio', hist.rating.avg === 4 && hist.rating.count === 1);

// ---- Calificación visible en la siguiente oferta y en el admin ----
const second = await runRide(70, 'accepted');
check('la oferta muestra la calificación del conductor', second.offer.driver.rating.avg === 5 && second.offer.driver.rating.count === 1);
check('el viaje muestra calificación del conductor', second.requested.passenger.rating.avg === 4);
const cancelled = until(ps, 'ride:state', (r) => r.status === 'cancelled');
ps.emit('ride:cancel', { rideId: second.ride.id });
await cancelled;
const users = (await call('GET', 'admin/users', A)).users;
check('el admin ve la calificación de cada usuario', users.find((u) => u.id === D.user.id)?.rating?.avg === 5);

// SOS fuera de un viaje
check('SOS sin viaje activo es rechazado', !!(await ackSos(ps, origin)).error);

// Un conductor que se desconecta en pleno viaje no debe quedar como "libre fantasma"
{
  const third = await runRide(60, 'accepted');
  ds.close();
  await wait(400);
  const gone = until(ps, 'ride:state', (r) => r.status === 'cancelled');
  ps.emit('ride:cancel', { rideId: third.ride.id });
  await gone;
  ps.emit('passenger:location', origin);
  await wait(3500); // la lista de cercanos se refresca cada 3 s
  const list = await until(ps, 'drivers:nearby', () => true, 5000);
  check('conductor desconectado no queda como libre fantasma', !list.some((d) => d.id === D.user.id));
}

ds.close(); ps.close();
await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
