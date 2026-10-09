import 'dotenv/config';
// Fase 6: los SMS de emergencia llegan al equipo, se repiten si nadie atiende y paran al resolverse
import fs from 'fs';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

const LOG = new URL('../.sms-dev.log', import.meta.url);
const sms = () => (fs.existsSync(LOG) ? fs.readFileSync(LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const until = (s, ev, pred, ms = 8000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout esperando ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

const phones = (process.env.SOS_ALERT_PHONES || '').split(',').filter(Boolean);
if (phones.length < 2) { console.log('SKIP: define SOS_ALERT_PHONES con 2 teléfonos de prueba en server/.env'); process.exit(0); }

const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

check('el panel sabe cuántos teléfonos reciben las emergencias', (await http('GET', 'admin/stats', SA)).sosPhones === phones.length);

// Un viaje en curso entre un conductor y un pasajero
const D = await registerUser({ name: 'P6 Conductor', phone: `9${rnd}9`.slice(0, 8), password: 'secreto1', role: 'driver', vehicle: 'Hilux', plate: 'HFF0001' });
const P = await registerUser({ name: 'P6 Pasajero', phone: `8${rnd}9`.slice(0, 8), password: 'secreto1', role: 'passenger' });
await uploadDocs(D.token);
await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [D.user.id]);
const ds = io(API, { auth: { token: D.token } });
const ps = io(API, { auth: { token: P.token } });
await Promise.all([until(ds, 'connect', () => true), until(ps, 'connect', () => true)]);
const origin = { lat: 14.0723, lng: -87.1921, text: 'A' };
ds.emit('driver:online', { lat: 14.073, lng: -87.1925 });
await wait(600);
const rq = until(ds, 'ride:new', () => true);
ps.emit('ride:request', { origin, dest: { lat: 14.1, lng: -87.2, text: 'B' }, price: 80 }, () => {});
const ride = await rq;
const offer = until(ps, 'offer:new', () => true);
ds.emit('offer:make', { rideId: ride.id, price: 80 });
ps.emit('offer:accept', { offerId: (await offer).id });
await until(ps, 'ride:state', (r) => r.status === 'accepted');

// ---- Aviso inmediato ----
const before = sms().length;
const ack = (s, pos) => new Promise((res) => s.emit('ride:sos', pos, res));
check('el pasajero pulsa el botón de emergencia', (await ack(ps, origin)).ok === true);
check('el conductor también', (await ack(ds, { lat: 14.0731, lng: -87.1926 })).ok === true);
await wait(1500);
const sent = sms().slice(before);
check('cada alerta avisa a cada teléfono del equipo (2 alertas x 2 teléfonos)', sent.length === 4, `(${sent.length})`);
const first = sent.find((m) => m.body.includes('P6 Pasajero'));
check('el SMS dice quién pide ayuda, su teléfono y el mapa', !!first && first.body.includes(P.user.phone) && first.body.includes('maps.google.com/?q=14.0723,-87.1921') && first.body.startsWith('JALON SOS'));
check('el SMS no gasta caracteres de más (una sola parte, sin tildes ni emojis)', sent.every((m) => m.body.length <= 160 && /^[\x20-\x7e]+$/.test(m.body)), `(${Math.max(...sent.map((m) => m.body.length))} caracteres)`);
check('van al número internacional de Honduras', sent.every((m) => /^\+504\d{8}$/.test(m.to)));

// ---- Recordatorio: solo mientras la emergencia siga abierta ----
const alerts = (await http('GET', 'admin/alerts', SA)).filter((a) => a.ride_id === ride.id);
check('el panel ve las 2 emergencias abiertas', alerts.length === 2);
const [resolvedAlert, openAlert] = alerts;
check('el equipo atiende una de ellas', (await http('POST', `admin/alerts/${resolvedAlert.id}/resolve`, SA, {})).ok === true);
await pool.query('UPDATE alerts SET last_notified_at = NOW() - INTERVAL 10 MINUTE WHERE ride_id = ?', [ride.id]); // como si hubieran pasado 10 minutos
const mark = sms().length;
console.log('… esperando el recordatorio (hasta 40 s)');
for (let i = 0; i < 40 && sms().length === mark; i++) await wait(1000);
await wait(1500);
const reminders = sms().slice(mark);
check('la emergencia sin atender se vuelve a avisar', reminders.length === 2 && reminders.every((m) => m.body.startsWith('RECORDATORIO JALON SOS')), `(${reminders.length})`);
check('el recordatorio es de la alerta abierta, no de la atendida', reminders.every((m) => m.body.includes(`#${openAlert.id}:`)) && reminders.every((m) => !m.body.includes(`#${resolvedAlert.id}:`)));
const [[row]] = await pool.query('SELECT notified_count FROM alerts WHERE id = ?', [openAlert.id]);
check('queda anotado cuántas veces se avisó', row.notified_count === 2);

// Tras el tope de avisos deja de insistir
await pool.query('UPDATE alerts SET notified_count = 4, last_notified_at = NOW() - INTERVAL 10 MINUTE WHERE id = ?', [openAlert.id]);
const mark2 = sms().length;
await wait(35000);
check('después de 4 avisos deja de insistir', sms().length === mark2);

ds.close(); ps.close();
await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
