import 'dotenv/config';
// Compartir la app: enlaces para pasajeros y conductores (permiso 'share', al principio solo el superadmin)
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';
import { http, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const start = (await http('GET', 'admin/permissions', SA)).roles;
let adminId = null;

try {
  const links = await http('GET', 'admin/share', SA);
  check('el superadmin recibe los dos enlaces', links.status === 200 && !!links.passenger && !!links.driver, JSON.stringify(links));
  check('el de pasajeros es la página principal', /^https?:\/\/[^/]+\/$/.test(links.passenger));
  check('el de conductores abre el registro de conductor', links.driver === `${links.passenger}?registro=conductor`);

  const [a] = await pool.query("INSERT INTO users (name, phone, password_hash, role, status, totp_enabled, terms_accepted_at) VALUES ('T Admin compartir', ?, ?, 'admin', 'active', 1, NOW())", [`54${rnd}6`.slice(0, 8), await bcrypt.hash('no-se-usa-1', 4)]);
  adminId = a.insertId;
  const ADM = jwt.sign({ id: adminId, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  check('un administrador no lo ve al principio', (await http('GET', 'admin/share', ADM)).status === 403);
  await http('PUT', 'admin/permissions/admin', SA, { perms: [...start.admin, 'share'] });
  check('si el superadmin se lo da, sí', (await http('GET', 'admin/share', ADM)).status === 200);
  check('sin sesión, no', (await http('GET', 'admin/share')).status === 401);
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
} finally {
  for (const role of ['admin', 'support', 'driver', 'passenger']) await http('PUT', `admin/permissions/${role}`, SA, { perms: start[role] });
  if (adminId) await pool.query('DELETE FROM users WHERE id = ?', [adminId]);
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
