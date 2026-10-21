import 'dotenv/config';
// Permisos por módulo: el superadmin decide qué ve cada rol y da o quita módulos a una persona
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';
import { http, registerUser, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const mk = async (role, prefix) => {
  const [r] = await pool.query("INSERT INTO users (name, phone, password_hash, role, status, totp_enabled, terms_accepted_at) VALUES (?, ?, ?, ?, 'active', 1, NOW())", [role === 'admin' ? 'T Admin' : 'T Soporte', `${prefix}${rnd}6`.slice(0, 8), await bcrypt.hash('no-se-usa-1', 4), role]);
  return { id: r.insertId, token: jwt.sign({ id: r.insertId, role }, process.env.JWT_SECRET, { expiresIn: '10m' }) };
};
const perms = async (t) => (await http('GET', 'admin/users', t)).perms || [];
const start = (await http('GET', 'admin/permissions', SA)).roles;

try {
  const A = await mk('admin', '51');
  const S1 = await mk('support', '52');
  const S2 = await mk('support', '53');

  // Al principio el alquiler es solo del superadmin
  check('el superadmin ve los alquileres', (await http('GET', 'admin/rentals', SA)).status === 200);
  check('un administrador no, al principio', (await http('GET', 'admin/rentals', A.token)).status === 403 && !(await perms(A.token)).includes('rentals'));
  const P = await registerUser({ name: 'E1 Pasajero', phone: `84${rnd}6`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  check('ni el pasajero', !P.user.perms.includes('rent') && (await http('GET', 'rentals/search', P.token)).status === 403);

  // Solo el superadmin administra los permisos
  check('un administrador no puede ver ni cambiar permisos', (await http('GET', 'admin/permissions', A.token)).status === 403 && (await http('PUT', 'admin/permissions/admin', A.token, { perms: ['rentals'] })).status === 403);
  const cfg = await http('GET', 'admin/permissions', SA);
  check('la lista de módulos dice a qué roles se puede dar cada uno', cfg.modules.some((m) => m.key === 'rentals' && m.roles.includes('admin')) && cfg.modules.some((m) => m.key === 'rent' && m.roles.includes('passenger')));
  check('Ajustes y Personal no se pueden dar a nadie', (await http('PUT', 'admin/permissions/admin', SA, { perms: ['view', 'settings'] })).status === 400 && (await http('PUT', 'admin/permissions/admin', SA, { perms: ['staff.manage'] })).status === 400);
  check('un módulo no se da a un rol que no corresponde', (await http('PUT', 'admin/permissions/support', SA, { perms: ['fleet'] })).status === 400 && (await http('PUT', 'admin/permissions/passenger', SA, { perms: ['rentals'] })).status === 400);

  // Por rol
  const saved = await http('PUT', 'admin/permissions/admin', SA, { perms: [...start.admin, 'rentals'] });
  check('el superadmin le da Alquileres al rol administrador', saved.ok === true && saved.perms.includes('rentals'));
  check('ahora el administrador lo ve', (await http('GET', 'admin/rentals', A.token)).status === 200 && (await perms(A.token)).includes('rentals'));
  await http('PUT', 'admin/permissions/passenger', SA, { perms: ['rent'] });
  const me = await http('GET', 'me', P.token);
  check('al abrir la app, el pasajero recibe el módulo nuevo', me.user?.perms.includes('rent'));
  check('y ya puede buscar carros', (await http('GET', 'rentals/search', P.token)).status === 200);

  // Por persona
  check('soporte no ve los alquileres', (await http('GET', 'admin/rentals', S1.token)).status === 403);
  const give = await http('PUT', `admin/users/${S1.id}/permissions`, SA, { perm: 'rentals', allow: true });
  check('el superadmin se lo da a una persona de soporte', give.ok === true && give.effective.includes('rentals'));
  check('esa persona lo ve', (await http('GET', 'admin/rentals', S1.token)).status === 200);
  check('otra persona de soporte sigue sin verlo', (await http('GET', 'admin/rentals', S2.token)).status === 403);
  const take = await http('PUT', `admin/users/${A.id}/permissions`, SA, { perm: 'audit', allow: false });
  check('le quita el Registro a un administrador en particular', take.ok === true && !take.effective.includes('audit'));
  check('y deja de verlo', (await http('GET', 'admin/audit', A.token)).status === 403);
  const detail = await http('GET', `admin/users/${A.id}/permissions`, SA);
  check('la ficha muestra lo del rol y sus excepciones', detail.roleDefault.includes('audit') && detail.overrides.audit === false && !detail.effective.includes('audit'));
  await http('PUT', `admin/users/${A.id}/permissions`, SA, { perm: 'audit', allow: null });
  check('«según su rol» quita la excepción', (await http('GET', 'admin/audit', A.token)).status === 200);
  check('no se da un módulo que no corresponde a su rol', (await http('PUT', `admin/users/${S1.id}/permissions`, SA, { perm: 'fleet', allow: true })).status === 400);
  check('no se cambian los permisos del superadmin', (await http('PUT', `admin/users/${root.id}/permissions`, SA, { perm: 'audit', allow: false })).status === 403);

  // Al cambiar de rol no se heredan las excepciones
  await http('POST', `admin/staff/${S1.id}/role`, SA, { role: 'admin' });
  await http('POST', `admin/staff/${S1.id}/role`, SA, { role: 'support' });
  check('al cambiarle el rol pierde sus excepciones', (await http('GET', 'admin/rentals', S1.token)).status === 403);
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
} finally {
  for (const role of ['admin', 'support', 'driver', 'passenger']) await http('PUT', `admin/permissions/${role}`, SA, { perms: start[role] });
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
