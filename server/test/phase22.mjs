import 'dotenv/config';
// Etapa 8.2: estado del sistema en el panel (solo el superadmin; nunca muestra claves)
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';
import { API, http, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);

try {
  const r = await fetch(`${API}/api/admin/system`, { headers: { Authorization: `Bearer ${SA}` } });
  const raw = await r.text();
  const s = JSON.parse(raw);
  check('el superadmin ve el estado del sistema', r.status === 200 && Array.isArray(s.items) && s.items.length >= 12);
  check('cada punto dice si está listo, si hay que revisarlo o si falta', s.items.every((i) => ['ok', 'warn', 'bad', 'info'].includes(i.status) && i.label && i.detail));
  check('con un resumen de lo que falta', typeof s.summary?.bad === 'number' && s.summary.bad === s.items.filter((i) => i.status === 'bad').length);
  check('y la versión publicada', !!s.version?.startedAt && !!s.version.node);
  const secrets = [process.env.JWT_SECRET, process.env.SMTP_PASS, process.env.VAPID_PRIVATE_KEY, process.env.DATA_KEY, process.env.TWILIO_AUTH_TOKEN, process.env.MAPS_KEY, process.env.ADMIN_PASSWORD].filter((v) => v && v.length > 5);
  check('nunca muestra claves', secrets.every((v) => !raw.includes(v)), `(${secrets.length} revisadas)`);
  check('fuera de producción no exige UPLOADS_DIR', s.items.find((i) => i.label === 'Carpeta de documentos')?.status !== 'bad');

  // Si se apaga la verificación en dos pasos del personal, aparece como pendiente
  await http('PUT', 'admin/settings', SA, { staff_2fa_required: false });
  const off = await http('GET', 'admin/system', SA);
  check('si la verificación en dos pasos está apagada, sale como «falta»', off.items.find((i) => /dos pasos/.test(i.label))?.status === 'bad');
  await http('PUT', 'admin/settings', SA, { staff_2fa_required: before.staff_2fa_required !== '0' });

  // Solo el superadmin (Ajustes no se le puede dar a otro rol)
  const [a] = await pool.query("INSERT INTO users (name, phone, password_hash, role, status, totp_enabled, terms_accepted_at) VALUES ('T Admin sistema', ?, ?, 'admin', 'active', 1, NOW())", [`55${rnd}3`.slice(0, 8), await bcrypt.hash('no-se-usa-1', 4)]);
  const ADM = jwt.sign({ id: a.insertId, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  check('un administrador no lo ve', (await http('GET', 'admin/system', ADM)).status === 403);
  check('ni sin sesión', (await http('GET', 'admin/system')).status === 401);
  await pool.query('DELETE FROM users WHERE id = ?', [a.insertId]);
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
