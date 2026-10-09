import 'dotenv/config';
// Prueba de punta a punta: pedir -> ofertar -> aceptar -> llegó -> iniciar -> finalizar
import { io } from 'socket.io-client';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { registerUser, uploadDocs } from './helpers.mjs';

const API = 'http://localhost:4000';
// Token de admin firmado con el mismo secreto que usa el servidor (para probar los endpoints /api/admin)
const [[adm]] = await pool.query("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1");
const adminToken = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const adminPost = async (path, body) => {
  const r = await fetch(`${API}/api/admin/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}` }, body: JSON.stringify(body || {}) });
  return { status: r.status, ...(await r.json()) };
};
const rnd = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
const post = async (p, b) => (await fetch(`${API}/api/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const once = (s, ev, ms = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error(`timeout esperando ${ev}`)), ms);
  s.once(ev, (d) => { clearTimeout(t); res(d); });
});
const until = (s, ev, pred, ms = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout esperando ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

const D = await registerUser({ name: 'Test Driver', phone: `9${rnd}`, password: 'secreto1', role: 'driver', vehicle: 'Corolla', plate: 'HAA1234' });
const P = await registerUser({ name: 'Test Pasajero', phone: `8${rnd}`, password: 'secreto1', role: 'passenger' });
check('registro', D.token && P.token);

const ds = io(API, { auth: { token: D.token } });
const ps = io(API, { auth: { token: P.token } });
await Promise.all([once(ds, 'connect'), once(ps, 'connect')]);

const origin = { lat: 14.0723, lng: -87.1921, text: 'A' };
const dest = { lat: 14.1000, lng: -87.2000, text: 'B' };

// Un conductor recién registrado está pendiente y no puede conectarse
check('conductor nuevo queda pendiente', D.user.status === 'pending');
const denied = once(ds, 'driver:denied');
ds.emit('driver:online', { lat: 14.0730, lng: -87.1925 });
check('conductor pendiente no puede ponerse disponible', (await denied).status === 'pending');
check('usuario sin permisos no accede al admin', (await fetch(`${API}/api/admin/stats`, { headers: { Authorization: `Bearer ${P.token}` } })).status === 403);

check('no se puede aprobar sin los 3 documentos', (await adminPost(`users/${D.user.id}/status`, { status: 'active' })).status === 409);
await uploadDocs(D.token);
const approved = once(ds, 'account:status');
check('admin aprueba al conductor', (await adminPost(`users/${D.user.id}/status`, { status: 'active' })).ok === true);
check('conductor recibe la aprobación', (await approved).status === 'active');

ds.emit('driver:online', { lat: 14.0730, lng: -87.1925 });
ps.emit('passenger:location', origin);
// driver:online consulta la base antes de registrar al conductor; la lista se refresca cada 3 s
const near = await until(ps, 'drivers:nearby', (l) => l.some((d) => d.id === D.user.id), 6000).catch(() => []);
check('pasajero ve conductor libre', near.some((d) => d.id === D.user.id));

const newRide = once(ds, 'ride:new');
const offerNew = once(ps, 'offer:new');
ps.emit('ride:request', { origin, dest, price: 80 }, () => {});
const ride = await newRide;
check('conductor recibe solicitud', ride.offered_price === 80, `(L${ride.offered_price})`);

ds.emit('offer:make', { rideId: ride.id, price: 90 });
const offer = await offerNew;
check('pasajero recibe contraoferta', offer.price === 90);

const accepted = once(ds, 'ride:state');
ps.emit('offer:accept', { offerId: offer.id });
const st = await accepted;
check('viaje aceptado a precio final', st.status === 'accepted' && st.final_price === 90);

const locP = once(ps, 'ride:driver_location');
ds.emit('driver:location', { lat: 14.0725, lng: -87.1922 });
check('pasajero sigue al conductor', !!(await locP));

for (const s of ['arrived', 'started', 'completed']) {
  const upd = once(ps, 'ride:state');
  ds.emit('ride:status', { rideId: ride.id, status: s });
  check(`estado ${s}`, (await upd).status === s);
}

// Un conductor ya libre otra vez debe seguir apareciendo
ps.emit('passenger:location', origin);
check('conductor vuelve a estar libre', (await until(ps, 'drivers:nearby', (l) => l.some((d) => d.id === D.user.id), 6000).catch(() => [])).length > 0);

// Cancelación
const r2 = once(ds, 'ride:new');
ps.emit('ride:request', { origin, dest, price: 60 }, () => {});
const ride2 = await r2;
const cancelled = until(ps, 'ride:state', (r) => r.status === 'cancelled');
ps.emit('ride:cancel', { rideId: ride2.id });
check('cancelación', (await cancelled).status === 'cancelled');

// El conductor cancela un viaje aceptado
{
  const rq = once(ds, 'ride:new');
  const offer = once(ps, 'offer:new');
  ps.emit('ride:request', { origin, dest, price: 65 }, () => {});
  const rd = await rq;
  ds.emit('offer:make', { rideId: rd.id, price: 65 });
  ps.emit('offer:accept', { offerId: (await offer).id });
  await until(ds, 'ride:state', (r) => r.status === 'accepted');
  const gone = until(ps, 'ride:state', (r) => r.status === 'cancelled');
  ds.emit('ride:driver_cancel', { rideId: rd.id });
  check('conductor cancela y el pasajero se entera', (await gone).cancelled_by === 'driver');
  ps.emit('passenger:location', origin);
  check('conductor vuelve a estar libre tras cancelar', (await until(ps, 'drivers:nearby', (l) => l.some((d) => d.id === D.user.id), 6000).catch(() => [])).length > 0);
}

// El admin cancela un viaje activo
{
  const rq = once(ds, 'ride:new');
  ps.emit('ride:request', { origin, dest, price: 55 }, () => {});
  const rd = await rq;
  const gone = until(ps, 'ride:state', (r) => r.status === 'cancelled');
  check('admin cancela viaje', (await adminPost(`rides/${rd.id}/cancel`)).ok === true);
  check('pasajero ve cancelación del admin', (await gone).cancelled_by === 'admin');
  check('admin no puede cancelar dos veces', (await adminPost(`rides/${rd.id}/cancel`)).status === 409);
}

// Validaciones
const ack = (ev, payload) => new Promise((res) => ps.emit(ev, payload, res));
check('rechaza precio negativo', (await ack('ride:request', { origin, dest, price: -5 })).error);
check('rechaza precio absurdo', (await ack('ride:request', { origin, dest, price: 999999 })).error);
check('rechaza coordenadas inválidas', (await ack('ride:request', { origin: { lat: 999, lng: 0 }, dest, price: 50 })).error);
check('rechaza destino igual al origen', (await ack('ride:request', { origin, dest: origin, price: 50 })).error);
check('rechaza teléfono inválido', (await post('register', { name: 'X', phone: 'abc', password: 'secreto1', role: 'passenger' })).error);

// Ofertas repetidas del mismo conductor se actualizan, no se duplican
const r3 = once(ds, 'ride:new');
ps.emit('ride:request', { origin, dest, price: 70 }, () => {});
const ride3 = await r3;
const seen = [];
ps.on('offer:new', (o) => seen.push(o));
ds.emit('offer:make', { rideId: ride3.id, price: 75 });
ds.emit('offer:make', { rideId: ride3.id, price: 72 });
await wait(600);
check('oferta repetida reutiliza el mismo id', seen.length === 2 && seen[0].id === seen[1].id && seen[1].price === 72);
ps.emit('ride:cancel', { rideId: ride3.id });
await wait(300);

// El admin bloquea al conductor: se desconecta y no puede volver a entrar
{
  const off = once(ds, 'disconnect');
  check('admin bloquea al conductor', (await adminPost(`users/${D.user.id}/status`, { status: 'blocked' })).ok === true);
  await off;
  check('conductor bloqueado es desconectado', true);
  const login = await fetch(`${API}/api/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: D.user.phone, password: 'secreto1' }) });
  check('conductor bloqueado no puede iniciar sesión', login.status === 403);
  check('nadie puede bloquear a un superadministrador (ni a sí mismo)', (await adminPost(`users/${adm.id}/status`, { status: 'blocked' })).status === 403);
}

ds.close(); ps.close();
await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
