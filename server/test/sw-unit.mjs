// Prueba la lógica del service worker (client/public/sw.js) ejecutándolo en un entorno simulado.
// El navegador automático no tiene dónde mostrar notificaciones, así que esto se comprueba aquí, de forma determinista.
import fs from 'fs';
import vm from 'vm';

const src = fs.readFileSync(new URL('../../client/public/sw.js', import.meta.url), 'utf8');
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

function load({ windows = [] } = {}) {
  const handlers = {};
  const shown = [];
  const opened = [];
  const focused = [];
  const wins = windows.map((w) => ({ ...w, focus: async () => focused.push(w.id) }));
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    registration: { showNotification: async (title, options) => { shown.push({ title, options }); } },
    clients: { matchAll: async () => wins, openWindow: async (url) => { opened.push(url); }, claim: async () => {} },
    skipWaiting: () => {},
    location: { origin: 'http://localhost' },
  };
  const cache = { addAll: async () => {}, put: async () => {}, };
  const ctx = vm.createContext({ self, location: self.location, URL, Promise, JSON, caches: { open: async () => cache, keys: async () => [], match: async () => undefined, delete: async () => true }, fetch: async () => ({ ok: true, clone: () => ({}) }), console });
  vm.runInContext(src, ctx);
  const dispatch = async (type, event) => {
    const waits = [];
    handlers[type]({ ...event, waitUntil: (p) => waits.push(p) });
    await Promise.all(waits);
  };
  return { dispatch, shown, opened, focused, handlers };
}

// ---- push ----
{
  const sw = load();
  await sw.dispatch('push', { data: { json: () => ({ title: '🆘 EMERGENCIA', body: 'Ana pidió ayuda', tag: 'sos-1', url: '/panel', requireInteraction: true }), text: () => '' } });
  const n = sw.shown[0];
  check('un push se muestra como notificación con su título y texto', sw.shown.length === 1 && n.title === '🆘 EMERGENCIA' && n.options.body === 'Ana pidió ayuda');
  check('lleva el ícono de la app y vibración', n.options.icon === '/icons/icon-192.png' && n.options.badge === '/icons/icon-192.png' && Array.isArray(n.options.vibrate));
  check('guarda a dónde ir al tocarla', n.options.data.url === '/panel');
  check('las emergencias no desaparecen solas', n.options.requireInteraction === true);
  check('con identificador, una nueva reemplaza a la anterior y vuelve a sonar', n.options.tag === 'sos-1' && n.options.renotify === true);
}
{
  const sw = load();
  await sw.dispatch('push', { data: { json: () => ({ title: 'Oferta', body: 'L 90' }), text: () => '' } });
  const o = sw.shown[0].options;
  check('sin identificador no se fuerza a reemplazar', !o.tag && o.renotify === false);
  check('una notificación normal sí desaparece sola', o.requireInteraction === false);
  check('sin dirección abre la pantalla principal', o.data.url === '/');
}
{
  const sw = load();
  await sw.dispatch('push', { data: { json: () => { throw new Error('no es json'); }, text: () => 'mensaje en texto plano' } });
  check('un mensaje que no es JSON igual se muestra, con el título por defecto', sw.shown[0].title === 'Jalón' && sw.shown[0].options.body === 'mensaje en texto plano');
}
{
  const sw = load();
  await sw.dispatch('push', {});
  check('un push vacío no rompe nada: muestra una notificación genérica', sw.shown.length === 1 && sw.shown[0].title === 'Jalón' && sw.shown[0].options.body === '');
}
{
  const sw = load();
  await sw.dispatch('push', { data: { json: () => ({ body: 'sin título' }), text: () => '' } });
  check('sin título usa "Jalón"', sw.shown[0].title === 'Jalón');
}

// ---- tocar la notificación ----
{
  let closed = false;
  const sw = load({ windows: [{ id: 'w1' }] });
  await sw.dispatch('notificationclick', { notification: { close: () => { closed = true; }, data: { url: '/' } } });
  check('al tocarla se cierra la notificación', closed);
  check('si la app ya está abierta, se trae al frente (no se abre otra)', sw.focused.length === 1 && sw.opened.length === 0);
}
{
  const sw = load({ windows: [] });
  await sw.dispatch('notificationclick', { notification: { close() {}, data: { url: '/viaje' } } });
  check('si la app está cerrada, se abre en la dirección indicada', sw.opened.length === 1 && sw.opened[0] === '/viaje');
}
{
  const sw = load({ windows: [] });
  await sw.dispatch('notificationclick', { notification: { close() {}, data: undefined } });
  check('sin datos abre la pantalla principal', sw.opened[0] === '/');
}

// ---- el service worker nunca guarda la API ni los sockets ----
{
  const sw = load();
  const responded = [];
  const fetchEvent = (url, mode = 'cors', method = 'GET') => ({ request: { method, url, mode }, respondWith: (p) => responded.push(p) });
  for (const url of ['http://localhost/api/login', 'http://localhost/api/admin/users', 'http://localhost/socket.io/?EIO=4', 'https://a.tile.openstreetmap.org/15/1/2.png', 'https://fcm.googleapis.com/x']) {
    sw.handlers.fetch(fetchEvent(url));
  }
  sw.handlers.fetch(fetchEvent('http://localhost/api/ride', 'cors', 'POST'));
  check('la API, los sockets, los mapas y los envíos nunca pasan por el service worker', responded.length === 0);
  sw.handlers.fetch(fetchEvent('http://localhost/', 'navigate'));
  sw.handlers.fetch(fetchEvent('http://localhost/assets/index-abc.js'));
  check('las páginas y los archivos de la app sí', responded.length === 2);
}

console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exit(fails ? 1 : 0);
