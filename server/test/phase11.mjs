import 'dotenv/config';
// Fase 11: el superadmin puede apagar (y volver a encender) la verificación en dos pasos del personal
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';
import { http, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
// Un administrador con 2FA activo y otro que nunca la configuró
const PASS = 'clave-de-prueba-11';
const mkAdmin = async (prefix, totp) => {
  const phone = `${prefix}${rnd}`.slice(0, 8);
  const [r] = await pool.query("INSERT INTO users (name, phone, password_hash, role, status, totp_enabled, terms_accepted_at) VALUES ('T Admin 11', ?, ?, 'admin', 'active', ?, NOW())", [phone, await bcrypt.hash(PASS, 4), totp ? 1 : 0]);
  return { id: r.insertId, phone };
};
const withTotp = await mkAdmin('55', true);
const without = await mkAdmin('56', false);

try {
  // Encendida (por defecto)
  let s = await http('GET', 'admin/settings', SA);
  check('por defecto se exige la verificación', s.staff_2fa_required === '1', s.staff_2fa_required);
  let l = await http('POST', 'login', null, { phone: withTotp.phone, password: PASS });
  check('con 2FA activa el login pide el código', l.twoFactor === true && !l.token);
  l = await http('POST', 'login', null, { phone: without.phone, password: PASS });
  check('sin 2FA el login obliga a activarla', l.user?.mustEnrollTwoFactor === true);
  let r = await http('GET', 'admin/stats', l.token);
  check('y el panel la exige', r.code === 'MUST_ENROLL_2FA', `${r.status}`);

  // Solo el superadmin la cambia
  const ADM = jwt.sign({ id: withTotp.id, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  r = await http('PUT', 'admin/settings', ADM, { staff_2fa_required: false });
  check('un administrador no puede apagarla', r.status === 403, `${r.status}`);

  // Apagada
  s = await http('PUT', 'admin/settings', SA, { staff_2fa_required: false });
  check('el superadmin la apaga', s.staff_2fa_required === '0', s.error || '');
  l = await http('POST', 'login', null, { phone: withTotp.phone, password: PASS });
  check('apagada, quien la tenía entra solo con contraseña', !!l.token && !l.twoFactor && l.user?.mustEnrollTwoFactor === false);
  l = await http('POST', 'login', null, { phone: without.phone, password: PASS });
  check('apagada, no se obliga a activarla', !!l.token && l.user?.mustEnrollTwoFactor === false);
  r = await http('GET', 'admin/stats', l.token);
  check('y el panel funciona sin ella', r.status === 200, `${r.status} ${r.error || ''}`);

  // Encendida otra vez: quien la tenía vuelve a necesitar el código
  s = await http('PUT', 'admin/settings', SA, { staff_2fa_required: true });
  check('el superadmin la vuelve a encender', s.staff_2fa_required === '1');
  l = await http('POST', 'login', null, { phone: withTotp.phone, password: PASS });
  check('encendida de nuevo, se pide el código', l.twoFactor === true && !l.token);
} finally {
  await pool.query("INSERT INTO settings (name, value) VALUES ('staff_2fa_required', '1') ON DUPLICATE KEY UPDATE value = '1'");
  await pool.query('DELETE FROM users WHERE id IN (?)', [[withTotp.id, without.id]]);
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
