import 'dotenv/config';
// Etapa 7.1: la sesión de la app web va en una cookie HttpOnly; lo que cambia algo exige la cabecera de la app (CSRF)
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import jwt from 'jsonwebtoken';
import { API, http, registerUser, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const APP = { 'Content-Type': 'application/json', 'X-Jalon-Session': 'cookie' };

// Llamada como la haría el navegador: con la cookie y, si `app`, con la cabecera de la app
async function call(method, path, { cookie, app = true, body, headers = {} } = {}) {
  const r = await fetch(`${API}/api/${path}`, {
    method,
    headers: { ...(app ? APP : { 'Content-Type': 'application/json' }), ...(cookie ? { Cookie: cookie } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  const set = r.headers.get('set-cookie') || '';
  return { status: r.status, set, cookie: /^jalon_session=([^;]*)/.exec(set)?.[1], json: await r.json().catch(() => ({})) };
}
const jar = (value) => `jalon_session=${value}`;
const socketWith = (opts) => new Promise((resolve) => {
  const s = io(API, { transports: ['websocket'], reconnection: false, ...opts });
  s.on('connect', () => { s.close(); resolve('ok'); });
  s.on('connect_error', (e) => { s.close(); resolve(e.message); });
});

try {
  const phone = `81${rnd}9`.slice(0, 8);
  const reg = await registerUser({ name: 'C7 Pasajero', phone, password: 'Cielo-azul-77', role: 'passenger' });
  check('sin la cabecera de la app (pruebas, app nativa) el registro sigue devolviendo el token', !!reg.token);

  // Ingreso desde la app web
  const login = await call('POST', 'login', { body: { phone, password: 'Cielo-azul-77' } });
  check('la app web entra y no recibe el token en la respuesta', login.status === 200 && !login.json.token && login.json.user?.phone === phone);
  check('la sesión llega en una cookie', !!login.cookie);
  check('que JavaScript no puede leer, solo para este sitio y para toda la app', /HttpOnly/i.test(login.set) && /SameSite=Strict/i.test(login.set) && /Path=\//.test(login.set));
  check('y que dura lo mismo que la sesión (30 días)', /Max-Age=(\d+)/.test(login.set) && Number(/Max-Age=(\d+)/.exec(login.set)[1]) > 29 * 86400);
  const c = jar(login.cookie);

  // Leer con la cookie
  check('con la cookie se usa la API', (await call('GET', 'me', { cookie: c })).status === 200);
  check('una consulta funciona aunque no traiga la cabecera', (await call('GET', 'me', { cookie: c, app: false })).status === 200);
  check('sin cookie ni token, no', (await call('GET', 'me')).status === 401);
  check('una cookie inventada, no', (await call('GET', 'me', { cookie: jar('abc.def.ghi') })).status === 401);

  // CSRF: otro sitio puede hacer que el navegador mande la cookie, pero no puede poner la cabecera
  const forged = await call('POST', 'favorites', { cookie: c, app: false, body: { label: 'Casa', text: 'Col. Palmira', lat: 14.07, lng: -87.19 } });
  check('un cambio con la cookie pero sin la cabecera de la app se rechaza (CSRF)', forged.status === 403, `(${forged.status})`);
  const okFav = await call('POST', 'favorites', { cookie: c, body: { label: 'Casa', text: 'Col. Palmira', lat: 14.07, lng: -87.19 } });
  check('con la cabecera de la app, el cambio pasa', okFav.status === 200, `(${okFav.status} ${okFav.json.error || ''})`);

  // Los clientes con token siguen funcionando
  check('el token en Authorization sigue valiendo', (await http('GET', 'me', reg.token)).status === 200);
  check('y con token no hace falta la cabecera de la app', (await http('POST', 'favorites', reg.token, { label: 'Trabajo', text: 'Centro', lat: 14.08, lng: -87.2 })).status === 200);

  // Socket con la cookie
  check('el socket se conecta con la cookie', (await socketWith({ extraHeaders: { Cookie: c } })) === 'ok');
  check('desde otro sitio, el socket no acepta la cookie', (await socketWith({ extraHeaders: { Cookie: c, Origin: 'https://otro-sitio.example' } })) === 'No autorizado');
  check('y el socket con token sigue funcionando', (await socketWith({ auth: { token: reg.token } })) === 'ok');

  // Pasar a la cookie una sesión guardada de antes
  const legacy = await http('POST', 'login', null, { phone, password: 'Cielo-azul-77' });
  const moved = await call('POST', 'session/cookie', { headers: { Authorization: `Bearer ${legacy.token}` } });
  check('una sesión guardada de antes pasa a la cookie', moved.status === 200 && moved.cookie === legacy.token);
  check('sin la cabecera de la app no se pasa', (await call('POST', 'session/cookie', { app: false, headers: { Authorization: `Bearer ${legacy.token}` } })).status === 400);
  check('con un token inválido no se pasa', (await call('POST', 'session/cookie', { headers: { Authorization: 'Bearer x.y.z' } })).status === 401);

  // Cambiar la contraseña renueva la cookie y cierra las demás sesiones
  const changed = await call('POST', 'password/change', { cookie: c, body: { current: 'Cielo-azul-77', password: 'Nube-verde-88' } });
  check('al cambiar la contraseña llega una cookie nueva', changed.status === 200 && !!changed.cookie && changed.cookie !== login.cookie && !changed.json.token);
  check('la cookie anterior ya no sirve', (await call('GET', 'me', { cookie: c })).status === 401);
  check('el token anterior tampoco', (await http('GET', 'me', reg.token)).status === 401);
  const c2 = jar(changed.cookie);
  check('la nueva sí', (await call('GET', 'me', { cookie: c2 })).status === 200);

  // Cerrar las demás sesiones
  const all = await call('POST', 'logout-all', { cookie: c2 });
  check('cerrar las demás sesiones deja esta con una cookie nueva', all.status === 200 && !!all.cookie && (await call('GET', 'me', { cookie: jar(all.cookie) })).status === 200);
  check('y la de antes queda cerrada', (await call('GET', 'me', { cookie: c2 })).status === 401);

  // Salir
  const out = await call('POST', 'logout', { cookie: jar(all.cookie) });
  check('salir borra la cookie', out.status === 200 && /jalon_session=;/.test(out.set) && /Expires=Thu, 01 Jan 1970/i.test(out.set));

  // Personal: el panel también funciona con la cookie
  const root = await createTestSuperadmin(pool);
  const sa = jar(jwt.sign({ id: root.id, role: 'superadmin', tv: 0 }, process.env.JWT_SECRET, { expiresIn: '10m' }));
  check('el panel del personal funciona con la cookie', (await call('GET', 'admin/stats', { cookie: sa })).status === 200);
  check('y sus cambios también exigen la cabecera de la app', (await call('PUT', 'admin/settings', { cookie: sa, app: false, body: {} })).status === 403);
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
