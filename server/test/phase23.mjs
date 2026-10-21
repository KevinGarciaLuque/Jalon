import 'dotenv/config';
// Etapa 8.3: quien aceptó una versión anterior de los términos los vuelve a aceptar al abrir la app
import { pool } from '../src/db.js';
import { TERMS_VERSION } from '../src/legal.js';
import { http, registerUser } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');

try {
  const phone = `82${rnd}7`.slice(0, 8);
  const reg = await registerUser({ name: 'T Términos', phone, password: 'Cielo-azul-77', role: 'passenger' });
  check('quien se registra ya aceptó la versión actual', reg.user?.mustAcceptTerms === false && reg.user.termsVersion === TERMS_VERSION);

  // Alguien que aceptó la versión anterior
  await pool.query("UPDATE users SET terms_version = '1.6' WHERE id = ?", [reg.user.id]);
  const login = await http('POST', 'login', null, { phone, password: 'Cielo-azul-77' });
  check('al entrar, quien aceptó una versión anterior debe aceptar la nueva', login.user?.mustAcceptTerms === true);
  check('y al abrir la app con la sesión guardada también', (await http('GET', 'me', login.token)).user?.mustAcceptTerms === true);
  check('mientras tanto la app sigue funcionando (no se corta un viaje en curso)', (await http('GET', 'rides/mine', login.token)).status === 200);

  check('no se acepta una versión que no es la actual', (await http('POST', 'terms/accept', login.token, { version: '1.0' })).status === 409);
  check('ni sin sesión', (await http('POST', 'terms/accept', null, { version: TERMS_VERSION })).status === 401);
  const ok = await http('POST', 'terms/accept', login.token, { version: TERMS_VERSION });
  check('acepta la versión actual', ok.status === 200 && ok.version === TERMS_VERSION);
  const [[u]] = await pool.query('SELECT terms_version, terms_accepted_at > NOW() - INTERVAL 1 MINUTE AS fresh FROM users WHERE id = ?', [reg.user.id]);
  check('queda guardado cuál aceptó y cuándo', u.terms_version === TERMS_VERSION && u.fresh === 1);
  check('y ya no se le vuelve a pedir', (await http('GET', 'me', login.token)).user?.mustAcceptTerms === false);

  // Cuentas de antes de guardar la versión (vacía): también se les pide
  await pool.query('UPDATE users SET terms_version = NULL WHERE id = ?', [reg.user.id]);
  check('a quien no tiene versión guardada también se le pide', (await http('GET', 'me', login.token)).user?.mustAcceptTerms === true);
  const data = await http('GET', 'me/export', login.token);
  check('aunque no acepte, puede descargar sus datos', data.status === 200);
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
