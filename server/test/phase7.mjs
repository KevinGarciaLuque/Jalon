import 'dotenv/config';
// Fase 7: seguridad. Documentos (metadatos, cifrado), contraseñas, sesiones y pruebas de ataque.
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { sanitizeJpeg } from '../src/jpeg.js';
import { encryptLegacyDocuments } from '../src/docs.js';
import { API, FIXTURE, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const phone = (prefix) => `${prefix}${rnd}9`.slice(0, 8);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const UPLOADS = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;
const contains = (buf, text) => buf.includes(Buffer.from(text, 'latin1'));

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

// ================= JPEG: metadatos, cola escondida y estructura =================
const segment = (marker, payload) => { const h = Buffer.alloc(4); h.writeUInt8(0xff, 0); h.writeUInt8(marker, 1); h.writeUInt16BE(payload.length + 2, 2); return Buffer.concat([h, payload]); };
const withExtras = Buffer.concat([
  FIXTURE.subarray(0, 2),
  segment(0xe1, Buffer.from('Exif\0\0GPSLatitude=14.0723;GPSLongitude=-87.1921;Make=TelefonoDelConductor', 'latin1')),
  segment(0xfe, Buffer.from('comentario-secreto', 'latin1')),
  FIXTURE.subarray(2),
  Buffer.from('PK\x03\x04archivo-escondido-despues-del-fin', 'latin1'),
]);
check('el JPEG de prueba trae ubicación, comentario y un archivo escondido', contains(withExtras, 'GPSLatitude') && contains(withExtras, 'comentario-secreto') && contains(withExtras, 'PK\x03\x04'));
const clean = sanitizeJpeg(withExtras);
check('se quitan la ubicación, el modelo del teléfono y los comentarios', !contains(clean.buf, 'GPSLatitude') && !contains(clean.buf, 'Exif') && !contains(clean.buf, 'comentario') && !contains(clean.buf, 'Make='));
check('se descarta lo escondido después del fin de la imagen', !contains(clean.buf, 'PK\x03\x04') && clean.buf[clean.buf.length - 2] === 0xff && clean.buf[clean.buf.length - 1] === 0xd9);
check('la imagen limpia conserva sus dimensiones', clean.width === 96 && clean.height === 64);
check('una foto sin metadatos queda igual de válida', sanitizeJpeg(FIXTURE).buf.length > 500);
const throws = (b) => { try { sanitizeJpeg(b); return false; } catch { return true; } };
check('rechaza datos que no son un JPEG', throws(Buffer.from('esto no es una imagen, solo texto de relleno')) && throws(Buffer.alloc(0)));
check('rechaza un JPEG cortado (sin final)', throws(FIXTURE.subarray(0, FIXTURE.length - 50)));
check('rechaza un JPEG sin datos de imagen', throws(Buffer.concat([FIXTURE.subarray(0, 2), segment(0xe0, Buffer.from('JFIF\0')), Buffer.from([0xff, 0xd9])])));
const huge = Buffer.from(FIXTURE);
const sof = huge.indexOf(Buffer.from([0xff, 0xc0]));
huge.writeUInt16BE(20000, sof + 5); huge.writeUInt16BE(20000, sof + 7);
check('rechaza imágenes con dimensiones absurdas', throws(huge));

// ================= Documentos por la API: cifrados y sin metadatos =================
const D = await registerUser({ name: 'P7 Conductor', phone: phone('88'), password: 'secreto1', role: 'driver', vehicle: 'Hilux', plate: 'HGG0001' });
const P = await registerUser({ name: 'P7 Pasajero', phone: phone('87'), password: 'secreto1', role: 'passenger' });
check('la API acepta una foto con metadatos', (await http('PUT', 'driver/documents/photo', D.token, { image: dataUrl(withExtras) })).ok === true);
check('la API rechaza un JPG con cabecera correcta pero contenido falso', (await http('PUT', 'driver/documents/license', D.token, { image: dataUrl(Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(300, 7)])) })).status === 400);
check('la API rechaza una ruta falsa en el tipo de documento', (await http('PUT', 'driver/documents/..%2F..%2Fetc', D.token, { image: dataUrl(FIXTURE) })).status === 400);
await http('PUT', 'driver/documents/license', D.token, { image: dataUrl(FIXTURE) });
await http('PUT', 'driver/documents/registration', D.token, { image: dataUrl(FIXTURE) });

