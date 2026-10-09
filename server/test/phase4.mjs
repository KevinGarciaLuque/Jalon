import 'dotenv/config';
// Fase 4: verificación por SMS, recuperación de contraseña y documentos del conductor
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { API, FIXTURE, JPG, http, registerUser, uploadDocs } from './helpers.mjs';

const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

const [[adm]] = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1");
const A = jwt.sign({ id: adm.id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const phone = (prefix) => `${prefix}${rnd}9`.slice(0, 8);

// ---------------- Registro con código ----------------
const ph = phone('93');
const base = { name: 'P4 Pasajero', phone: ph, password: 'secreto1', role: 'passenger' };
check('registro sin código es rechazado', (await http('POST', 'register', null, base)).status === 400);
check('enviar código a un teléfono inválido', (await http('POST', 'otp/send', null, { phone: 'abc' })).status === 400);

const sent = await http('POST', 'otp/send', null, { phone: ph });
check('se envía un código de 6 dígitos', /^\d{6}$/.test(sent.devCode || ''));
check('no se puede pedir otro código enseguida', (await http('POST', 'otp/send', null, { phone: ph })).status === 429);
const wrong = sent.devCode === '000000' ? '111111' : '000000';
check('código incorrecto es rechazado', (await http('POST', 'register', null, { ...base, code: wrong })).status === 400);
const reg = await http('POST', 'register', null, { ...base, code: sent.devCode });
check('registro con el código correcto', !!reg.token && reg.user.status === 'active');
check('el código solo sirve una vez', (await http('POST', 'register', null, { ...base, code: sent.devCode })).status === 400);
check('no se envía código a un teléfono ya registrado', (await http('POST', 'otp/send', null, { phone: ph })).status === 409);

// El teléfono con formato (+504 y guiones) es el mismo que el de 8 dígitos
const ph2 = phone('92');
const fmt = `+504 ${ph2.slice(0, 4)}-${ph2.slice(4)}`;
const fmtReg = await registerUser({ name: 'P4 Formato', phone: fmt, password: 'secreto1', role: 'passenger' });
check('el teléfono se guarda normalizado a 8 dígitos', fmtReg.user?.phone === ph2, `(${fmtReg.user?.phone})`);
check('se puede entrar con el formato corto', !!(await http('POST', 'login', null, { phone: ph2, password: 'secreto1' })).token);
check('se puede entrar con el formato largo', !!(await http('POST', 'login', null, { phone: fmt, password: 'secreto1' })).token);

// Tras 5 intentos fallidos el código se bloquea aunque el sexto sea correcto
const ph3 = phone('91');
const lock = await http('POST', 'otp/send', null, { phone: ph3 });
const bad = lock.devCode === '123456' ? '654321' : '123456';
for (let i = 0; i < 5; i++) await http('POST', 'register', null, { name: 'P4 Bloqueo', phone: ph3, password: 'secreto1', role: 'passenger', code: bad });
check('código bloqueado tras 5 intentos fallidos', (await http('POST', 'register', null, { name: 'P4 Bloqueo', phone: ph3, password: 'secreto1', role: 'passenger', code: lock.devCode })).status === 400);

// ---------------- Recuperar contraseña ----------------
const unknown = await http('POST', 'password/forgot', null, { phone: phone('90') });
check('recuperar con teléfono desconocido responde igual y no revela nada', unknown.ok === true && !unknown.devCode);
const adminPhone = (await pool.query('SELECT phone FROM users WHERE id = ?', [adm.id]))[0][0].phone;
const adminForgot = await http('POST', 'password/forgot', null, { phone: adminPhone });
check('el admin no se recupera por SMS', adminForgot.ok === true && !adminForgot.devCode);

const oldToken = fmtReg.token;
const forgot = await http('POST', 'password/forgot', null, { phone: ph2 });
check('se envía código de recuperación', /^\d{6}$/.test(forgot.devCode || ''));
check('no se puede pedir otro de inmediato', (await http('POST', 'password/forgot', null, { phone: ph2 })).status === 429);
check('contraseña demasiado corta', (await http('POST', 'password/reset', null, { phone: ph2, code: forgot.devCode, password: '123' })).status === 400);
check('código de recuperación incorrecto', (await http('POST', 'password/reset', null, { phone: ph2, code: wrong, password: 'nueva-clave-1' })).status === 400);
check('se cambia la contraseña', (await http('POST', 'password/reset', null, { phone: ph2, code: forgot.devCode, password: 'nueva-clave-1' })).ok === true);
check('la contraseña anterior ya no funciona', (await http('POST', 'login', null, { phone: ph2, password: 'secreto1' })).status === 401);
check('la nueva contraseña funciona', !!(await http('POST', 'login', null, { phone: ph2, password: 'nueva-clave-1' })).token);
check('la sesión anterior se cierra', (await http('GET', 'rides/mine', oldToken)).status === 401);
const regCode = await http('POST', 'otp/send', null, { phone: phone('89') });
check('un código de registro no sirve para recuperar', (await http('POST', 'password/reset', null, { phone: ph2, code: regCode.devCode, password: 'otra-clave-1' })).status === 400);
await pool.query("UPDATE users SET name = 'P4 Reset' WHERE phone = ?", [ph2]);

// ---------------- Documentos del conductor ----------------
const D = await registerUser({ name: 'P4 Driver', phone: phone('88'), password: 'secreto1', role: 'driver', vehicle: 'Civic', plate: 'HDD1111' });
const P = reg;
check('documentos: sin sesión no se puede subir', (await http('PUT', 'driver/documents/photo', null, { image: JPG })).status === 401);
check('documentos: un pasajero no puede subir', (await http('PUT', 'driver/documents/photo', P.token, { image: JPG })).status === 403);
check('documentos: tipo inválido', (await http('PUT', 'driver/documents/pasaporte', D.token, { image: JPG })).status === 400);
check('documentos: no acepta un archivo que no es JPG', (await http('PUT', 'driver/documents/photo', D.token, { image: 'data:image/jpeg;base64,' + Buffer.from('esto no es una imagen, solo texto de prueba largo para pasar el minimo de bytes').toString('base64') })).status === 400);
check('documentos: no acepta PNG', (await http('PUT', 'driver/documents/photo', D.token, { image: 'data:image/png;base64,iVBORw0KGgo=' })).status === 400);
check('documentos: lista vacía al inicio', (await http('GET', 'driver/documents', D.token)).length === 0);

check('sube la foto del conductor', (await http('PUT', 'driver/documents/photo', D.token, { image: JPG })).ok === true);
check('sube la licencia', (await http('PUT', 'driver/documents/license', D.token, { image: JPG })).ok === true);
check('no se aprueba con 2 de 3 documentos', (await http('POST', `admin/users/${D.user.id}/status`, A, { status: 'active' })).status === 409);
check('sube la matrícula', (await http('PUT', 'driver/documents/registration', D.token, { image: JPG })).ok === true);

const docs = await http('GET', `admin/users/${D.user.id}/documents`, A);
check('el admin ve los 3 documentos', docs.length === 3 && docs.every((d) => d.status === 'uploaded'));
const list = await http('GET', 'admin/users', A);
check('la lista de usuarios muestra cuántos documentos subió', list.find((u) => u.id === D.user.id)?.docs === 3);

const file = await fetch(`${API}/api/admin/documents/${docs[0].id}/file`, { headers: { Authorization: `Bearer ${A}` } });
const bytes = Buffer.from(await file.arrayBuffer());
check('el admin descarga la imagen original', file.status === 200 && file.headers.get('content-type') === 'image/jpeg' && bytes.equals(FIXTURE));
check('un conductor no puede ver documentos', (await fetch(`${API}/api/admin/documents/${docs[0].id}/file`, { headers: { Authorization: `Bearer ${D.token}` } })).status === 403);
check('sin sesión tampoco', (await fetch(`${API}/api/admin/documents/${docs[0].id}/file`)).status === 401);

const lic = docs.find((d) => d.type === 'license');
check('el admin rechaza la licencia con un motivo', (await http('POST', `admin/documents/${lic.id}/reject`, A, { note: 'Foto borrosa' })).ok === true);
const mine = await http('GET', 'driver/documents', D.token);
const licMine = mine.find((d) => d.type === 'license');
check('el conductor ve el motivo del rechazo', licMine.status === 'rejected' && licMine.note === 'Foto borrosa');
check('con un documento rechazado no se aprueba', (await http('POST', `admin/users/${D.user.id}/status`, A, { status: 'active' })).status === 409);

const before = fs.readdirSync(path.join(process.cwd(), 'uploads')).filter((f) => f.startsWith(`${D.user.id}-license`));
await http('PUT', 'driver/documents/license', D.token, { image: JPG });
const after = fs.readdirSync(path.join(process.cwd(), 'uploads')).filter((f) => f.startsWith(`${D.user.id}-license`));
check('al volver a subir se reemplaza el archivo viejo', before.length === 1 && after.length === 1 && before[0] !== after[0]);
check('el documento vuelve a estar en revisión', (await http('GET', 'driver/documents', D.token)).find((d) => d.type === 'license').status === 'uploaded');

check('con los 3 documentos el admin aprueba', (await http('POST', `admin/users/${D.user.id}/status`, A, { status: 'active' })).ok === true);
check('el conductor queda activo', (await http('POST', 'login', null, { phone: D.user.phone, password: 'secreto1' })).user.status === 'active');

await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
