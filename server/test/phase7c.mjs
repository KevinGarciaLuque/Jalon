import 'dotenv/config';
// Fase 7: derechos del usuario sobre sus datos (descargarlos y eliminar su cuenta)
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const phone = (prefix) => `${prefix}${rnd}9`.slice(0, 8);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const UPLOADS = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

const P = await registerUser({ name: 'P7C Pasajero', phone: phone('88'), password: 'Cielo-azul-77', role: 'passenger' });
const D = await registerUser({ name: 'P7C Conductor', phone: phone('87'), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Hilux', plate: 'HHH0001' });
await uploadDocs(D.token);
const other = await registerUser({ name: 'P7C Otro', phone: phone('86'), password: 'Cielo-azul-77', role: 'passenger' });

// Un viaje completado entre los dos, con calificaciones y una alerta
const [r] = await pool.query(
  `INSERT INTO rides (passenger_id, driver_id, origin_lat, origin_lng, origin_text, dest_lat, dest_lng, dest_text, distance_km, offered_price, final_price, status)
   VALUES (?,?,14.07,-87.19,'Mi casa en la Kennedy',14.1,-87.2,'Mall Multiplaza',4.5,80,85,'completed')`, [P.user.id, D.user.id]
);
await pool.query('INSERT INTO ratings (ride_id, rater_id, ratee_id, stars, comment) VALUES (?,?,?,5,?), (?,?,?,4,?)',
  [r.insertId, P.user.id, D.user.id, 'Excelente conductor, muy amable', r.insertId, D.user.id, P.user.id, 'Pasajero puntual']);
await pool.query('INSERT INTO alerts (ride_id, user_id, lat, lng) VALUES (?,?,14.07,-87.19)', [r.insertId, P.user.id]);

// ---------------- Descargar mis datos ----------------
check('descargar los datos exige sesión', (await http('GET', 'me/export', null)).status === 401);
const res = await fetch(`${API}/api/me/export`, { headers: { Authorization: `Bearer ${P.token}` } });
const raw = await res.text();
const exp = JSON.parse(raw);
check('se descarga como archivo JSON', res.status === 200 && /attachment/.test(res.headers.get('content-disposition') || ''));
check('incluye mi cuenta con la aceptación de los términos', exp.cuenta.telefono === P.user.phone && exp.cuenta.nombre === 'P7C Pasajero' && !!exp.cuenta.aceptoTerminosEl && exp.cuenta.versionTerminos === '1.1');
check('incluye mis viajes con direcciones y la otra persona', exp.viajes.length === 1 && exp.viajes[0].origin_text === 'Mi casa en la Kennedy' && exp.viajes[0].mi_rol === 'pasajero' && exp.viajes[0].otra_persona === 'P7C Conductor');
check('incluye las calificaciones que di y las que recibí', exp.calificacionesQueDi[0].comment.includes('Excelente') && exp.calificacionesQueRecibi[0].comment === 'Pasajero puntual');
check('incluye mis alertas de emergencia', exp.alertasDeEmergencia.length === 1);
check('no incluye contraseñas, secretos ni el teléfono de la otra persona', !/password|hash|totp|secret|backup/i.test(raw) && !raw.includes(D.user.phone));
const dExp = await http('GET', 'me/export', D.token);
check('un conductor ve el estado de sus documentos (sin los archivos)', dExp.documentos.length === 3 && !JSON.stringify(dExp).includes('.enc') && dExp.cuenta.placa === 'HHH0001');
check('cada persona recibe solo sus propios datos', !JSON.stringify(await http('GET', 'me/export', other.token)).includes('P7C Conductor'));

// ---------------- Eliminar mi cuenta ----------------
check('eliminar la cuenta exige sesión', (await http('POST', 'me/delete', null, { password: 'x' })).status === 401);
check('con la contraseña equivocada no se elimina', (await http('POST', 'me/delete', P.token, { password: 'no-es-esa' })).status === 403);
check('el personal no se elimina solo', (await http('POST', 'me/delete', SA, { password: 'x' })).status === 403);

await pool.query("UPDATE rides SET status = 'started' WHERE id = ?", [r.insertId]);
check('con un viaje en curso no se puede eliminar', (await http('POST', 'me/delete', P.token, { password: 'Cielo-azul-77' })).status === 409);
await pool.query("UPDATE rides SET status = 'completed' WHERE id = ?", [r.insertId]);

const docsBefore = fs.readdirSync(UPLOADS).filter((f) => f.startsWith(`${D.user.id}-`)).length;
check('el conductor tiene 3 archivos antes de eliminarse', docsBefore === 3);
const del = await http('POST', 'me/delete', D.token, { password: 'Cielo-azul-77' });
check('el conductor elimina su propia cuenta', del.ok === true);
const [[gone]] = await pool.query('SELECT name, phone, vehicle, plate, status, deleted_at, totp_secret FROM users WHERE id = ?', [D.user.id]);
check('queda anonimizada: sin nombre, teléfono, vehículo ni placa', gone.name === 'Cuenta eliminada' && gone.phone === `del-${D.user.id}` && !gone.vehicle && !gone.plate && gone.status === 'blocked' && !!gone.deleted_at);
check('se borran sus documentos del disco y de la base', fs.readdirSync(UPLOADS).filter((f) => f.startsWith(`${D.user.id}-`)).length === 0 && (await pool.query('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?', [D.user.id]))[0][0].n === 0);
check('su sesión se cierra', (await http('GET', 'rides/mine', D.token)).status === 401);
check('ya no puede entrar', (await http('POST', 'login', null, { phone: D.user.phone, password: 'Cielo-azul-77' })).status === 401);
check('su teléfono queda libre para volver a registrarse', !!(await http('POST', 'otp/send', null, { phone: D.user.phone })).devCode);
const [[ride]] = await pool.query('SELECT origin_text, dest_text, share_token, status FROM rides WHERE id = ?', [r.insertId]);
check('el viaje se conserva pero sin direcciones', ride.status === 'completed' && !ride.origin_text && !ride.dest_text && !ride.share_token);
const [[cmt]] = await pool.query('SELECT comment FROM ratings WHERE rater_id = ?', [D.user.id]);
check('sus comentarios se borran', cmt.comment === null);
const pExp = await http('GET', 'me/export', P.token);
check('la otra persona del viaje ya no ve su nombre', pExp.viajes[0].otra_persona === 'Cuenta eliminada');
const audit = await http('GET', 'admin/audit', SA);
check('queda anotado en el registro', audit.some((a) => a.action === 'user.self_delete' && a.target_user_id === D.user.id));

const pDel = await http('POST', 'me/delete', P.token, { password: 'Cielo-azul-77' });
check('un pasajero también puede eliminar su cuenta', pDel.ok === true);

await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
