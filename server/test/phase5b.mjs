import 'dotenv/config';
// Fase 5B: roles del personal, gestión de usuarios, contraseñas temporales, eliminación y auditoría
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin, enroll2fa } from './helpers.mjs';

const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const phone = (prefix) => `${prefix}${rnd}9`.slice(0, 8);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

// Entra con una contraseña temporal y la cambia (obligatorio la primera vez)
async function firstLogin(ph, temp, newPass) {
  const login = await http('POST', 'login', null, { phone: ph, password: temp });
  const forced = await http('GET', 'admin/stats', login.token);
  const changed = await http('POST', 'password/change', login.token, { current: temp, password: newPass });
  // El personal, además, debe activar la verificación en dos pasos antes de usar el panel
  const needEnroll = changed.token ? await http('GET', 'admin/stats', changed.token) : null;
  const twoFactor = changed.token && login.user?.role !== 'passenger' ? await enroll2fa(changed.token) : null;
  return { login, forced, changed, needEnroll, twoFactor };
}

// ---------------- Crear personal ----------------
const adminPhone = phone('77');
const supportPhone = phone('76');
check('solo el superadmin crea personal (sin sesión)', (await http('POST', 'admin/staff', null, { name: 'X', phone: adminPhone, role: 'admin' })).status === 401);
check('rol inválido al crear personal', (await http('POST', 'admin/staff', SA, { name: 'P5B Admin', phone: adminPhone, role: 'superadmin' })).status === 400);
const ad = await http('POST', 'admin/staff', SA, { name: 'P5B Admin', phone: adminPhone, role: 'admin' });
const su = await http('POST', 'admin/staff', SA, { name: 'P5B Soporte', phone: supportPhone, role: 'support' });
check('se crea un administrador con contraseña temporal', ad.id > 0 && ad.tempPassword?.length === 10);
check('se crea un agente de soporte', su.id > 0 && su.tempPassword?.length === 10);
check('no se repite el teléfono del personal', (await http('POST', 'admin/staff', SA, { name: 'Otro', phone: adminPhone, role: 'support' })).status === 409);

// ---------------- Cambio obligatorio de contraseña ----------------
const A1 = await firstLogin(adminPhone, ad.tempPassword, 'admin-clave-1');
check('el login avisa que debe cambiar la contraseña', A1.login.user.mustChangePassword === true && A1.login.user.role === 'admin');
check('con contraseña temporal no se puede usar el panel', A1.forced.status === 403 && A1.forced.code === 'MUST_CHANGE_PASSWORD');
check('la contraseña temporal se puede cambiar', A1.changed.ok === true && !!A1.changed.token);
check('la contraseña nueva debe ser distinta de la temporal', (await http('POST', 'password/change', (await http('POST', 'login', null, { phone: supportPhone, password: su.tempPassword })).token, { current: su.tempPassword, password: su.tempPassword })).status === 400);
const S1 = await firstLogin(supportPhone, su.tempPassword, 'soporte-clave-1');
const AD = A1.changed.token;
const SU = S1.changed.token;
check('el personal sin verificación en dos pasos no puede usar el panel', A1.needEnroll.status === 403 && A1.needEnroll.code === 'MUST_ENROLL_2FA');
check('después de activarla ya puede entrar al panel', (await http('GET', 'admin/stats', AD)).rides !== undefined);
const relogin = await http('POST', 'login', null, { phone: adminPhone, password: 'admin-clave-1' });
check('el personal con verificación activa recibe un desafío en vez de la sesión', relogin.twoFactor === true && !relogin.token);
check('con un código de respaldo completa el ingreso y ya no pide cambio de contraseña', (await http('POST', 'login/2fa', null, { challenge: relogin.challenge, code: A1.twoFactor.backupCodes[0] })).user?.mustChangePassword === false);

// ---------------- Permisos por rol ----------------
const pass = await registerUser({ name: 'P5B Pasajero', phone: phone('75'), password: 'secreto1', role: 'passenger' });
const drv = await registerUser({ name: 'P5B Conductor', phone: phone('74'), password: 'secreto1', role: 'driver', vehicle: 'Yaris', plate: 'HEE0001' });
await uploadDocs(drv.token);