const files = fs.readdirSync(UPLOADS).filter((f) => f.startsWith(`${D.user.id}-`));
check('los archivos se guardan con extensión .enc', files.length === 3 && files.every((f) => f.endsWith('.enc')));
const raw = fs.readFileSync(path.join(UPLOADS, files.find((f) => f.includes('-photo-'))));
check('el archivo en disco está cifrado (no es un JPEG legible)', raw.subarray(0, 3).toString() === 'JE1' && !contains(raw, 'JFIF') && !contains(raw, 'GPSLatitude') && !(raw[0] === 0xff && raw[1] === 0xd8));

const docs = await http('GET', `admin/users/${D.user.id}/documents`, SA);
const photoDoc = docs.find((d) => d.type === 'photo');
const dl = async (id) => { const r = await fetch(`${API}/api/admin/documents/${id}/file`, { headers: { Authorization: `Bearer ${SA}` } }); return { status: r.status, type: r.headers.get('content-type'), body: Buffer.from(await r.arrayBuffer()) }; };
const got = await dl(photoDoc.id);
check('el admin recibe la imagen descifrada y sin metadatos', got.status === 200 && got.type === 'image/jpeg' && got.body[0] === 0xff && got.body[1] === 0xd8 && !contains(got.body, 'GPSLatitude') && got.body.equals(clean.buf));
await dl(docs[1].id); await dl(docs[2].id); await dl(photoDoc.id);
const [views] = await pool.query("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'doc.view' AND target_user_id = ?", [D.user.id]);
check('abrir documentos queda anotado una sola vez (sin repetir)', views[0].n === 1, `(${views[0].n})`);
const ranked = await http('GET', 'admin/audit', SA);
check('el registro muestra quién abrió los documentos', ranked.some((l) => l.action === 'doc.view' && l.target_name === 'P7 Conductor'));

// Si alguien altera el archivo en disco, no se entrega
const tampered = Buffer.from(raw); tampered[tampered.length - 5] ^= 0xff;
const photoFile = path.join(UPLOADS, files.find((f) => f.includes('-photo-')));
fs.writeFileSync(photoFile, tampered);
check('un archivo alterado en disco no se entrega', (await dl(photoDoc.id)).status === 500);
fs.writeFileSync(photoFile, raw);
check('restaurado el archivo, vuelve a entregarse', (await dl(photoDoc.id)).status === 200);

// Documentos antiguos (guardados sin cifrar): se limpian y se cifran al arrancar
const legacyName = `${D.user.id}-license-legacy.jpg`;
fs.writeFileSync(path.join(UPLOADS, legacyName), withExtras);
const oldLic = docs.find((d) => d.type === 'license');
const [[oldRow]] = await pool.query('SELECT file FROM documents WHERE id = ?', [oldLic.id]);
await pool.query('UPDATE documents SET file = ? WHERE id = ?', [legacyName, oldLic.id]);
fs.rmSync(path.join(UPLOADS, oldRow.file), { force: true });
const migrated = await encryptLegacyDocuments(UPLOADS);
const [[after]] = await pool.query('SELECT file FROM documents WHERE id = ?', [oldLic.id]);
check('la migración cifra los documentos antiguos', migrated >= 1 && after.file.endsWith('.enc') && !fs.existsSync(path.join(UPLOADS, legacyName)));
const lic = await dl(oldLic.id);
check('el documento migrado se entrega limpio', lic.status === 200 && !contains(lic.body, 'GPSLatitude') && !contains(lic.body, 'PK\x03\x04'));
check('una segunda migración no hace nada', (await encryptLegacyDocuments(UPLOADS)) === 0);

// ================= Contraseñas =================
const base = { name: 'P7 Pasajero', role: 'passenger', acceptTerms: true };
const tryPw = async (pw, ph) => { const o = await http('POST', 'otp/send', null, { phone: ph }); return http('POST', 'register', null, { ...base, phone: ph, password: pw, code: o.devCode }); };
const weakPhone = phone('86');
check('rechaza contraseñas cortas', (await tryPw('abc123', weakPhone)).status === 400);
check('rechaza contraseñas de solo números', (await tryPw('87654322', phone('85'))).status === 400);
check('rechaza contraseñas comunes', (await tryPw('password1', phone('84'))).status === 400);
check('rechaza contraseñas demasiado simples', (await tryPw('aaaaaaaa1', phone('83'))).status === 400);
const containsPhone = phone('82');
check('rechaza una contraseña que contiene el teléfono', (await tryPw(`x${containsPhone}x`, containsPhone)).status === 400);
check('acepta una contraseña razonable', !!(await tryPw('Cielo-azul-77', phone('81'))).token);
await pool.query("UPDATE users SET name = 'P7 Pasajero' WHERE phone = ?", [phone('81')]);

