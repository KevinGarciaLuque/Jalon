import 'dotenv/config';
// Etapa 5: horas conectado, camino real del viaje, historial con filtros y detalle, y ganancias del conductor
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

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
const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const sockets = [];

try {
  const D = await registerUser({ name: 'E1 Conductor', phone: `92${rnd}7`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', model: 'Corolla', plate: `T${rnd}` });
  await uploadDocs(D.token);
  await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [D.user.id]);
  const P = await registerUser({ name: 'E1 Pasajero', phone: `82${rnd}7`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const X = await registerUser({ name: 'E1 Pasajero', phone: `81${rnd}7`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const ds = await connect(D.token), ps = await connect(P.token);
  sockets.push(ds, ps);

  // Al ponerse disponible empieza su sesión
  ds.emit('driver:online', { lat: 14.0723, lng: -87.1921 });
  await wait(500);
  const [[open]] = await pool.query('SELECT COUNT(*) AS n FROM driver_sessions WHERE driver_id = ? AND ended_at IS NULL', [D.user.id]);
  check('al ponerse disponible empieza a contar su tiempo conectado', open.n === 1);

  // Un viaje completo, moviéndose durante el viaje
  const got = until(ds, 'ride:new', (r) => r.passenger.id === P.user.id);
  ps.emit('ride:request', { origin: { lat: 14.0723, lng: -87.1921, text: 'Origen E5' }, dest: { lat: 14.1, lng: -87.2, text: 'Destino E5' }, price: 90 }, () => {});
  const ride = await got;
  const offer = until(ps, 'offer:new', (o) => o.rideId === ride.id);
  ds.emit('offer:make', { rideId: ride.id, price: 90 });
  const accepted = until(ds, 'ride:state', (v) => v.id === ride.id && v.status === 'accepted');
  ps.emit('offer:accept', { offerId: (await offer).id });
  await accepted;
  for (const s of ['arrived', 'started']) {
    const st = until(ds, 'ride:state', (v) => v.id === ride.id && v.status === s);
    ds.emit('ride:status', { rideId: ride.id, status: s });
    await st;
  }
  // Tres posiciones separadas por más de 150 m (y más de 3 s entre una y otra)
  for (let i = 1; i <= 3; i++) {
    await wait(3200);
    ds.emit('driver:location', { lat: 14.0723 + i * 0.004, lng: -87.1921 - i * 0.002 });
  }
  // Una más muy cerca y enseguida: no se guarda
  await wait(400);
  ds.emit('driver:location', { lat: 14.0723 + 3 * 0.004 + 0.0001, lng: -87.1921 - 3 * 0.002 });
  await wait(600);
  const done = until(ds, 'ride:state', (v) => v.id === ride.id && v.status === 'completed');
  ds.emit('ride:status', { rideId: ride.id, status: 'completed' });
  await done;
  const [[times]] = await pool.query('SELECT started_at IS NOT NULL AS s, completed_at IS NOT NULL AS c FROM rides WHERE id = ?', [ride.id]);
  check('se anota cuándo empezó y cuándo terminó el viaje', !!times.s && !!times.c);
  const [[pts]] = await pool.query('SELECT COUNT(*) AS n FROM ride_points WHERE ride_id = ?', [ride.id]);
  check('se guarda el camino real durante el viaje', pts.n >= 3 && pts.n <= 4, `(${pts.n} puntos)`);
  ds.emit('driver:location', { lat: 14.2, lng: -87.3 });
  await wait(500);
  const [[after]] = await pool.query('SELECT COUNT(*) AS n FROM ride_points WHERE ride_id = ?', [ride.id]);
  check('ya terminado, no se guarda nada más', after.n === pts.n);

  // Detalle del viaje
  const det = await http('GET', `rides/${ride.id}/detail`, P.token);
  check('el pasajero ve el detalle con el camino real', det.track?.length === pts.n && det.realKm > 0 && det.me === 'passenger' && det.other?.name === 'E1 Conductor', `(${det.realKm} km)`);
  check('y la duración real', det.realMin != null);
  check('otra persona no puede ver ese viaje', (await http('GET', `rides/${ride.id}/detail`, X.token)).status === 404);
  const rec = await http('GET', `rides/${ride.id}/receipt`, P.token);
  check('el recibo trae los kilómetros reales', rec.realKm > 0);

  // Historial con filtros, páginas y lo del mes
  const mine = await http('GET', 'rides/mine', P.token);
  check('el historial trae el viaje y lo gastado este mes', mine.rides?.[0]?.id === ride.id && mine.month?.total >= 90 && mine.hasMore === false);
  check('el filtro de cancelados no lo muestra', !(await http('GET', 'rides/mine?status=cancelled', P.token)).rides.some((r) => r.id === ride.id));
  check('«ver más» pide los anteriores', (await http('GET', `rides/mine?before=${ride.id}`, P.token)).rides.every((r) => r.id < ride.id));

  // Ganancias: un viaje de L 90 hoy, y horas conectado (se agrega una sesión de 2 horas que terminó hace un rato)
  await pool.query('INSERT INTO driver_sessions (driver_id, started_at, last_seen_at, ended_at) VALUES (?, NOW() - INTERVAL 150 MINUTE, NOW() - INTERVAL 30 MINUTE, NOW() - INTERVAL 30 MINUTE)', [D.user.id]);
  const day = await http('GET', 'driver/earnings?period=day', D.token);
  check('ganancias de hoy: viajes y cobrado', day.rides === 1 && day.gross === 90 && day.net === 90, JSON.stringify({ rides: day.rides, gross: day.gross, net: day.net }));
  check('el gráfico de hoy va por hora', day.series?.length === 24 && day.series.reduce((s, x) => s + x.gross, 0) === 90);
  const week = await http('GET', 'driver/earnings?period=week', D.token);
  check('la semana tiene 7 días y suma lo mismo', week.series?.length === 7 && week.gross >= 90);
  check('cuenta sus horas conectado y la ganancia por hora', week.hours >= 2 && week.perHour > 0, `(${week.hours} h, L ${week.perHour}/h)`);
  const month = await http('GET', 'driver/earnings?period=month', D.token);
  check('el mes trae todos sus días', month.series?.length >= 28 && month.from.endsWith('-01'));
  check('un pasajero no tiene ganancias', (await http('GET', 'driver/earnings', P.token)).status === 403);

  // Al desconectarse se cierra la sesión
  ds.emit('driver:offline');
  await wait(400);
  const [[closed]] = await pool.query('SELECT COUNT(*) AS n FROM driver_sessions WHERE driver_id = ? AND ended_at IS NULL', [D.user.id]);
  check('al desconectarse deja de contar', closed.n === 0);

  // El panel ve sus horas de los últimos 30 días; los datos descargados incluyen el camino
  const ficha = await http('GET', `admin/monitor/drivers/${D.user.id}`, SA);
  check('la ficha de rendimiento muestra las horas conectado', ficha.last30?.hoursOnline >= 2, `(${ficha.last30?.hoursOnline})`);
  const exp = await http('GET', 'me/export', P.token);
  check('al descargar sus datos el pasajero recibe el camino de su viaje', exp.recorridosDeViajes?.some((r) => r.viaje === ride.id && r.puntos.length === pts.n));

  // Al eliminar la cuenta se borran el camino y las horas
  await http('POST', `admin/users/${D.user.id}/delete`, SA);
  const [[gone]] = await pool.query('SELECT (SELECT COUNT(*) FROM ride_points WHERE ride_id = ?) AS p, (SELECT COUNT(*) FROM driver_sessions WHERE driver_id = ?) AS s', [ride.id, D.user.id]);
  check('al eliminar la cuenta se borran su camino y sus horas', gone.p === 0 && gone.s === 0);
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
} finally {
  sockets.forEach((s) => s.close());
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