const ulist = await http('GET', 'admin/users', SU);
check('soporte puede ver usuarios y recibe sus permisos', ulist.users?.length > 0 && !ulist.perms.includes('users.manage') && ulist.me.role === 'support');
check('soporte no puede aprobar conductores', (await http('POST', `admin/users/${drv.user.id}/status`, SU, { status: 'active' })).status === 403);
check('soporte no puede ver documentos', (await http('GET', `admin/users/${drv.user.id}/documents`, SU)).status === 403);
check('soporte no puede ver el registro de actividad', (await http('GET', 'admin/audit', SU)).status === 403);
check('soporte puede ver las alertas de emergencia', (await http('GET', 'admin/alerts', SU)).status === 200);
check('soporte no puede editar usuarios', (await http('PATCH', `admin/users/${pass.user.id}`, SU, { name: 'Nuevo' })).status === 403);
check('soporte no puede crear personal', (await http('POST', 'admin/staff', SU, { name: 'X', phone: phone('73'), role: 'support' })).status === 403);
check('el administrador tampoco crea personal', (await http('POST', 'admin/staff', AD, { name: 'X', phone: phone('73'), role: 'support' })).status === 403);
check('un pasajero no entra al panel', (await http('GET', 'admin/users', pass.token)).status === 403);

// ---------------- El administrador opera usuarios ----------------
check('el administrador aprueba al conductor', (await http('POST', `admin/users/${drv.user.id}/status`, AD, { status: 'active' })).ok === true);
check('el administrador no puede bloquear a un superadmin', (await http('POST', `admin/users/${root.id}/status`, AD, { status: 'blocked' })).status === 403);
check('el administrador no puede tocar al personal', (await http('POST', `admin/users/${su.id}/status`, AD, { status: 'blocked' })).status === 403);
check('el administrador no puede eliminar cuentas', (await http('POST', `admin/users/${pass.user.id}/delete`, AD, {})).status === 403);

// ---------------- Ficha, edición y restablecer contraseña ----------------
const detail = await http('GET', `admin/users/${drv.user.id}`, AD);
check('la ficha trae datos, documentos, estadísticas y movimientos', detail.user?.id === drv.user.id && detail.docs?.length === 3 && detail.stats && Array.isArray(detail.history) && detail.history.some((h) => h.action === 'user.approve'));
const detailSupport = await http('GET', `admin/users/${drv.user.id}`, SU);
check('para soporte la ficha no incluye documentos ni movimientos', detailSupport.docs === null && detailSupport.history === null);
check('la ficha de un usuario inexistente da 404', (await http('GET', 'admin/users/99999999', AD)).status === 404);

const takenPhone = phone('75');
check('editar: no hay cambios', (await http('PATCH', `admin/users/${pass.user.id}`, AD, { name: 'P5B Pasajero' })).status === 400);
check('editar: el teléfono debe ser válido', (await http('PATCH', `admin/users/${pass.user.id}`, AD, { phone: 'abc' })).status === 400);
check('editar: no se repite el teléfono de otra cuenta', (await http('PATCH', `admin/users/${pass.user.id}`, AD, { phone: drv.user.phone })).status === 409);
const newPhone = phone('72');
check('el administrador corrige nombre y teléfono', (await http('PATCH', `admin/users/${pass.user.id}`, AD, { name: 'P5B Pasajero Editado', phone: `+504 ${newPhone}` })).ok === true);
check('el teléfono nuevo quedó normalizado y sirve para entrar', !!(await http('POST', 'login', null, { phone: newPhone, password: 'secreto1' })).token);
check('editar el vehículo de un conductor', (await http('PATCH', `admin/users/${drv.user.id}`, AD, { vehicle: 'Yaris azul', plate: 'HEE0002' })).ok === true);

