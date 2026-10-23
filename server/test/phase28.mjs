import 'dotenv/config';
// Recuperar la contraseña con el teléfono o con el correo, y entrar directo al terminar
import { pool } from '../src/db.js';
import jwt from 'jsonwebtoken';
import { http, registerUser, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');

try {
  const phone = `86${rnd}8`.slice(0, 8);
  const email = `${phone}@prueba.jalon.test`;
  const P = await registerUser({ name: 'C28 Pasajera', phone, password: 'Cielo-azul-77', role: 'passenger' });
  check('la cuenta de prueba tiene correo', P.user?.email === email, `(${P.user?.email})`);

  // Con el correo (en mayúsculas y con espacios: se normaliza)
  const byMail = await http('POST', 'password/forgot', null, { login: `  ${email.toUpperCase()} ` });
  check('se puede pedir el código escribiendo el correo', byMail.ok === true && /^\d{6}$/.test(byMail.devCode || ''));
  const unknownMail = await http('POST', 'password/forgot', null, { login: `nadie-${rnd}@prueba.jalon.test` });
  check('con un correo que no existe responde igual y no manda código', unknownMail.ok === true && !unknownMail.devCode);
  check('un dato que no es teléfono ni correo se explica', (await http('POST', 'password/forgot', null, { login: 'hola' })).status === 400);
  check('con un código equivocado no cambia', (await http('POST', 'password/reset', null, { login: email, code: byMail.devCode === '111111' ? '222222' : '111111', password: 'Nueva-clave-88' })).status === 400);
  const done = await http('POST', 'password/reset', null, { login: email, code: byMail.devCode, password: 'Nueva-clave-88' });
  check('con el código se cambia la contraseña y entra directo', done.ok === true && !!done.token && done.user?.id === P.user.id, `(${done.status} ${done.error || ''})`);
  check('la sesión nueva sirve', (await http('GET', 'me', done.token)).user?.id === P.user.id);
  check('la sesión anterior se cerró', (await http('GET', 'me', P.token)).status === 401);
  check('entra con la contraseña nueva', !!(await http('POST', 'login', null, { phone, password: 'Nueva-clave-88' })).token);

  // Con el teléfono (como antes) también funciona
  await pool.query("UPDATE otp_codes SET created_at = created_at - INTERVAL 2 MINUTE WHERE phone = ?", [phone]); // pasa la espera entre códigos
  const byPhone = await http('POST', 'password/forgot', null, { login: phone });
  check('se puede pedir el código escribiendo el teléfono', /^\d{6}$/.test(byPhone.devCode || ''));
  const done2 = await http('POST', 'password/reset', null, { login: phone, code: byPhone.devCode, password: 'Otra-clave-99' });
  check('con el teléfono también entra directo', !!done2.token && done2.user?.id === P.user.id);

  // ---- Sistema avisa si la comisión está activa pero falta la cuenta para transferir ----
  const root = await createTestSuperadmin(pool);
  const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const before = await http('GET', 'admin/settings', SA);
  const keep = { commission_enabled: before.commission_enabled === '1', bank_name: before.bank_name, bank_account: before.bank_account, bank_holder: before.bank_holder };
  const bankItem = async () => (await http('GET', 'admin/system', SA)).items?.find((i) => i.label === 'Cuenta para las recargas');
  await http('PUT', 'admin/settings', SA, { commission_enabled: false });
  check('con la comisión apagada, Sistema dice que no hay recargas', (await bankItem())?.status === 'info');
  const refused = await http('PUT', 'admin/settings', SA, { commission_enabled: true, bank_name: '', bank_account: '', bank_holder: '' });
  check('no se puede activar la comisión sin la cuenta para transferir', refused.status === 400 && /cuenta/.test(refused.error || ''), `(${refused.status} ${refused.error || ''})`);
  await http('PUT', 'admin/settings', SA, { commission_enabled: true, bank_name: 'Banco de prueba', bank_account: '12-345', bank_holder: 'Ktracho GO' });
  const ready = await bankItem();
  check('con la comisión activa y la cuenta llena, Sistema la muestra lista', ready?.status === 'ok' && ready.detail.includes('12-345'), `(${ready?.status})`);
  await http('PUT', 'admin/settings', SA, keep);
  await pool.query('DELETE FROM users WHERE id = ?', [root.id]).catch(() => {});
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
