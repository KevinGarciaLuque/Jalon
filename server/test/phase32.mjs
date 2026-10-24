import 'dotenv/config';
// Etapa 9.3: selfie del conductor para conectarse; el personal la compara y, si no coincide, se bloquea la cuenta
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { UPLOADS } from '../src/config.js';
import { API, FIXTURE, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const IMG = `data:image/jpeg;base64,${FIXTURE.toString('base64')}`;
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
// ¿Lo deja ponerse disponible? Devuelve lo que responde el servidor si lo niega, o null
const tryOnline = (s) => new Promise((res) => { const h = (d) => res(d); s.once('driver:denied', h); s.emit('driver:online', { lat: 14.073, lng: -87.1925 }); setTimeout(() => { s.off('driver:denied', h); res(null); }, 800); });
const sockets = [];

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const [sup] = await pool.query("INSERT INTO users (name, phone, password_hash, role, status, totp_enabled, terms_accepted_at) VALUES ('T Soporte 32', ?, ?, 'support', 'active', 1, NOW())", [`53${rnd}2`.slice(0, 8), await bcrypt.hash('no-se-usa-1', 4)]);
const SUP = jwt.sign({ id: sup.insertId, role: 'support' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);

try {
  await http('PUT', 'admin/settings', SA, { driver_selfie_required: true, driver_selfie_hours: 12 });
  const D = await registerUser({ name: 'C32 Conductor', phone: `93${rnd}2`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HF3${rnd.slice(0, 4)}` });
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  const ds = await connect(D.token);
  sockets.push(ds);

  check('sin selfie no puede ponerse disponible', (await tryOnline(ds))?.status === 'selfie');
  check('una selfie que no es foto se rechaza', (await http('POST', 'driver/selfie', D.token, { image: 'data:image/jpeg;base64,AAAA' })).status === 400);
  check('un pasajero no sube selfies', (await http('POST', 'driver/selfie', (await registerUser({ name: 'C32 P', phone: `83${rnd}2`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' })).token, { image: IMG })).status === 403);
  // Una foto de tamaño real (unos 60 KB, como la de un celular): antes el servidor la rechazaba con «Solicitud inválida»
  const seg = (n) => { const b = Buffer.alloc(n + 4, 0x20); b[0] = 0xff; b[1] = 0xfe; b.writeUInt16BE(n + 2, 2); return b; };
  const BIG = `data:image/jpeg;base64,${Buffer.concat([FIXTURE.subarray(0, 2), seg(20000), seg(20000), seg(20000), FIXTURE.subarray(2)]).toString('base64')}`;
  check('la prueba usa una foto de más de 50 KB', BIG.length > 50000, `(${Math.round(BIG.length / 1024)} KB)`);
  const up = await http('POST', 'driver/selfie', D.token, { image: BIG });
  check('el conductor sube su selfie (foto de tamaño real)', up.ok === true && up.id > 0, `(${up.status} ${up.error || ''})`);
  const [[row]] = await pool.query('SELECT file FROM driver_selfies WHERE id = ?', [up.id]);
  check('la selfie se guarda cifrada en el disco', row.file.endsWith('.enc') && !fs.readFileSync(path.join(UPLOADS, row.file)).includes(Buffer.from('JFIF')));
  check('con la selfie ya puede ponerse disponible', (await tryOnline(ds)) === null);
  ds.emit('driver:offline');
  await wait(300);

  // Personal
  check('soporte sin permiso no ve las selfies', (await http('GET', 'admin/selfies', SUP)).status === 403);
  const list = await http('GET', 'admin/selfies', SA);
  const mine = list.find((s) => s.id === up.id);
  check('el personal ve la selfie por revisar con la foto aprobada del conductor', !!mine && mine.driver === 'C32 Conductor' && !!mine.photo_id);
  const img = await fetch(`${API}/api/admin/selfies/${up.id}/file`, { headers: { Authorization: `Bearer ${SA}` } });
  check('el personal ve la imagen (descifrada)', img.status === 200 && img.headers.get('content-type') === 'image/jpeg');
  check('el conductor no puede ver selfies por el panel', (await fetch(`${API}/api/admin/selfies/${up.id}/file`, { headers: { Authorization: `Bearer ${D.token}` } })).status === 403);
  check('el panel cuenta las selfies por revisar', (await http('GET', 'admin/stats', SA)).waitingSelfies >= 1);
  check('«es la misma persona»', (await http('POST', `admin/selfies/${up.id}/review`, SA, { result: 'ok' })).ok === true);
  check('una selfie revisada no se revisa dos veces', (await http('POST', `admin/selfies/${up.id}/review`, SA, { result: 'mismatch' })).status === 409);

  // No coincide: se bloquea
  await pool.query('UPDATE driver_selfies SET created_at = NOW() - INTERVAL 13 HOUR WHERE id = ?', [up.id]);
  check('pasadas las horas de Ajustes, vuelve a pedirla', (await tryOnline(ds))?.status === 'selfie');
  const up2 = await http('POST', 'driver/selfie', D.token, { image: IMG });
  const kicked = new Promise((r) => { ds.once('account:status', r); setTimeout(() => r(null), 2000); });
  check('«no coincide» la marca', (await http('POST', `admin/selfies/${up2.id}/review`, SA, { result: 'mismatch' })).ok === true);
  const [[u]] = await pool.query('SELECT status FROM users WHERE id = ?', [D.user.id]);
  check('y bloquea la cuenta del conductor', u.status === 'blocked');
  await kicked;
  check('el Registro lo anota', (await http('GET', 'admin/audit', SA)).some((a) => a.action === 'selfie.mismatch'));

  // Se borran solas a los 30 días
  const { purgeSelfies } = await import('../src/routes/selfies.js').catch(() => ({}));
  if (purgeSelfies) {
    await pool.query('UPDATE driver_selfies SET created_at = NOW() - INTERVAL 31 DAY WHERE driver_id = ?', [D.user.id]);
    await purgeSelfies();
    const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM driver_selfies WHERE driver_id = ?', [D.user.id]);
    check('a los 30 días se borran (también el archivo)', n.n === 0 && !fs.existsSync(path.join(UPLOADS, row.file)));
  }

  // Apagado en Ajustes (0 horas): no se pide
  const D2 = await registerUser({ name: 'C32 Otro', phone: `92${rnd}2`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HG3${rnd.slice(0, 4)}` });
  await uploadDocs(D2.token);
  await http('POST', `admin/users/${D2.user.id}/status`, SA, { status: 'active' });
  await http('PUT', 'admin/settings', SA, { driver_selfie_required: false });
  const d2 = await connect(D2.token);
  sockets.push(d2);
  check('con el interruptor apagado en Ajustes se conecta sin selfie', (await tryOnline(d2)) === null);
  d2.emit('driver:offline');
  await http('PUT', 'admin/settings', SA, { driver_selfie_required: true });
  check('al encenderlo otra vez, se la pide', (await tryOnline(d2))?.status === 'selfie');
  d2.emit('driver:offline');
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await http('PUT', 'admin/settings', SA, { driver_selfie_required: before.driver_selfie_required !== '0', driver_selfie_hours: Number(before.driver_selfie_hours) });
  sockets.forEach((s) => s.close());
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
