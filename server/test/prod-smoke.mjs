// Revisión de la app publicada, SOLO LECTURA: no crea cuentas, no escribe nada y hace pocas peticiones.
// Uso: npm run test:prod                      (revisa https://ktrachogo.com)
//      PROD_URL=https://otra-direccion npm run test:prod
// Dice qué etapas están publicadas y si la seguridad básica (HTTPS, cabeceras, CORS, caché) está bien.
const BASE = (process.env.PROD_URL || 'https://ktrachogo.com').replace(/\/$/, '');
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const get = (path, opts = {}) => fetch(`${BASE}${path}`, { redirect: 'manual', ...opts });

console.log(`Revisando ${BASE} (solo lectura)\n`);

// ---- Qué versión está publicada ----
// Cada etapa agregó una ruta: si responde 401 (pide sesión) existe; si responde 404, esa etapa todavía no está publicada
const STAGES = [
  ['Permisos por módulo', 'GET', '/api/admin/permissions'],
  ['Etapa 5 (ganancias e historial)', 'GET', '/api/driver/earnings'],
  ['Etapa 6 (indicadores y exportar)', 'GET', '/api/admin/metrics'],
  ['Etapa 7.1 (sesión en cookie)', 'POST', '/api/logout'],
  ['Etapa 8.2 (estado del sistema)', 'GET', '/api/admin/system'],
  ['Etapa 8.3 (aceptar términos)', 'POST', '/api/terms/accept'],
];
let lastLive = null;
for (const [name, method, path] of STAGES) {
  const r = await get(path, { method, headers: { 'X-Jalon-Session': 'cookie', 'Content-Type': 'application/json' }, body: method === 'POST' ? '{}' : undefined });
  const live = r.status !== 404;
  if (live) lastLive = name;
  console.log(`     ${live ? '✓ publicada  ' : '✗ falta      '} ${name} (${r.status})`);
}
console.log(`\nLo más nuevo publicado: ${lastLive || 'nada reconocible'}\n`);

// ---- Que esté viva ----
const health = await get('/api/health');
check('la app responde', health.status === 200 && (await health.json()).ok === true);

// ---- HTTPS y cabeceras de seguridad ----
check('se usa HTTPS', BASE.startsWith('https://'));
if (BASE.startsWith('https://')) {
  const http = await fetch(BASE.replace('https://', 'http://'), { redirect: 'manual' }).catch(() => null);
  check('http:// redirige a https://', !http || [301, 302, 307, 308].includes(http.status) || http.url.startsWith('https://'), http ? `(${http.status})` : '(sin http)');
}
const home = await get('/');
const h = (n) => home.headers.get(n) || '';
check('la página principal carga', home.status === 200 && /<div id="root">/.test(await home.text()));
check('HSTS (el navegador siempre usa HTTPS)', /max-age=\d{7,}/.test(h('strict-transport-security')));
check('política de contenido (CSP) sin scripts de otros sitios', /default-src 'self'/.test(h('content-security-policy')) && !/script-src[^;]*\*/.test(h('content-security-policy')));
check('no se puede meter en un iframe de otro sitio', /SAMEORIGIN|DENY/i.test(h('x-frame-options')) || /frame-ancestors 'self'|frame-ancestors 'none'/.test(h('content-security-policy')));
check('nosniff', h('x-content-type-options') === 'nosniff');
check('referrer-policy', !!h('referrer-policy'));
check('permisos del navegador limitados (sin cámara ni micrófono)', /camera=\(\)/.test(h('permissions-policy')) && /microphone=\(\)/.test(h('permissions-policy')));
check('no dice qué servidor usa (X-Powered-By)', !h('x-powered-by'));

// ---- Archivos de la app ----
const html = await (await get('/')).text();
const main = /\/assets\/index-[\w-]+\.js/.exec(html)?.[0];
check('la pieza principal existe', !!main);
if (main) {
  const js = await get(main, { headers: { 'Accept-Encoding': 'br, gzip' } });
  check('se guarda un año en el navegador', /immutable/.test(js.headers.get('cache-control') || ''));
  check('no publica los mapas del código fuente (.map)', (await get(`${main}.map`)).status !== 200 || !(await get(`${main}.map`)).headers.get('content-type')?.includes('json'));
}
const gone = await get('/assets/pieza-que-no-existe-123.js');
console.log(`     pieza vieja: ${gone.status} ${gone.status === 404 ? '(bien: la app se recarga sola tras publicar)' : '(antes de la Etapa 7.4 devolvía la página)'}`);
for (const p of ['/terminos', '/privacidad']) check(`la página ${p} carga`, (await get(p)).status === 200);

// ---- La API no se abre a otros sitios ----
const evil = await get('/api/health', { headers: { Origin: 'https://sitio-ajeno.example' } });
check('CORS: otro sitio no puede usar la API desde el navegador', evil.headers.get('access-control-allow-origin') !== 'https://sitio-ajeno.example' && evil.headers.get('access-control-allow-origin') !== '*');
check('sin sesión no se ven datos', (await get('/api/me')).status === 401 && (await get('/api/admin/users')).status === 401);
const bad = await get('/api/me', { headers: { Authorization: 'Bearer token.inventado.x' } });
check('un token inventado no entra', bad.status === 401);
const err = await get('/api/rides/abc/detail');
const errText = await err.text();
check('los errores no muestran detalles internos', !/at \w+ \(|node_modules|SELECT |ER_/.test(errText));

console.log(fails ? `\n${fails} revisión(es) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