// ================= Sesiones =================
const decode = (t) => jwt.decode(t);
const session = await http('POST', 'login', null, { phone: P.user.phone, password: 'secreto1' });
const life = decode(session.token);
check('la sesión de un pasajero dura 30 días', life.exp - life.iat === 30 * 24 * 3600);
const staff = await http('POST', 'admin/staff', SA, { name: 'P7 Soporte', phone: phone('80'), role: 'support' });
const staffLogin = await http('POST', 'login', null, { phone: phone('80'), password: staff.tempPassword });
const slife = decode(staffLogin.token);
check('la sesión del personal dura solo 12 horas', slife.exp - slife.iat === 12 * 3600);
check('el personal necesita una contraseña de 10 caracteres', (await http('POST', 'password/change', staffLogin.token, { current: staff.tempPassword, password: 'Corta-9x' })).status === 400);

const other = await http('POST', 'login', null, { phone: P.user.phone, password: 'secreto1' });
const all = await http('POST', 'logout-all', session.token, {});
check('cerrar sesión en todos los dispositivos devuelve un token nuevo', all.ok === true && !!all.token);
check('el resto de las sesiones queda invalidado', (await http('GET', 'rides/mine', session.token)).status === 401 && (await http('GET', 'rides/mine', other.token)).status === 401);
check('el token nuevo sigue funcionando', (await http('GET', 'rides/mine', all.token)).status === 200);
const hdr = (await fetch(`${API}/api/health`)).headers;
check('el navegador solo puede usar la ubicación (no cámara ni micrófono)', /geolocation=\(self\)/.test(hdr.get('permissions-policy') || '') && /camera=\(\)/.test(hdr.get('permissions-policy') || ''));