const reset = await http('POST', `admin/users/${pass.user.id}/reset-password`, AD, {});
check('restablecer genera una contraseña temporal', reset.tempPassword?.length === 10);
check('las sesiones del usuario se cierran', (await http('GET', 'rides/mine', pass.token)).status === 401);
const PR = await firstLogin(newPhone, reset.tempPassword, 'pasajero-nueva-1');
check('con la temporal solo puede cambiarla', PR.login.user.mustChangePassword === true && PR.forced.status === 403 && PR.changed.ok === true);
check('después del cambio ya usa la app', (await http('GET', 'rides/mine', PR.changed.token)).status === 200);
check('soporte no puede restablecer contraseñas', (await http('POST', `admin/users/${pass.user.id}/reset-password`, SU, {})).status === 403);

// ---------------- Roles del personal ----------------
check('cambiar el rol del personal (superadmin)', (await http('POST', `admin/staff/${su.id}/role`, SA, { role: 'admin' })).ok === true);
check('el cambio de rol se aplica en la siguiente petición', (await http('POST', `admin/users/${drv.user.id}/status`, SU, { status: 'blocked' })).ok === true);
check('el nuevo administrador ahora puede ver el registro', (await http('GET', 'admin/audit', SU)).status === 200);
check('no se puede dejar el mismo rol', (await http('POST', `admin/staff/${su.id}/role`, SA, { role: 'admin' })).status === 400);
check('un usuario normal no es del personal', (await http('POST', `admin/staff/${pass.user.id}/role`, SA, { role: 'support' })).status === 400);
check('el superadmin no puede cambiar su propio rol', (await http('POST', `admin/staff/${root.id}/role`, SA, { role: 'support' })).status === 403);
check('el superadmin puede bloquear a un administrador', (await http('POST', `admin/users/${ad.id}/status`, SA, { status: 'blocked' })).ok === true);
check('un administrador bloqueado pierde el acceso al panel', (await http('GET', 'admin/stats', AD)).status === 403);
check('un administrador bloqueado no puede iniciar sesión', (await http('POST', 'login', null, { phone: adminPhone, password: 'admin-clave-1' })).status === 403);

// ---------------- Eliminar (anonimizar) una cuenta ----------------
const delFiles = fs.readdirSync(path.join(process.cwd(), 'uploads')).filter((f) => f.startsWith(`${drv.user.id}-`));
check('el conductor tiene documentos guardados antes de borrar', delFiles.length === 3);
check('nadie elimina a un superadmin', (await http('POST', `admin/users/${root.id}/delete`, SA, {})).status === 403);
check('el superadmin elimina una cuenta', (await http('POST', `admin/users/${drv.user.id}/delete`, SA, {})).ok === true);
const [[gone]] = await pool.query('SELECT name, phone, vehicle, plate, status, deleted_at FROM users WHERE id = ?', [drv.user.id]);
check('la cuenta queda anonimizada', gone.name === 'Cuenta eliminada' && gone.phone === `del-${drv.user.id}` && !gone.vehicle && !gone.plate && gone.status === 'blocked' && !!gone.deleted_at);
check('se borran los archivos de los documentos', fs.readdirSync(path.join(process.cwd(), 'uploads')).filter((f) => f.startsWith(`${drv.user.id}-`)).length === 0);
check('el usuario eliminado no puede entrar', (await http('POST', 'login', null, { phone: drv.user.phone, password: 'secreto1' })).status === 401);
check('su teléfono queda libre para registrarse de nuevo', !!(await http('POST', 'otp/send', null, { phone: drv.user.phone })).devCode);
check('una cuenta eliminada no se puede editar', (await http('PATCH', `admin/users/${drv.user.id}`, SA, { name: 'Zombi' })).status === 404);

// ---------------- Registro de actividad ----------------
const log = await http('GET', 'admin/audit', SA);
const actions = new Set(log.map((l) => l.action));
check('el registro anota todo lo que se hizo', ['staff.create', 'user.approve', 'user.edit', 'user.reset_password', 'staff.role', 'user.block', 'user.delete'].every((a) => actions.has(a)), `(${[...actions].join(', ')})`);
check('cada anotación dice quién lo hizo y sobre quién', log.some((l) => l.action === 'user.delete' && l.actor && l.target_name === 'Cuenta eliminada'));

await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
