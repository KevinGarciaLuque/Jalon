import 'dotenv/config';
// Fase 8A: notificaciones push. Un servicio de notificaciones falso (local) recibe los envíos para comprobar qué se manda, a quién, cifrado y firmado.
import crypto from 'crypto';
import http from 'http';
import { createRequire } from 'module';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http as api, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

const ece = createRequire(import.meta.url)('http_ece');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

const PUB = process.env.VAPID_PUBLIC_KEY;
if (!PUB || !process.env.VAPID_PRIVATE_KEY) { console.log('SKIP: el servidor necesita VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY (npm run vapid). `npm test` las genera solo.'); process.exit(0); }

// ---- servicio de notificaciones falso: cada "dispositivo" es una dirección local con sus propias llaves ----
const received = []; // { id, headers, body }
const statusFor = new Map(); // id -> código de respuesta (por defecto 201)
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const id = req.url.split('/').pop();
    received.push({ id, headers: req.headers, body: Buffer.concat(chunks) });
    res.writeHead(statusFor.get(id) ?? 201).end();
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${fake.address().port}`;

function device(id) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return {
    id,
    subscription: { endpoint: `${base}/push/${id}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } },
    // Mensajes que llegaron a este dispositivo, ya descifrados
    messages: () => received.filter((m) => m.id === id).map((m) => JSON.parse(ece.decrypt(m.body, { version: 'aes128gcm', privateKey: ecdh, authSecret: auth.toString('base64url') }).toString())),
    raw: () => received.filter((m) => m.id === id),
  };
}
const subscribe = (token, dev) => api('POST', 'push/subscribe', token, { subscription: dev.subscription });
const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const phone = (p) => `${p}${rnd}9`.slice(0, 8);

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
// Una persona de soporte (sin permiso de aprobar conductores)
const [supRow] = await pool.query("INSERT INTO users (name, phone, password_hash, role, status, totp_enabled, terms_accepted_at) VALUES ('T Soporte', ?, ?, 'support', 'active', 1, NOW())", [phone('55'), await bcrypt.hash('no-se-usa-1', 4)]);
const SUP = jwt.sign({ id: supRow.insertId, role: 'support' }, process.env.JWT_SECRET, { expiresIn: '10m' });

