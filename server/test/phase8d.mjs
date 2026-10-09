import 'dotenv/config';
// Fase 8D: lugares favoritos, contactos de confianza, recibos y reportes
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin, startFakePush } from './helpers.mjs';

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
const SMS_LOG = new URL('../.sms-dev.log', import.meta.url);
const sms = () => (fs.existsSync(SMS_LOG) ? fs.readFileSync(SMS_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const fake = await startFakePush();
const hasPush = !!process.env.VAPID_PUBLIC_KEY;

const P = await registerUser({ name: 'P8D Pasajera Lopez', phone: phone('88'), password: 'Cielo-azul-77', role: 'passenger' });
const D = await registerUser({ name: 'P8D Conductor', phone: phone('87'), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Hilux', plate: 'HNN0001' });
const X = await registerUser({ name: 'P8D Otro', phone: phone('86'), password: 'Cielo-azul-77', role: 'passenger' });
await uploadDocs(D.token);
await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [D.user.id]);

// ================= Lugares favoritos =================
const casa = { label: 'Casa', text: 'Colonia Kennedy, Tegucigalpa', lat: 14.0723, lng: -87.1921 };
check('los favoritos exigen sesión', (await http('GET', 'favorites', null)).status === 401);
check('se guarda "Casa"', (await http('POST', 'favorites', P.token, casa)).ok === true);
check('un lugar sin coordenadas válidas se rechaza', (await http('POST', 'favorites', P.token, { ...casa, label: 'Mal', lat: 999 })).status === 400);
check('un lugar sin nombre se rechaza', (await http('POST', 'favorites', P.token, { ...casa, label: '  ' })).status === 400);
await http('POST', 'favorites', P.token, { label: 'Trabajo', text: 'Mall Multiplaza', lat: 14.088, lng: -87.183 });
check('con el mismo nombre se actualiza en vez de duplicar', (await http('POST', 'favorites', P.token, { ...casa, text: 'Mi casa nueva', lat: 14.08 })).ok === true && (await http('GET', 'favorites', P.token)).length === 2);
const favs = await http('GET', 'favorites', P.token);
check('la lista trae nombre, lugar y coordenadas', favs.find((f) => f.label === 'Casa').text === 'Mi casa nueva' && favs.find((f) => f.label === 'Casa').lat === 14.08);
for (let i = 0; i < 8; i++) await http('POST', 'favorites', P.token, { label: `Lugar ${i}`, text: 'x', lat: 14.1, lng: -87.2 });
check('máximo 10 lugares', (await http('POST', 'favorites', P.token, { label: 'Uno de más', text: 'x', lat: 14.1, lng: -87.2 })).status === 409);
check('pero se puede actualizar uno existente estando en el límite', (await http('POST', 'favorites', P.token, { ...casa, text: 'otra vez' })).ok === true);
check('cada persona ve solo los suyos', (await http('GET', 'favorites', X.token)).length === 0);
const otherFav = favs[0].id;
await http('DELETE', `favorites/${otherFav}`, X.token);
check('nadie borra los favoritos de otra persona', (await http('GET', 'favorites', P.token)).length === 10);
await http('DELETE', `favorites/${otherFav}`, P.token);
check('se puede borrar uno propio', (await http('GET', 'favorites', P.token)).length === 9);

// ================= Contactos de confianza =================
check('los contactos exigen sesión', (await http('GET', 'contacts', null)).status === 401);
check('un conductor no tiene contactos de confianza', (await http('GET', 'contacts', D.token)).status === 403);
check('un teléfono inválido se rechaza', (await http('POST', 'contacts', P.token, { name: 'Mamá', phone: 'abc' })).status === 400);
check('no se puede agregar el propio teléfono', (await http('POST', 'contacts', P.token, { name: 'Yo', phone: P.user.phone })).status === 400);
const mama = phone('77');
const added = await http('POST', 'contacts', P.token, { name: 'Mamá', phone: `+504 ${mama.slice(0, 4)}-${mama.slice(4)}` });
check('se agrega un contacto (el teléfono se normaliza)', added.ok === true && (await http('GET', 'contacts', P.token))[0].phone === mama);
check('el mismo contacto no se repite', (await http('POST', 'contacts', P.token, { name: 'Mamá otra vez', phone: mama })).status === 409);
await http('POST', 'contacts', P.token, { name: 'Hermano', phone: phone('76') });
await http('POST', 'contacts', P.token, { name: 'Amiga', phone: phone('75') });
check('máximo 3 contactos', (await http('POST', 'contacts', P.token, { name: 'Cuarto', phone: phone('74') })).status === 409);
const amiga = (await http('GET', 'contacts', P.token)).find((c) => c.name === 'Amiga');
await http('DELETE', `contacts/${amiga.id}`, X.token);
check('nadie borra los contactos de otra persona', (await http('GET', 'contacts', P.token)).length === 3);
await http('DELETE', `contacts/${amiga.id}`, P.token);
check('se puede borrar uno propio', (await http('GET', 'contacts', P.token)).length === 2);

// ================= Un viaje: los contactos reciben el enlace al empezar =================
const ps = await connect(P.token);
const ds = await connect(D.token);
const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.1, lng: -87.2, text: 'Mall Multiplaza' };
ds.emit('driver:online', { lat: 14.073, lng: -87.1925 });
await wait(500);
const reqd = next(ps, 'ride:state', (r) => r.status === 'requested');
ps.emit('ride:request', { origin, dest, price: 80 }, () => {});
const ride = await reqd;
const offerP = next(ps, 'offer:new');
ds.emit('offer:make', { rideId: ride.id, price: 80 });
const offer = await offerP;
const acc = next(ps, 'ride:state', (r) => r.status === 'accepted');
ps.emit('offer:accept', { offerId: offer.id });
await acc;
const before = sms().length;
for (const st of ['arrived']) { const u = next(ps, 'ride:state', (r) => r.status === st); ds.emit('ride:status', { rideId: ride.id, status: st }); await u; }
await wait(400);
check('antes de empezar el viaje no se avisa a los contactos', sms().length === before);
const started = next(ps, 'ride:state', (r) => r.status === 'started');
ds.emit('ride:status', { rideId: ride.id, status: 'started' });
await started;
await wait(1200);
const sent = sms().slice(before);
check('al empezar el viaje cada contacto recibe un SMS', sent.length === 2 && sent.every((m) => /^\+504\d{8}$/.test(m.to)) && sent.some((m) => m.to === `+504${mama}`));
check('el SMS dice quién viaja y trae el enlace para seguirlo', sent.every((m) => m.body.startsWith('Jalon: P8D inicio un viaje') && /\/t\/[\w-]{16,}$/.test(m.body)));
check('el SMS es barato (una parte, sin tildes ni emojis)', sent.every((m) => /^[\x20-\x7e]+$/.test(m.body) && m.body.length <= 200), `(${sent[0]?.body.length} caracteres)`);
const link = sent[0].body.match(/\/t\/([\w-]+)$/)[1];
const tr = await http('GET', `track/${link}`);
check('el enlace funciona y muestra el viaje en curso, sin datos personales de más', tr.status === 'started' && tr.driver?.name === 'P8D' && !JSON.stringify(tr).includes(D.user.phone) && !JSON.stringify(tr).includes(P.user.phone));
const sameLinks = new Set(sent.map((m) => m.body.match(/\/t\/([\w-]+)$/)[1]));
check('todos reciben el mismo enlace', sameLinks.size === 1);

// ================= Recibo =================
check('un viaje en curso todavía no tiene recibo', (await http('GET', `rides/${ride.id}/receipt`, P.token)).status === 409);
const done = next(ps, 'ride:state', (r) => r.status === 'completed');
ds.emit('ride:status', { rideId: ride.id, status: 'completed' });
await done;
const rc = await http('GET', `rides/${ride.id}/receipt`, P.token);
check('el recibo trae número, fecha, personas, vehículo, recorrido, precio y forma de pago', rc.number === `JAL-${String(ride.id).padStart(6, '0')}` && rc.driver === 'P8D Conductor' && rc.plate === 'HNN0001' && rc.origin === 'Colonia Kennedy' && rc.dest === 'Mall Multiplaza' && rc.price === 80 && rc.payment === 'Efectivo' && !!rc.date);
check('el conductor también puede ver el recibo', (await http('GET', `rides/${ride.id}/receipt`, D.token)).price === 80);
check('otra persona no puede ver el recibo', (await http('GET', `rides/${ride.id}/receipt`, X.token)).status === 404);
check('el recibo exige sesión', (await http('GET', `rides/${ride.id}/receipt`, null)).status === 401);

// ================= Reportes =================
const staffPush = fake.device('personal');
if (hasPush) await http('POST', 'push/subscribe', SA, { subscription: staffPush.subscription });
check('reportar exige sesión', (await http('POST', `rides/${ride.id}/report`, null, { type: 'lost_item', text: 'x'.repeat(10) })).status === 401);
check('otra persona no puede reportar un viaje ajeno', (await http('POST', `rides/${ride.id}/report`, X.token, { type: 'lost_item', text: 'dejé algo en el carro' })).status === 404);
check('hay que elegir un tipo válido', (await http('POST', `rides/${ride.id}/report`, P.token, { type: 'inventado', text: 'dejé algo en el carro' })).status === 400);
check('y contar qué pasó', (await http('POST', `rides/${ride.id}/report`, P.token, { type: 'lost_item', text: 'hola' })).status === 400);
const rep = await http('POST', `rides/${ride.id}/report`, P.token, { type: 'lost_item', text: 'Dejé mi celular negro en el asiento de atrás' });
check('el pasajero reporta un objeto olvidado', rep.ok === true && rep.id > 0);
await wait(900);
if (hasPush) check('el personal recibe una notificación del reporte nuevo', staffPush.messages().some((m) => m.title === 'Nuevo reporte' && m.body.includes('Objeto olvidado')));
const mine = await http('GET', 'reports/mine', P.token);
check('la persona ve su reporte como abierto', mine[0].status === 'open' && mine[0].type === 'lost_item');
check('cada persona ve solo sus reportes', (await http('GET', 'reports/mine', X.token)).length === 0);
const drep = await http('POST', `rides/${ride.id}/report`, D.token, { type: 'behavior', text: 'El pasajero dejó el carro muy sucio' });
check('el conductor también puede reportar', drep.ok === true);

check('los reportes del panel exigen personal', (await http('GET', 'admin/reports', P.token)).status === 403 && (await http('GET', 'admin/reports', null)).status === 401);
const open = await http('GET', 'admin/reports', SA);
const mineRep = open.find((r) => r.id === rep.id);
check('el personal ve el reporte con los datos de las dos personas para contactarlas', mineRep && mineRep.reporter === 'P8D Pasajera Lopez' && mineRep.reporter_phone === P.user.phone && mineRep.other === 'P8D Conductor' && mineRep.other_phone === D.user.phone && mineRep.type_label === 'Objeto olvidado');
check('el contador de reportes abiertos aparece en las estadísticas', (await http('GET', 'admin/stats', SA)).openReports >= 2);
check('con un reporte, el personal puede leer el chat del viaje (sin emergencia)', (await http('GET', `admin/rides/${ride.id}/chat`, SA)).status === 200);
check('resolver exige explicar cómo', (await http('POST', `admin/reports/${rep.id}/resolve`, SA, { resolution: 'ok' })).status === 400);
const pPush = fake.device('pasajera');
if (hasPush) await http('POST', 'push/subscribe', P.token, { subscription: pPush.subscription });
ps.close();
await wait(500);
check('el personal resuelve el reporte', (await http('POST', `admin/reports/${rep.id}/resolve`, SA, { resolution: 'Se contactó al conductor y devolverá el celular hoy' })).ok === true);
check('no se puede resolver dos veces', (await http('POST', `admin/reports/${rep.id}/resolve`, SA, { resolution: 'otra vez otra vez' })).status === 409);
await wait(900);
if (hasPush) check('la persona recibe la respuesta aunque tenga la app cerrada', pPush.messages().some((m) => m.title === 'Tu reporte fue atendido' && m.body.includes('devolverá el celular')));
const after = await http('GET', 'reports/mine', P.token);
check('la persona ve la respuesta del personal', after[0].status === 'resolved' && after[0].resolution.includes('devolverá'));
check('los reportes resueltos salen de la lista de abiertos y están en el historial', !(await http('GET', 'admin/reports', SA)).some((r) => r.id === rep.id) && (await http('GET', 'admin/reports?status=resolved', SA)).some((r) => r.id === rep.id));
const audit = await http('GET', 'admin/audit', SA);
check('queda anotado quién resolvió', audit.some((a) => a.action === 'report.resolve' && a.details?.report === rep.id));
let spam = 0;
for (let i = 0; i < 6; i++) spam = (await http('POST', `rides/${ride.id}/report`, P.token, { type: 'other', text: `reporte repetido número ${i}` })).status;
check('no se pueden enviar reportes sin límite', spam === 429);

// ================= Tus datos =================
const exp = await http('GET', 'me/export', P.token);
check('descargar mis datos incluye favoritos, contactos y reportes', exp.lugaresFavoritos.length === 9 && exp.contactosDeConfianza.length === 2 && exp.reportes.length >= 1 && exp.reportes[0].texto.includes('celular negro'));
const del = await http('POST', 'me/delete', P.token, { password: 'Cielo-azul-77' });
check('la persona elimina su cuenta', del.ok === true);
const counts = await Promise.all([
  pool.query('SELECT COUNT(*) AS n FROM favorite_places WHERE user_id = ?', [P.user.id]),
  pool.query('SELECT COUNT(*) AS n FROM trusted_contacts WHERE user_id = ?', [P.user.id]),
  pool.query("SELECT COUNT(*) AS n FROM reports WHERE user_id = ? AND text <> '[reporte eliminado]'", [P.user.id]),
]);
check('se borran sus favoritos, sus contactos y el texto de sus reportes', counts.every(([[c]]) => c.n === 0));

ds.close();
fake.stop();
await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
