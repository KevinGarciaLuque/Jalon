import 'dotenv/config';
// Fase 7: verificación en dos pasos del personal
import { spawnSync } from 'child_process';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { hotp, stepOf } from '../src/totp.js';
import { http, registerUser, createTestSuperadmin, totpNow, enroll2fa } from './helpers.mjs';

const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const phone = (prefix) => `${prefix}${rnd}9`.slice(0, 8);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

// Personal nuevo: contraseña temporal → cambio obligatorio (todavía sin 2FA)
async function newStaff(name, role, ph) {
  const created = await http('POST', 'admin/staff', SA, { name, phone: ph, role });
  const login = await http('POST', 'login', null, { phone: ph, password: created.tempPassword });
  const changed = await http('POST', 'password/change', login.token, { current: created.tempPassword, password: 'Clave-nueva-123' });
  return { id: created.id, phone: ph, token: changed.token, password: 'Clave-nueva-123' };
}
const ph1 = phone('77');
const S = await newStaff('P7 Soporte', 'support', ph1);
const pass = await registerUser({ name: 'P7 Pasajero', phone: phone('76'), password: 'secreto1', role: 'passenger' });

// ---------------- Activación ----------------
check('activar la verificación exige sesión', (await http('POST', '2fa/setup', null, {})).status === 401);
check('un pasajero no usa la verificación en dos pasos', (await http('POST', '2fa/setup', pass.token, {})).status === 403);
check('antes de activarla, el personal no puede usar el panel', (await http('GET', 'admin/stats', S.token)).code === 'MUST_ENROLL_2FA');
check('sin ella tampoco puede ver la lista de usuarios ni documentos', (await http('GET', 'admin/users', S.token)).status === 403);

const setup = await http('POST', '2fa/setup', S.token, {});
check('se genera un secreto y el enlace para el código QR', /^[A-Z2-7]{32}$/.test(setup.secret) && setup.otpauthUrl.startsWith('otpauth://totp/Jal%C3%B3n:') && setup.otpauthUrl.includes(`secret=${setup.secret}`));
const [[row]] = await pool.query('SELECT totp_secret, totp_enabled FROM users WHERE id = ?', [S.id]);
check('el secreto se guarda cifrado en la base de datos', row.totp_secret && row.totp_secret !== setup.secret && !row.totp_secret.includes(setup.secret) && row.totp_enabled === 0);
check('un código incorrecto no activa nada', (await http('POST', '2fa/enable', S.token, { code: '000000' })).status === 400 || totpNow(setup.secret) === '000000');
check('un código con formato inválido tampoco', (await http('POST', '2fa/enable', S.token, { code: 'abcdef' })).status === 400);
const enabled = await http('POST', '2fa/enable', S.token, { code: totpNow(setup.secret) });
check('con el código correcto se activa y entrega 10 códigos de respaldo', enabled.ok === true && enabled.backupCodes?.length === 10 && enabled.backupCodes.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c)));
const [[stored]] = await pool.query('SELECT backup_codes FROM users WHERE id = ?', [S.id]);
check('los códigos de respaldo se guardan solo como huella, nunca en claro', !enabled.backupCodes.some((c) => stored.backup_codes.includes(c)) && JSON.parse(stored.backup_codes).length === 10);
check('no se puede activar dos veces', (await http('POST', '2fa/enable', S.token, { code: totpNow(setup.secret, 1) })).status === 409 && (await http('POST', '2fa/setup', S.token, {})).status === 409);
check('con la verificación activa ya entra al panel', (await http('GET', 'admin/stats', S.token)).rides !== undefined);

// ---------------- Ingreso ----------------
const login = async () => http('POST', 'login', null, { phone: ph1, password: S.password });
const c1 = await login();
check('la contraseña sola ya no da sesión: devuelve un desafío', c1.twoFactor === true && !!c1.challenge && !c1.token && !c1.user);
check('un pasajero nunca recibe desafío', !!(await http('POST', 'login', null, { phone: pass.user.phone, password: 'secreto1' })).token);
const second = (challenge, code) => http('POST', 'login/2fa', null, { challenge, code });
check('un desafío inventado se rechaza', (await second('no-es-un-desafio', '123456')).status === 401);
check('un token de sesión no sirve como desafío', (await second(S.token, totpNow(setup.secret, 1))).status === 401);
const expired = jwt.sign({ id: S.id, purpose: '2fa' }, process.env.JWT_SECRET, { expiresIn: -5 });
check('un desafío vencido se rechaza', (await second(expired, totpNow(setup.secret, 1))).status === 401);
check('un código incorrecto no da sesión', (await second(c1.challenge, '111111')).status === 401);

const good = totpNow(setup.secret, 1); // el intervalo siguiente al usado al activar
const ok1 = await second(c1.challenge, good);
check('con el código de la app entra', !!ok1.token && ok1.user.role === 'support' && ok1.user.twoFactorEnabled === true);
check('la sesión obtenida funciona en el panel', (await http('GET', 'admin/stats', ok1.token)).rides !== undefined);
check('el mismo código no sirve una segunda vez', (await second((await login()).challenge, good)).status === 401);
check('un código de un intervalo anterior tampoco', (await second((await login()).challenge, hotp(setup.secret, stepOf() - 1))).status === 401);