// ================= Suscripciones =================
const P = await registerUser({ name: 'P8 Pasajero', phone: phone('88'), password: 'Cielo-azul-77', role: 'passenger' });
const pDev = device('pasajero');
check('la llave pública para suscribirse llega al cliente', (await api('GET', 'push/key', P.token)).key === PUB);
check('suscribirse exige sesión', (await api('POST', 'push/subscribe', null, { subscription: pDev.subscription })).status === 401);
check('se rechaza una dirección de internet cualquiera (evita usar el servidor para atacar a otros)', (await api('POST', 'push/subscribe', P.token, { subscription: { ...pDev.subscription, endpoint: 'https://evil.example.com/x' } })).status === 400);
check('se rechaza una dirección interna', (await api('POST', 'push/subscribe', P.token, { subscription: { ...pDev.subscription, endpoint: 'http://169.254.169.254/latest/meta-data' } })).status === 400);
check('se rechaza una que imita a Google', (await api('POST', 'push/subscribe', P.token, { subscription: { ...pDev.subscription, endpoint: 'https://fcm.googleapis.com.evil.com/send/abc' } })).status === 400);
check('se rechazan llaves inválidas', (await api('POST', 'push/subscribe', P.token, { subscription: { endpoint: pDev.subscription.endpoint, keys: { p256dh: 'x', auth: 'y' } } })).status === 400);
check('el pasajero se suscribe', (await subscribe(P.token, pDev)).ok === true);
check('la misma suscripción no se duplica', (await subscribe(P.token, pDev)).ok === true && (await pool.query('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [P.user.id]))[0][0].n === 1);

const tmp = device('temporal');
await subscribe(P.token, tmp);
check('darse de baja elimina el dispositivo', (await api('POST', 'push/unsubscribe', P.token, { endpoint: tmp.subscription.endpoint })).ok === true && (await pool.query('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [P.user.id]))[0][0].n === 1);
const Pother = await registerUser({ name: 'P8 Pasajero', phone: phone('87'), password: 'Cielo-azul-77', role: 'passenger' });
await api('POST', 'push/unsubscribe', Pother.token, { endpoint: pDev.subscription.endpoint });
check('nadie puede dar de baja el dispositivo de otra persona', (await pool.query('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [P.user.id]))[0][0].n === 1);
for (let i = 0; i < 12; i++) await subscribe(Pother.token, device(`muchos${i}`));
check('como máximo 10 dispositivos por persona', (await pool.query('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [Pother.user.id]))[0][0].n === 10);

// ================= Conductores =================
async function newDriver(name, ph, plate) {
  const d = await registerUser({ name, phone: ph, password: 'Cielo-azul-77', role: 'driver', vehicle: 'Hilux', plate });
  await uploadDocs(d.token);
  await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [d.user.id]);
  return d;
}
const D1 = await newDriver('P8 Conductor', phone('86'), 'HJJ0001'); // cerrará la app con notificaciones activas
const D2 = await newDriver('P8 Conductor', phone('85'), 'HJJ0002'); // tendrá la app abierta
const d1Dev = device('conductor-cerrado');
const d2Dev = device('conductor-abierto');
await subscribe(D1.token, d1Dev);
await subscribe(D2.token, d2Dev);

const connect = async (token) => { const s = io(API, { auth: { token } }); await new Promise((r) => s.once('connect', r)); return s; };
const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.1, lng: -87.2, text: 'Mall Multiplaza' };

const d1s = await connect(D1.token);
const d2s = await connect(D2.token);
d1s.emit('driver:online', { lat: 14.073, lng: -87.1925 });
d2s.emit('driver:online', { lat: 14.0731, lng: -87.1926 });
await wait(600);
d1s.close(); // D1 cierra la app: sigue "disponible" para avisos, pero ya no aparece en el mapa
await wait(600);

const ps = await connect(P.token);
const nearby = new Promise((r) => ps.once('drivers:nearby', r));
ps.emit('passenger:location', origin);
const list = await nearby;
check('el conductor que cerró la app ya no aparece en el mapa del pasajero (el que la tiene abierta sí)', !list.some((d) => d.id === D1.user.id) && list.some((d) => d.id === D2.user.id));

// ---- Viaje nuevo: avisa al que cerró la app, no al que la tiene abierta ----
const rideNew = new Promise((r) => d2s.once('ride:new', r));
ps.emit('ride:request', { origin, dest, price: 80 }, () => {});
const ride = await rideNew;
await wait(900);
const got = d1Dev.messages();
check('el conductor con la app cerrada recibe la notificación del viaje nuevo', got.length === 1 && got[0].title === 'Nuevo viaje cerca de ti' && got[0].body.includes('Mall Multiplaza') && got[0].body.includes('L 80') && got[0].tag === `ride-${ride.id}`);
check('el conductor con la app abierta NO recibe notificación (ya lo ve en pantalla)', d2Dev.raw().length === 0);
const raw = d1Dev.raw()[0];
check('el envío va cifrado y firmado (VAPID)', raw.headers['content-encoding'] === 'aes128gcm' && /^vapid t=.+, k=/.test(raw.headers.authorization) && raw.headers.authorization.includes(PUB) && raw.headers.ttl === '3600' && raw.headers.urgency === 'high');
check('el contenido no viaja en claro', !raw.body.toString('utf8').includes('Mall Multiplaza'));

// ---- Oferta: el pasajero con la app cerrada se entera ----
ps.close();
await wait(600);
const before = pDev.messages().length;
d2s.emit('offer:make', { rideId: ride.id, price: 90 });
await wait(900);
const offerMsg = pDev.messages().slice(before);
check('el pasajero con la app cerrada recibe la oferta', offerMsg.length === 1 && offerMsg[0].title === 'Nueva oferta para tu viaje' && offerMsg[0].body.includes('P8 Conductor') && offerMsg[0].body.includes('L 90'));

// ---- Llegada y cancelación ----
const ps2 = await connect(P.token);
// Al reconectarse el servidor reenvía el estado del viaje; se espera específicamente el estado "aceptado"
const accepted = new Promise((r) => { const h = (s) => { if (s.status === 'accepted') { ps2.off('ride:state', h); r(s); } }; ps2.on('ride:state', h); });
const [[offerRow]] = await pool.query('SELECT id FROM offers WHERE ride_id = ? ORDER BY id DESC LIMIT 1', [ride.id]);
ps2.emit('offer:accept', { offerId: offerRow.id });
await accepted;
ps2.close();
await wait(600);
const beforeArrive = pDev.messages().length;
d2s.emit('ride:status', { rideId: ride.id, status: 'arrived' });
await wait(900);
const arrive = pDev.messages().slice(beforeArrive);
check('al llegar el conductor, el pasajero con la app cerrada recibe aviso con su vehículo y placa', arrive.length === 1 && arrive[0].title === 'Tu conductor llegó' && arrive[0].body.includes('HJJ0002'));

// ---- Emergencia: llega al celular del personal ----
const supDev = device('soporte');
const rootDev = device('superadmin');
await subscribe(SUP, supDev);
await subscribe(SA, rootDev);
const ps3 = await connect(P.token);
const sos = await new Promise((res) => ps3.emit('ride:sos', origin, res));
await wait(1000);
check('el botón de emergencia avisa al celular de todo el personal', sos.ok === true && supDev.messages().some((m) => m.title === '🆘 EMERGENCIA' && m.body.includes('P8 Pasajero')) && rootDev.messages().some((m) => m.title === '🆘 EMERGENCIA'));
check('y no a conductores ni pasajeros', d1Dev.messages().every((m) => !m.title.includes('EMERGENCIA')));
ps3.close();

// ---- Cancelación del conductor ----
const beforeCancel = pDev.messages().length;
d2s.emit('ride:driver_cancel', { rideId: ride.id });
await wait(900);
check('si el conductor cancela, el pasajero con la app cerrada lo sabe', pDev.messages().slice(beforeCancel).some((m) => m.title === 'Viaje cancelado'));
d2s.close();

// ---- Dispositivos que ya no existen se limpian solos ----
const dead = device('muerto');
await subscribe(P.token, dead);
statusFor.set('muerto', 410); // el servicio de notificaciones responde "este dispositivo ya no existe"
check('el pasajero tiene 2 dispositivos', (await pool.query('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [P.user.id]))[0][0].n === 2);
const ps4 = await connect(P.token);
const requested = new Promise((r) => { const h = (s) => { if (s.status === 'requested') { ps4.off('ride:state', h); r(s); } }; ps4.on('ride:state', h); });
ps4.emit('ride:request', { origin, dest, price: 70 }, () => {});
const r2 = await requested;
ps4.close();
await wait(600);
const beforeAdmin = pDev.messages().length;
check('el personal cancela un viaje', (await api('POST', `admin/rides/${r2.id}/cancel`, SA, {})).ok === true);
await wait(1000);
check('el pasajero ausente recibe el aviso de cancelación', pDev.messages().slice(beforeAdmin).some((m) => m.title === 'Viaje cancelado'));
check('el dispositivo que respondió 410 se borra solo; el que funciona se conserva', (await pool.query('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [P.user.id]))[0][0].n === 1);

// ---- Un conductor completa sus documentos: avisa a quien puede aprobarlo ----
const newbie = await registerUser({ name: 'P8 Nuevo', phone: phone('84'), password: 'Cielo-azul-77', role: 'driver', vehicle: 'X', plate: 'Y' });
const rootBefore = rootDev.messages().length;
const supBefore = supDev.messages().length;
await uploadDocs(newbie.token);
await wait(1000);
check('al completar los 3 documentos avisa al personal que puede aprobar', rootDev.messages().slice(rootBefore).some((m) => m.title === 'Nueva solicitud de conductor' && m.body.includes('P8 Nuevo')));
check('soporte (sin permiso de aprobar) no recibe ese aviso', supDev.messages().slice(supBefore).every((m) => m.title !== 'Nueva solicitud de conductor'));

fake.close();
await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
