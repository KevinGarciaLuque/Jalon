import 'dotenv/config';
// Modo de prueba del superadmin: usa la app como pasajero o conductor (con viajes de verdad) y vuelve al panel.
// Mientras prueba no tiene acceso al panel; nadie más puede usar estos modos.
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
const plate = `SA${rnd.slice(0, 4)}`;
let adminId = null;

// Un viaje completo: el pasajero `ps` pide y el conductor `ds` lo lleva
async function ride(ps, ds) {
  const rideNew = next(ds, 'ride:new');
  const ack = await emitAck(ps, 'ride:request', { origin, dest, price: 100 });
  if (!ack?.ok) throw new Error(`no se pudo pedir: ${ack?.error}`);
  const rn = await rideNew;
  const offer = next(ps, 'offer:new');
  ds.emit('offer:make', { rideId: rn.id, price: 100 });
  const o = await offer;
  const accepted = next(ps, 'ride:state', (r) => r.status === 'accepted');
  ps.emit('offer:accept', { offerId: o.id });
  const r = await accepted;
  let last;
  for (const st of ['arrived', 'started', 'completed']) {
    const moved = next(ps, 'ride:state', (x) => x.status === st);
    ds.emit('ride:status', { rideId: r.id, status: st });
    last = await moved;
  }
  return last;
}