// ================= Ataques =================
const forge = (claims, opts = {}) => jwt.sign(claims, opts.secret || 'otra-llave', { expiresIn: opts.exp ?? '5m', algorithm: opts.alg || 'HS256' });
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const noneToken = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ id: root.id, role: 'superadmin', tv: 0 })}.`;
const expired = jwt.sign({ id: root.id, role: 'superadmin', tv: 0 }, process.env.JWT_SECRET, { expiresIn: -10 });
for (const [label, token] of [['sin firma (alg none)', noneToken], ['firmado con otra llave', forge({ id: root.id, role: 'superadmin', tv: 0 })], ['vencido', expired], ['basura', 'abc.def.ghi']]) {
  check(`el panel rechaza un token ${label}`, (await http('GET', 'admin/stats', token)).status === 401);
}
check('un token con el rol cambiado a mano no da acceso al panel', (await http('GET', 'admin/stats', jwt.sign({ id: P.user.id, role: 'superadmin', tv: decode(all.token).tv }, process.env.JWT_SECRET))).status === 403);

const inj = await http('POST', 'login', null, { phone: "' OR '1'='1' -- ", password: "' OR '1'='1" });
check('un intento de inyección SQL en el login se trata como datos', inj.status === 401);
check('inyección SQL en un parámetro de la URL no rompe nada', (await http('GET', `places?q=${encodeURIComponent("'; DROP TABLE users; --")}`, P.token)).status !== 500);
const [[stillUsers]] = await pool.query('SELECT COUNT(*) AS n FROM users');
check('las tablas siguen ahí', stillUsers.n > 0);

const escalate = await http('POST', 'otp/send', null, { phone: phone('79') });
check('no se puede registrar a alguien como superadministrador', (await http('POST', 'register', null, { name: 'Hacker', phone: phone('79'), password: 'Cielo-azul-77', role: 'superadmin', acceptTerms: true, code: escalate.devCode })).status === 400);
const sneaky = await http('POST', 'otp/send', null, { phone: phone('78') });
const sneakyReg = await http('POST', 'register', null, { name: 'P7 Conductor', phone: phone('78'), password: 'Cielo-azul-77', role: 'driver', vehicle: 'X', plate: 'Y', status: 'active', acceptTerms: true, code: sneaky.devCode });
check('un conductor no puede registrarse ya aprobado (el estado se ignora)', sneakyReg.user?.status === 'pending');
const patched = await http('PATCH', `admin/users/${P.user.id}`, SA, { name: 'P7 Pasajero', phone: P.user.phone, role: 'superadmin', status: 'blocked' });
const [[roleNow]] = await pool.query('SELECT role, status FROM users WHERE id = ?', [P.user.id]);
check('editar un usuario no permite cambiarle el rol ni el estado', roleNow.role === 'passenger' && roleNow.status === 'active', `(${patched.status})`);

// Rutas del panel: sin sesión 401, con sesión de pasajero 403
const adminRoutes = [
  ['GET', 'admin/stats'], ['GET', 'admin/users'], ['GET', 'admin/rides'], ['GET', 'admin/audit'], ['GET', 'admin/alerts'],
  ['GET', `admin/users/${D.user.id}`], ['GET', `admin/users/${D.user.id}/documents`], ['GET', `admin/documents/${photoDoc.id}/file`],
  ['PATCH', `admin/users/${P.user.id}`], ['POST', `admin/users/${P.user.id}/status`], ['POST', `admin/users/${P.user.id}/reset-password`],
  ['POST', `admin/users/${P.user.id}/delete`], ['POST', 'admin/staff'], ['POST', 'admin/staff/1/role'], ['POST', 'admin/rides/1/cancel'],
  ['POST', 'admin/alerts/1/resolve'], ['POST', `admin/documents/${photoDoc.id}/reject`],
];
const noAuth = await Promise.all(adminRoutes.map(([m, p]) => http(m, p, null, m === 'GET' ? undefined : { status: 'active' })));
const asPassenger = await Promise.all(adminRoutes.map(([m, p]) => http(m, p, all.token, m === 'GET' ? undefined : { status: 'active' })));
check(`las ${adminRoutes.length} rutas del panel exigen sesión (401)`, noAuth.every((r) => r.status === 401), `(${noAuth.map((r) => r.status).filter((s) => s !== 401)})`);
check(`las ${adminRoutes.length} rutas del panel rechazan a un pasajero (403)`, asPassenger.every((r) => r.status === 403), `(${asPassenger.map((r) => r.status).filter((s) => s !== 403)})`);

// Un pasajero no puede operar sobre los viajes y ofertas de otro
const DRV = await registerUser({ name: 'P7 Conductor', phone: phone('77'), password: 'secreto1', role: 'driver', vehicle: 'Civic', plate: 'HGG0002' });
await uploadDocs(DRV.token);
await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [DRV.user.id]);
const P2 = await registerUser({ name: 'P7 Pasajero', phone: phone('76'), password: 'secreto1', role: 'passenger' });
const ds = io(API, { auth: { token: DRV.token } });
const ps = io(API, { auth: { token: all.token } });
const p2s = io(API, { auth: { token: P2.token } });
await Promise.all([ds, ps, p2s].map((s) => new Promise((r) => s.once('connect', r))));
const origin = { lat: 14.0723, lng: -87.1921, text: 'A' };
ds.emit('driver:online', { lat: 14.073, lng: -87.1925 });
await wait(700);
const rideSeen = new Promise((r) => ds.once('ride:new', r));
ps.emit('ride:request', { origin, dest: { lat: 14.1, lng: -87.2, text: 'B' }, price: 80 }, () => {});
const ride = await rideSeen;
const offerSeen = new Promise((r) => ps.once('offer:new', r));
ds.emit('offer:make', { rideId: ride.id, price: 80 });
const offer = await offerSeen;
p2s.emit('offer:accept', { offerId: offer.id }); // otro pasajero intenta aceptar la oferta
p2s.emit('ride:cancel', { rideId: ride.id }); // y cancelar el viaje ajeno
p2s.emit('offer:make', { rideId: ride.id, price: 1 }); // y ofertar como si fuera conductor
p2s.emit('ride:status', { rideId: ride.id, status: 'arrived' });
await wait(800);
const [[rideNow]] = await pool.query('SELECT status, driver_id FROM rides WHERE id = ?', [ride.id]);
const [[offersNow]] = await pool.query('SELECT COUNT(*) AS n FROM offers WHERE ride_id = ?', [ride.id]);
check('otro pasajero no puede aceptar, cancelar ni ofertar sobre un viaje ajeno', rideNow.status === 'requested' && !rideNow.driver_id && offersNow.n === 1);
check('otro pasajero no puede compartir ni calificar un viaje ajeno', (await http('POST', `rides/${ride.id}/share`, P2.token)).status === 404 && (await http('POST', `rides/${ride.id}/rate`, P2.token, { stars: 1 })).status === 404);
check('un conductor no puede subir documentos a nombre de otro (el token manda)', (await http('PUT', 'driver/documents/photo', P2.token, { image: dataUrl(FIXTURE) })).status === 403);

ps.emit('ride:cancel', { rideId: ride.id });
await wait(500);
[ds, ps, p2s].forEach((s) => s.close());

await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
