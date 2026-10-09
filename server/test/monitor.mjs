import 'dotenv/config';
// Fase 10: monitoreo de conductores (mapa en vivo y ficha de rendimiento) con permiso concedido por el superadmin
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const phone = (p) => `${p}${rnd}9`.slice(0, 8);
const connect = async (token) => { const s = io(API, { auth: { token } }); await new Promise((r) => s.once('connect', r)); return s; };
const next = (s, ev, pred = () => true, ms = 6000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout esperando ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
const tok = (id, role) => jwt.sign({ id, role }, process.env.JWT_SECRET, { expiresIn: '10m' });

const root = await createTestSuperadmin(pool);
const SA = tok(root.id, 'superadmin');
const mkStaff = async (role, name, p) => {
  const [r] = await pool.query("INSERT INTO users (name, phone, password_hash, role, status, totp_enabled, terms_accepted_at) VALUES (?, ?, ?, ?, 'active', 1, NOW())", [name, phone(p), await bcrypt.hash('no-se-usa-1', 4), role]);
  return { id: r.insertId, token: tok(r.insertId, role) };
};
const ADM = await mkStaff('admin', 'T Admin', '54');
const SUP = await mkStaff('support', 'T Soporte', '53');

// ================= Permiso =================
check('sin sesión no se ve el mapa', (await http('GET', 'admin/monitor', null)).status === 401);
check('soporte no ve el mapa', (await http('GET', 'admin/monitor', SUP.token)).status === 403);
check('un administrador nuevo tampoco, hasta que el superadmin se lo dé', (await http('GET', 'admin/monitor', ADM.token)).status === 403);
check('el superadmin sí', (await http('GET', 'admin/monitor', SA)).status === 200);
const permsOf = async (t) => (await http('GET', 'admin/users', t)).perms || [];
check('el panel del superadmin incluye el permiso monitor', (await permsOf(SA)).includes('monitor'));
check('el del administrador no', !(await permsOf(ADM.token)).includes('monitor'));

check('el administrador no puede darse el permiso', (await http('POST', `admin/staff/${ADM.id}/monitor`, ADM.token, { enabled: true })).status === 403);
check('soporte tampoco puede dar permisos', (await http('POST', `admin/staff/${ADM.id}/monitor`, SUP.token, { enabled: true })).status === 403);
check('no se da a soporte', (await http('POST', `admin/staff/${SUP.id}/monitor`, SA, { enabled: true })).status === 400);
check('exige un valor verdadero o falso', (await http('POST', `admin/staff/${ADM.id}/monitor`, SA, { enabled: 'si' })).status === 400);
check('el superadmin se lo da al administrador', (await http('POST', `admin/staff/${ADM.id}/monitor`, SA, { enabled: true })).ok === true);
check('ahora el administrador ve el mapa', (await http('GET', 'admin/monitor', ADM.token)).status === 200);
check('y su panel muestra la pestaña (permiso en la lista)', (await permsOf(ADM.token)).includes('monitor'));
check('soporte sigue sin verlo', (await http('GET', 'admin/monitor', SUP.token)).status === 403);
check('se lo quita y deja de verlo', (await http('POST', `admin/staff/${ADM.id}/monitor`, SA, { enabled: false })).ok === true && (await http('GET', 'admin/monitor', ADM.token)).status === 403);
await http('POST', `admin/staff/${ADM.id}/monitor`, SA, { enabled: true });
await http('POST', `admin/staff/${ADM.id}/role`, SA, { role: 'support' });
await http('POST', `admin/staff/${ADM.id}/role`, SA, { role: 'admin' });
check('al cambiarle el rol pierde el permiso (no se hereda)', (await http('GET', 'admin/monitor', ADM.token)).status === 403);
await http('POST', `admin/staff/${ADM.id}/monitor`, SA, { enabled: true });

// ================= Mapa en vivo =================
const P = await registerUser({ name: 'P10M Pasajero', phone: phone('88'), password: 'Cielo-azul-77', role: 'passenger' });
const D = await registerUser({ name: 'P10M Conductor', phone: phone('87'), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Hilux', plate: 'HMM0001' });
await uploadDocs(D.token);
await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
const ps = await connect(P.token);
const ds = await connect(D.token);
const snap = async (t = ADM.token) => http('GET', 'admin/monitor', t);
const mine = (s) => (s.drivers || []).find((d) => d.id === D.user.id);

check('un conductor sin conectar no aparece', !mine(await snap()));
ds.emit('driver:online', { lat: 14.073, lng: -87.1925 });
await wait(500);
const s1 = await snap();
check('al conectarse aparece libre en el mapa, con su placa y posición', mine(s1)?.state === 'free' && mine(s1).plate === 'HMM0001' && mine(s1).lat === 14.073 && mine(s1).lng === -87.1925, JSON.stringify(mine(s1)));
check('el resumen cuenta un conductor libre', s1.counts.free >= 1);
ds.emit('driver:location', { lat: 14.08, lng: -87.19 });
await wait(400);
const s1b = await snap();
check('su posición se actualiza', mine(s1b)?.lat === 14.08);
check('indica hace cuántos segundos se supo de él', mine(s1b)?.seenSecondsAgo <= 5);

const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.1, lng: -87.2, text: 'Mall Multiplaza' };
const reqd = next(ps, 'ride:state', (r) => r.status === 'requested');
ps.emit('ride:request', { origin, dest, price: 80 }, () => {});
const rd = await reqd;
const s2 = await snap();
check('la solicitud sin conductor aparece como pendiente en el mapa', (s2.waiting || []).some((w) => w.id === rd.id && w.lat === origin.lat && w.price === 80));
check('sin revelar quién la pide', !JSON.stringify(s2.waiting).includes('P10M Pasajero'));
const offerP = next(ps, 'offer:new');
ds.emit('offer:make', { rideId: rd.id, price: 80 });
const offer = await offerP;
const acc = next(ps, 'ride:state', (r) => r.status === 'accepted');
ps.emit('offer:accept', { offerId: offer.id });
await acc;
const s3 = await snap();
check('con viaje aceptado pasa a ocupado con los datos del viaje', mine(s3)?.state === 'busy' && mine(s3).ride?.id === rd.id && mine(s3).ride.status === 'accepted' && mine(s3).ride.passenger === 'P10M Pasajero' && mine(s3).ride.dest.text === 'Mall Multiplaza' && mine(s3).ride.price === 80);
check('y la solicitud ya no figura como pendiente', !(s3.waiting || []).some((w) => w.id === rd.id));
for (const st of ['arrived', 'started', 'completed']) { const u = next(ps, 'ride:state', (r) => r.status === st); ds.emit('ride:status', { rideId: rd.id, status: st }); await u; }
await wait(300);
const s4 = await snap();
check('al terminar el viaje vuelve a estar libre', mine(s4)?.state === 'free' && mine(s4).ride === null);

// ================= Ficha de rendimiento =================
const f = await http('GET', `admin/monitor/drivers/${D.user.id}`, ADM.token);
check('la ficha trae los datos del conductor', f.driver?.name === 'P10M Conductor' && f.driver.plate === 'HMM0001');
check('cuenta el viaje completado y lo ganado', f.last30?.completed === 1 && f.last30.earned === 80 && f.completedTotal === 1, JSON.stringify(f.last30));
check('tasa de aceptación de sus ofertas', f.last30?.offersMade === 1 && f.last30.offersAccepted === 1 && f.last30.acceptanceRate === 100);
check('cuenta cancelaciones y reportes en cero', f.last30?.cancelledByDriver === 0 && f.reports?.total === 0 && f.reports.open === 0);
check('el administrador (con permiso de dinero) ve saldo y comisión', typeof f.balance === 'number' && typeof f.last30.commission === 'number');
check('trae sus últimos viajes', f.recent?.length === 1 && f.recent[0].status === 'completed' && f.recent[0].price === 80);
check('y su estado en vivo', f.live?.state === 'free' && f.live.lat === 14.08);
check('soporte no ve la ficha', (await http('GET', `admin/monitor/drivers/${D.user.id}`, SUP.token)).status === 403);
check('un pasajero no tiene ficha de conductor', (await http('GET', `admin/monitor/drivers/${P.user.id}`, ADM.token)).status === 404);
check('un número que no existe tampoco', (await http('GET', 'admin/monitor/drivers/99999999', ADM.token)).status === 404);

// Cancelación por el conductor y calificación
const reqd2 = next(ps, 'ride:state', (r) => r.status === 'requested');
ps.emit('ride:request', { origin, dest, price: 60 }, () => {});
const rd2 = await reqd2;
const o2 = next(ps, 'offer:new');
ds.emit('offer:make', { rideId: rd2.id, price: 60 });
const offer2 = await o2;
const a2 = next(ps, 'ride:state', (r) => r.status === 'accepted');
ps.emit('offer:accept', { offerId: offer2.id });
await a2;
const c2 = next(ps, 'ride:state', (r) => r.status === 'cancelled');
ds.emit('ride:driver_cancel', { rideId: rd2.id });
await c2;
await pool.query('INSERT INTO ratings (ride_id, rater_id, ratee_id, stars) VALUES (?,?,?,5)', [rd.id, P.user.id, D.user.id]);
const f2 = await http('GET', `admin/monitor/drivers/${D.user.id}`, SA);
check('cuenta la cancelación hecha por el conductor', f2.last30?.cancelledByDriver === 1 && f2.last30.cancelled === 1);
check('y la calificación promedio', f2.rating?.avg === 5 && f2.rating.count === 1);
check('lo cancelado no suma ganancias', f2.last30.earned === 80);

// ================= Conexión perdida y registro =================
ds.disconnect();
await wait(600);
check('sin conexión ni notificaciones desaparece del mapa', !mine(await snap()));

const [audit] = await pool.query("SELECT action, COUNT(*) AS n FROM audit_log WHERE actor_id = ? AND action IN ('monitor.view','monitor.driver') GROUP BY action", [ADM.id]);
const n = Object.fromEntries(audit.map((a) => [a.action, a.n]));
check('abrir el mapa muchas veces deja una sola anotación', n['monitor.view'] === 1, JSON.stringify(n));
check('y abrir la ficha de un conductor también', n['monitor.driver'] === 1);
const [grants] = await pool.query("SELECT details FROM audit_log WHERE action = 'staff.monitor' AND actor_id = ? ORDER BY id", [root.id]);
check('cada vez que el superadmin da o quita el permiso queda anotado', grants.length >= 3 && JSON.parse(grants[0].details).enabled === true);

ps.disconnect();
await pool.end();
console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK');
process.exit(fails ? 1 : 0);
