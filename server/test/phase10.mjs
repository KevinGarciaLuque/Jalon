import 'dotenv/config';
// Fase 10: código de verificación por correo (y SMS opcional), correo válido y único
import { pool } from '../src/db.js';
import { normalizeEmail } from '../src/mail.js';
import { http } from './helpers.mjs';

const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const phone = (p) => `${p}${rnd}9`.slice(0, 8);
const base = { name: 'P10 Pasajero', password: 'Cielo-azul-77', role: 'passenger', acceptTerms: true };

// ---- Validación del correo (sin red) ----
check('acepta un correo normal y lo pasa a minúsculas', normalizeEmail(' Ana.Lopez@Gmail.COM ') === 'ana.lopez@gmail.com');
check('rechaza sin arroba, sin dominio, con espacios o con dos arrobas', ['ana', 'ana@', 'ana@gmail', 'a b@gmail.com', 'a@@gmail.com', '@gmail.com', 'a@gmail..com'].every((e) => normalizeEmail(e) === null));
check('rechaza saltos de línea (inyección de cabeceras) y varias direcciones', normalizeEmail('a@b.com\nBcc: x@y.com') === null && normalizeEmail('a@b.com,c@d.com') === null);
check('rechaza lo que no es texto o es larguísimo', normalizeEmail(null) === null && normalizeEmail(123) === null && normalizeEmail(`${'a'.repeat(200)}@gmail.com`) === null);

// ---- Envío del código ----
const ph = phone('91');
const mail = `p10-${rnd}@prueba.jalon.test`;
check('sin correo no se envía el código', (await http('POST', 'otp/send', null, { phone: ph, email: undefined })).status === 400);
check('con un correo inválido tampoco', (await http('POST', 'otp/send', null, { phone: ph, email: 'no-es-correo' })).status === 400);
const sent = await http('POST', 'otp/send', null, { phone: ph, email: mail });
check('con correo válido se envía un código de 6 dígitos', /^\d{6}$/.test(sent.devCode || ''));

// ---- Registro ----
check('registrar sin correo es rechazado', (await http('POST', 'register', null, { ...base, phone: ph, email: '', code: sent.devCode })).status === 400);
check('el código solo vale para el correo al que se envió', (await http('POST', 'register', null, { ...base, phone: ph, email: `otro-${rnd}@prueba.jalon.test`, code: sent.devCode })).status === 400);
const reg = await http('POST', 'register', null, { ...base, phone: ph, email: mail.toUpperCase(), code: sent.devCode });
check('con el código y el mismo correo se crea la cuenta', !!reg.token && reg.user?.email === mail);
const [[row]] = await pool.query('SELECT email FROM users WHERE phone = ?', [ph]);
check('el correo queda guardado en minúsculas', row?.email === mail);

// ---- Un correo, una cuenta ----
const ph2 = phone('92');
check('no se envía código si el correo ya está registrado', (await http('POST', 'otp/send', null, { phone: ph2, email: mail })).status === 409);
check('ni si lo escriben con otras mayúsculas', (await http('POST', 'otp/send', null, { phone: ph2, email: mail.toUpperCase() })).status === 409);
check('un teléfono ya registrado sigue rechazándose', (await http('POST', 'otp/send', null, { phone: ph, email: `nuevo-${rnd}@prueba.jalon.test` })).status === 409);

// ---- Recuperar la contraseña: el código va al correo de la cuenta ----
const forgot = await http('POST', 'password/forgot', null, { phone: ph });
check('se envía el código de recuperación al correo registrado', /^\d{6}$/.test(forgot.devCode || ''));
check('con el código se cambia la contraseña', (await http('POST', 'password/reset', null, { phone: ph, code: forgot.devCode, password: 'Otra-clave-88' })).ok === true);
check('y entra con la nueva', !!(await http('POST', 'login', null, { phone: ph, password: 'Otra-clave-88' })).token);

// Una cuenta antigua sin correo no recibe nada por correo (y la respuesta es la misma, para no revelar nada)
const old = phone('93');
await pool.query("INSERT INTO users (name, phone, password_hash, role, status) VALUES ('P10 Antiguo', ?, 'x', 'passenger', 'active')", [old]);
const oldForgot = await http('POST', 'password/forgot', null, { phone: old });
check('una cuenta sin correo responde igual pero no envía código', oldForgot.ok === true && !oldForgot.devCode);

// ---- Datos personales ----
const [[logged]] = [[await http('POST', 'login', null, { phone: ph, password: 'Otra-clave-88' })]];
const exp = await fetch(`${process.env.API_URL || 'http://localhost:4000'}/api/me/export`, { headers: { Authorization: `Bearer ${logged.token}` } }).then((r) => r.json()).catch(() => ({}));
check('la descarga de datos incluye el correo', exp.cuenta?.correo === mail);
const del = await http('POST', 'me/delete', logged.token, { password: 'Otra-clave-88' });
const [[after]] = await pool.query('SELECT email FROM users WHERE id = ?', [logged.user.id]);
check('al eliminar la cuenta se borra el correo', (del.ok === true || del.status === 200) && after.email === null);
check('y el correo queda libre para registrarse otra vez', !!(await http('POST', 'otp/send', null, { phone: phone('94'), email: mail })).devCode);

await pool.query("DELETE FROM users WHERE name = 'P10 Antiguo'");
await pool.end();
console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK');
process.exit(fails ? 1 : 0);