try {
  await pool.query('UPDATE users SET staff_mode = NULL WHERE id = ?', [root.id]);
  await pool.query('DELETE FROM vehicles WHERE driver_id = ?', [root.id]);
  await http('POST', 'admin/bank-accounts', SA, { bank: 'Banco 43', type: 'Ahorros', number: `43-${rnd}`, holder: 'Ktracho GO' }); // la comisión exige una cuenta para recargar
  const set = await http('PUT', 'admin/settings', SA, { min_balance: -500, commission_enabled: true, commission_percent: 10 });
  check('la comisión queda encendida para la prueba', set.commission_enabled === '1', JSON.stringify(set.error || ''));

  // ---------- Pasajero ----------
  const asP = await http('POST', 'me/staff-mode', SA, { mode: 'passenger' });
  check('el superadmin pasa a modo pasajero', asP.user?.role === 'passenger' && asP.user?.staffMode === 'passenger' && asP.user?.isSuperadmin === true, JSON.stringify(asP.error || asP.user?.role));
  check('mientras prueba no entra al panel', (await http('GET', 'admin/settings', SA)).status === 403);
  check('usa funciones de pasajero (contactos de confianza)', (await http('GET', 'contacts', SA)).status === 200);
  check('no puede «pedir ser conductor» desde ahí', (await http('POST', 'me/apply-driver', SA, { model: 'Yaris', plate: 'XX9999' })).status === 403);
  check('ni usar el cambio de modo de los conductores', (await http('POST', 'me/mode', SA, { mode: 'driver' })).status === 403);
  const me = await http('GET', 'me', SA);
  check('al abrir la app sigue en modo pasajero', me.user?.role === 'passenger' && me.user?.staffMode === 'passenger' && me.user?.isSuperadmin === true, JSON.stringify(me.user && { r: me.user.role, m: me.user.staffMode }));
  check('no le pide aceptar los términos de pasajero', me.user?.mustAcceptTerms === false);

  // Pide un viaje de verdad y un conductor real lo lleva
  const D = await registerUser({ name: 'Dora C43', phone: `9${rnd}437`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HD${rnd.slice(0, 4)}` });
  await pool.query('UPDATE users SET staff_mode = NULL WHERE id = ?', [root.id]); // el panel para aprobar a la conductora…
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  await pool.query("UPDATE users SET staff_mode = 'passenger' WHERE id = ?", [root.id]); // …y de vuelta a probar
  const ds = track(await connect(D.token));
  ds.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(500);
  const sas = track(await connect(SA));
  const r1 = await ride(sas, ds);
  check('como pasajero hace un viaje completo con una conductora real', r1?.status === 'completed' && r1.passenger_id === root.id, JSON.stringify({ st: r1?.status }));
  ds.close();
  sas.close();

  // ---------- Conductor ----------
  const noVeh = await http('POST', 'me/staff-mode', SA, { mode: 'driver' });
  check('para manejar primero pide el vehículo', noVeh.status === 400 && noVeh.code === 'NEED_VEHICLE', JSON.stringify(noVeh));
  check('sigue en modo pasajero mientras tanto', (await http('GET', 'me', SA)).user?.staffMode === 'passenger');
  const bad = await http('POST', 'me/staff-mode', SA, { mode: 'driver', vehicle: { category: 'car', model: '', plate } });
  check('valida el vehículo', bad.status === 400);
  const asD = await http('POST', 'me/staff-mode', SA, { mode: 'driver', vehicle: { category: 'car', make: 'Toyota', model: 'Yaris', plate } });
  check('con el vehículo pasa a modo conductor, sin documentos ni aprobación', asD.user?.role === 'driver' && asD.user?.staffMode === 'driver' && asD.user?.status === 'active' && asD.user?.plate === plate, JSON.stringify(asD.error || ''));
  check('ve su saldo de conductor', (await http('GET', 'driver/wallet', SA)).status === 200);
  check('ya no usa funciones de pasajero', (await http('GET', 'contacts', SA)).status === 403);

  // Se pone disponible y lleva a un pasajero real
  const P = await registerUser({ name: 'Pepe C43', phone: `8${rnd}431`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const ps = track(await connect(P.token));
  const sad = track(await connect(SA));
  const denied = next(sad, 'driver:denied', () => true, 1500).catch(() => null);
  sad.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  const d = await denied;
  check('puede ponerse disponible', !d, JSON.stringify(d));
  const r2 = await ride(ps, sad);
  check('como conductor lleva a un pasajero real hasta el final', r2?.status === 'completed' && r2.driver_id === root.id, JSON.stringify({ st: r2?.status }));
  await wait(500);
  const [[fee]] = await pool.query("SELECT COUNT(*) AS n FROM wallet_entries WHERE user_id = ? AND ride_id = ?", [root.id, r2.id]).catch(() => [[{ n: -1 }]]);
  check('se le cobra la comisión como a cualquier conductor', fee.n >= 1, String(fee.n));

  // Con un viaje en curso no puede cambiar de modo
  const rideNew = next(sad, 'ride:new');
  await emitAck(ps, 'ride:request', { origin, dest, price: 90 });
  const rn = await rideNew;
  const offer = next(ps, 'offer:new');
  sad.emit('offer:make', { rideId: rn.id, price: 90 });
  const o = await offer;
  const acc = next(ps, 'ride:state', (r) => r.status === 'accepted');
  ps.emit('offer:accept', { offerId: o.id });
  await acc;
  check('con un viaje en curso no puede volver al panel', (await http('POST', 'me/staff-mode', SA, { mode: 'panel' })).status === 409);
  const cancelled = next(ps, 'ride:state', (r) => r.status === 'cancelled');
  sad.emit('ride:cancel', { rideId: rn.id, reason: 'Prueba' });
  await cancelled.catch(() => pool.query("UPDATE rides SET status = 'cancelled', cancelled_by = 'system' WHERE id = ?", [rn.id]));

  // ---------- Volver al panel ----------
  const closed = next(sad, 'account:mode', () => true, 3000).catch(() => null);
  const back = await http('POST', 'me/staff-mode', SA, { mode: 'panel' });
  check('vuelve al panel', back.user?.role === 'superadmin' && back.user?.staffMode === null, JSON.stringify(back.error || back.user?.role));
  check('sus otras pestañas se enteran del cambio', (await closed)?.role === 'superadmin');
  check('el panel vuelve a funcionar', (await http('GET', 'admin/settings', SA)).status === 200);
  await wait(400);
  const [[online]] = await pool.query('SELECT COUNT(*) AS n FROM driver_sessions WHERE driver_id = ? AND ended_at IS NULL', [root.id]).catch(() => [[{ n: 0 }]]);
  check('al volver deja de estar disponible', online.n === 0, String(online.n));
  const again = await http('POST', 'me/staff-mode', SA, { mode: 'driver' });
  check('la próxima vez entra como conductor sin volver a pedir el vehículo', again.user?.role === 'driver', JSON.stringify(again.error || ''));
  await http('POST', 'me/staff-mode', SA, { mode: 'panel' });
  const [audit] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE actor_id = ? AND action = 'staff.mode' AND created_at > NOW() - INTERVAL 5 MINUTE", [root.id]);
  check('cada cambio queda en el registro', audit[0].n >= 4, String(audit[0].n));

  // ---------- Solo el superadmin ----------
  check('un pasajero no puede', (await http('POST', 'me/staff-mode', P.token, { mode: 'driver' })).status === 403);
  check('un conductor no puede', (await http('POST', 'me/staff-mode', D.token, { mode: 'passenger' })).status === 403);
  const adm = await http('POST', 'admin/staff', SA, { name: 'Ana C43', phone: `5${rnd}432`.slice(0, 8), role: 'admin' });
  adminId = adm.id;
  const ADM = jwt.sign({ id: adm.id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  check('un administrador tampoco', (await http('POST', 'me/staff-mode', ADM, { mode: 'passenger' })).status === 403);
  check('modo inválido', (await http('POST', 'me/staff-mode', SA, { mode: 'admin' })).status === 400);

  // ---------- Ajustes: los permisos por rol se guardan en la misma tabla y no deben romper el guardado ----------
  const roles = (await http('GET', 'admin/permissions', SA)).roles;
  await http('PUT', 'admin/permissions/passenger', SA, { perms: roles.passenger }); // crea role_perms si no existía
  const { status: _st, ...all } = await http('GET', 'admin/settings', SA);
  check('Ajustes no devuelve los permisos por rol (dato interno)', !('role_perms' in all) && 'tips_enabled' in all, Object.keys(all).filter((k) => !/^[a-z0-9_]+$/.test(k)).join());
  const resave = await http('PUT', 'admin/settings', SA, { ...all, commission_enabled: all.commission_enabled === '1', rental_enabled: all.rental_enabled === '1' });
  check('guardar Ajustes tal como llegan funciona aunque existan permisos por rol', resave.status === 200 && !('role_perms' in resave), JSON.stringify(resave.error || ''));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
  await pool.query('UPDATE users SET staff_mode = NULL WHERE id = ?', [root.id]);
  await pool.query("UPDATE rides SET status = 'cancelled', cancelled_by = 'system' WHERE status IN ('requested','accepted','arrived','started') AND (passenger_id = ? OR driver_id = ?)", [root.id, root.id]);
  await pool.query('DELETE FROM vehicles WHERE driver_id = ?', [root.id]);
  if (adminId) await pool.query('DELETE FROM users WHERE id = ?', [adminId]).catch(() => {});
  await http('PUT', 'admin/settings', SA, { min_balance: Number(before.min_balance), commission_enabled: before.commission_enabled === '1', commission_percent: Number(before.commission_percent) });
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