// ---------------- Códigos de respaldo ----------------
const backup = enabled.backupCodes[0];
const viaBackup = await second((await login()).challenge, backup.toLowerCase().replace('-', ' '));
check('un código de respaldo permite entrar (aunque se escriba distinto)', !!viaBackup.token);
check('un código de respaldo solo sirve una vez', (await second((await login()).challenge, backup)).status === 401);
const [[left]] = await pool.query('SELECT backup_codes FROM users WHERE id = ?', [S.id]);
check('quedan 9 códigos de respaldo', JSON.parse(left.backup_codes).length === 9);

check('pedir códigos nuevos exige la contraseña correcta', (await http('POST', '2fa/backup-codes', ok1.token, { password: 'no-es' })).status === 403);
const fresh = await http('POST', '2fa/backup-codes', ok1.token, { password: S.password });
check('con la contraseña se generan 10 códigos nuevos', fresh.backupCodes?.length === 10);
check('los códigos anteriores dejan de servir', (await second((await login()).challenge, enabled.backupCodes[1])).status === 401);
check('los nuevos sí sirven', !!(await second((await login()).challenge, fresh.backupCodes[0])).token);

// ---------------- Bloqueo por intentos ----------------
const ch = (await login()).challenge;
const attempts = [];
for (let i = 0; i < 5; i++) attempts.push((await second(ch, String(100000 + i))).status);
check('cinco códigos incorrectos seguidos dan error 401', attempts.every((s) => s === 401), `(${attempts})`);
const blocked = await second(ch, fresh.backupCodes[2]);
check('después de 5 fallos se bloquea aunque el código sea correcto', blocked.status === 429 && !blocked.token);
const [[lock]] = await pool.query('SELECT two_fa_locked_until > NOW() AS locked FROM users WHERE id = ?', [S.id]);
check('el bloqueo queda en la base de datos', lock.locked === 1);
await pool.query('UPDATE users SET two_fa_locked_until = NULL, two_fa_failures = 0 WHERE id = ?', [S.id]);
check('pasado el bloqueo vuelve a funcionar', !!(await second(ch, fresh.backupCodes[2])).token);

// ---------------- Restablecer (pérdida del teléfono) ----------------
const admin = await newStaff('P7 Admin', 'admin', phone('75'));
await enroll2fa(admin.token);
check('un administrador no puede restablecer la verificación de otro', (await http('POST', `admin/users/${S.id}/reset-2fa`, admin.token, {})).status === 403);
check('nadie restablece la de un superadmin', (await http('POST', `admin/users/${root.id}/reset-2fa`, SA, {})).status === 403);
check('el superadmin restablece la verificación de alguien del personal', (await http('POST', `admin/users/${S.id}/reset-2fa`, SA, {})).ok === true);
check('la sesión anterior de esa persona se cierra', (await http('GET', 'admin/stats', ok1.token)).status === 401);
const afterReset = await http('POST', 'login', null, { phone: ph1, password: S.password });
check('al volver a entrar debe activarla de nuevo', !!afterReset.token && afterReset.user.mustEnrollTwoFactor === true);
check('y mientras tanto no puede usar el panel', (await http('GET', 'admin/stats', afterReset.token)).code === 'MUST_ENROLL_2FA');
check('restablecer a un pasajero no tiene sentido', (await http('POST', `admin/users/${pass.user.id}/reset-2fa`, SA, {})).status === 400);

// Salida de emergencia por variable de entorno (si se pierde todo)
await enroll2fa(afterReset.token);
const env = { ...process.env, RESET_2FA_FOR: ph1 };
const run = spawnSync(process.execPath, ['src/setup.js'], { cwd: process.cwd(), env, encoding: 'utf8' });
const [[emerg]] = await pool.query('SELECT totp_enabled, totp_secret, backup_codes FROM users WHERE id = ?', [S.id]);
check('RESET_2FA_FOR restablece la verificación al arrancar (salida de emergencia)', emerg.totp_enabled === 0 && !emerg.totp_secret && !emerg.backup_codes && /restablecida/.test(run.stderr + run.stdout));

// Salida de emergencia 2: contraseña nueva por variable de entorno
const run2 = spawnSync(process.execPath, ['src/setup.js'], { cwd: process.cwd(), env: { ...process.env, RESET_PASSWORD_FOR: ph1, RESET_PASSWORD_TO: 'Clave-de-rescate-9' }, encoding: 'utf8' });
check('RESET_PASSWORD_FOR pone la contraseña indicada al arrancar', /Contraseña restablecida/.test(run2.stderr + run2.stdout) && !!(await http('POST', 'login', null, { phone: ph1, password: 'Clave-de-rescate-9' })).token);
check('y la contraseña anterior deja de servir', !(await http('POST', 'login', null, { phone: ph1, password: S.password })).token);
const run3 = spawnSync(process.execPath, ['src/setup.js'], { cwd: process.cwd(), env: { ...process.env, RESET_PASSWORD_FOR: pass.user.phone, RESET_PASSWORD_TO: 'Clave-de-rescate-9' }, encoding: 'utf8' });
check('no sirve para pasajeros ni conductores', /no hay personal/.test(run3.stderr + run3.stdout) && !(await http('POST', 'login', null, { phone: pass.user.phone, password: 'Clave-de-rescate-9' })).token);

// ---------------- Registro de actividad ----------------
const audit = await http('GET', 'admin/audit', SA);
const acts = new Set(audit.map((a) => a.action));
check('el registro anota activar, códigos nuevos y restablecer', ['2fa.enable', '2fa.backup_codes', '2fa.reset'].every((a) => acts.has(a)), `(${[...acts].filter((a) => a.startsWith('2fa')).join(', ')})`);

await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
