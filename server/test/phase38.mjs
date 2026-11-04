import 'dotenv/config';
// Errores de la app: el celular los manda al servidor (que los pasa a Sentry) sin datos personales, y el botón «Probar Sentry»
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { scrub } from '../src/config.js';
import { API, http, registerUser, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const send = (body, token) => fetch(`${API}/api/client-errors`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
}).then((r) => r.status);

try {
  // ---------- Sin datos personales ----------
  const dirty = 'Falló el pago de 98765432 / +504 9876-5432 para ana.lopez@correo.hn en https://ktrachogo.com/t/abc?code=123456 con eyJhbGciOi.eyJpZCI6MX0.firma';
  const clean = scrub(dirty, 500);
  check('quita teléfonos', !/9876/.test(clean), clean);
  check('quita correos', !clean.includes('ana.lopez') && clean.includes('[correo]'));
  check('quita lo que va después de «?» en las direcciones', clean.includes('https://ktrachogo.com/t/abc') && !clean.includes('code=123456'));
  check('quita tokens de sesión', !clean.includes('eyJ') && clean.includes('[token]'));
  check('deja la línea y columna del código', scrub('at x (https://ktrachogo.com/assets/index-AB12.js:1:23456)', 200).includes('index-AB12.js:1:23456'));
  check('corta los textos largos', scrub('x'.repeat(1000), 300).length === 300);

  // ---------- La app reporta ----------
  check('sin sesión se puede reportar (p. ej. en la pantalla de entrar)', (await send({ message: 'Prueba sin sesión', stack: 'Error\n at a', kind: 'error', page: '/', version: '1.0' })) === 204);
  const P = await registerUser({ name: 'C38 Pasajero', phone: `87${rnd}8`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  check('con sesión también', (await send({ message: 'Prueba con sesión', kind: 'render', page: '/?x=1' }, P.token)) === 204);
  check('un reporte vacío o raro no rompe nada', (await send({ message: { a: 1 }, kind: 'otro', stack: null })) === 204);

  // ---------- «Probar Sentry» ----------
  check('un pasajero no puede usar «Probar Sentry»', (await http('POST', 'admin/system/sentry-test', P.token, {})).status === 403);
  const root = await createTestSuperadmin(pool);
  const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const t = await http('POST', 'admin/system/sentry-test', SA, {});
  check('sin SENTRY_DSN avisa qué falta', t.status === 409 && /SENTRY_DSN/.test(t.error), JSON.stringify(t));
  const sys = await http('GET', 'admin/system', SA);
  check('Sistema explica cómo activarlo', sys.items?.some((i) => i.label.includes('Sentry') && /sentry\.io/.test(i.detail)));

  // ---------- Límite (para que nadie llene Sentry) ----------
  let last = 0;
  for (let i = 0; i < 30; i++) last = await send({ message: `Repetido ${i}` });
  check('después de 30 reportes en 10 minutos se frena', last === 429);
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
