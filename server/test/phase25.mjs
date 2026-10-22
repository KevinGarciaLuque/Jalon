import 'dotenv/config';
// Campanita de notificaciones: se guardan los avisos, el chat se agrupa, se marcan como leídos,
// y al celular llegan aunque el socket siga conectado si la app no está a la vista
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin, startFakePush } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
const bell = (token) => http('GET', 'notifications', token);
const fake = await startFakePush();
const sockets = [];

try {
  const root = await createTestSuperadmin(pool);
  const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const P = await registerUser({ name: 'C25 Pasajera', phone: `83${rnd}5`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const D = await registerUser({ name: 'C25 Conductor', phone: `93${rnd}5`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', model: 'Yaris', plate: `C${rnd}` });
  const dDev = fake.device(`d${rnd}`);
  check('el conductor activa las notificaciones del celular', (await http('POST', 'push/subscribe', D.token, { subscription: dDev.subscription })).status === 200);

  check('al principio la campanita está vacía', (await bell(D.token)).unread === 0 && (await bell(D.token)).items.length === 0);
  check('sin sesión no hay campanita', (await http('GET', 'notifications')).status === 401);

  // Cuenta aprobada (aviso nuevo): a la campanita y al celular
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  await wait(400);
  let b = await bell(D.token);
  const approved = b.items.find((n) => n.kind === 'account');
  check('al aprobar al conductor le llega «¡Tu cuenta fue aprobada!»', !!approved && /aprobada/.test(approved.title) && b.unread === 1);
  check('y también al celular', dDev.messages().some((m) => /aprobada/.test(m.title)));

  // Chat en un viaje aceptado
  const [ride] = await pool.query("INSERT INTO rides (passenger_id, driver_id, origin_lat, origin_lng, dest_lat, dest_lng, dest_text, distance_km, offered_price, final_price, status) VALUES (?, ?, 14.07, -87.19, 14.1, -87.2, 'Centro', 4, 80, 80, 'accepted')", [P.user.id, D.user.id]);
  const rideId = ride.insertId;
  const ps = await connect(P.token);
  const ds = await connect(D.token);
  sockets.push(ps, ds);
  const live = [];
  ds.on('notify:new', (e) => live.push(e));
  const send = (text) => new Promise((r) => ps.emit('chat:send', { rideId, text }, r));
  const pushedBefore = dDev.messages().length;
  await send('Hola, ya salí');
  await send('Estoy en la esquina');
  await wait(500);
  b = await bell(D.token);
  const chat = b.items.filter((n) => n.kind === 'chat');
  check('los mensajes del chat de un viaje se juntan en un solo aviso', chat.length === 1 && chat[0].count === 2 && chat[0].body === 'Estoy en la esquina', JSON.stringify(chat));
  check('el número de la campanita se actualiza al momento', live.length >= 2 && live[live.length - 1].unread === b.unread);
  check('con la app a la vista no se manda al celular (ya lo está viendo)', dDev.messages().length === pushedBefore);

  // La app pasa a segundo plano: el socket sigue conectado, pero el aviso va al celular
  ds.emit('app:visible', false);
  await wait(200);
  await send('¿Dónde estás?');
  await wait(600);
  check('con la app minimizada el mensaje llega al celular aunque siga conectada', dDev.messages().some((m) => m.body === '¿Dónde estás?'));
  check('y en la campanita sigue siendo un solo aviso (3 mensajes)', (await bell(D.token)).items.filter((n) => n.kind === 'chat')[0].count === 3);
  ds.emit('app:visible', true);

  // Abrir el chat lo marca como leído
  const readEvent = new Promise((r) => ds.once('notify:read', r));
  ds.emit('chat:read', { rideId });
  const ev = await Promise.race([readEvent, wait(2000).then(() => null)]);
  b = await bell(D.token);
  check('al abrir el chat, su aviso queda leído', b.items.find((n) => n.kind === 'chat').read === true && ev?.unread === b.unread);

  // Calificación (aviso nuevo)
  await pool.query("UPDATE rides SET status = 'completed', completed_at = NOW() WHERE id = ?", [rideId]);
  await http('POST', `rides/${rideId}/rate`, P.token, { stars: 5, comment: 'Muy amable' });
  await wait(300);
  b = await bell(D.token);
  const rated = b.items.find((n) => n.kind === 'rating');
  check('al conductor le llega «Te calificaron» con las estrellas', !!rated && rated.title.includes('★★★★★') && rated.body === 'Muy amable');

  // Documento rechazado (aviso nuevo)
  const [[doc]] = await pool.query('SELECT id FROM documents WHERE user_id = ? LIMIT 1', [D.user.id]);
  await http('POST', `admin/documents/${doc.id}/reject`, SA, { note: 'Se ve borrosa' });
  await wait(300);
  const rejected = (await bell(D.token)).items.find((n) => n.kind === 'docs');
  check('si rechazan un documento, le llega con el motivo', !!rejected && rejected.body.includes('Se ve borrosa') && rejected.target === 'docs');

  // Personal: le llega aunque no haya activado las notificaciones del celular, y lleva a su pestaña
  await http('POST', `rides/${rideId}/report`, P.token, { type: 'other', text: 'Prueba de la campanita' });
  await wait(400);
  const staffItem = (await bell(SA)).items.find((n) => n.kind === 'report');
  check('al personal le llega «Nuevo reporte» en la campanita aunque no tenga el celular suscrito', !!staffItem && staffItem.target === 'reports');
  check('el panel puede consultar solo el número', (await http('GET', 'notifications/unread', SA)).unread >= 1);

  // Marcar como leídas
  const mine = (await bell(D.token)).items;
  const before = (await bell(SA)).unread;
  await http('POST', 'notifications/read', SA, { ids: mine.map((n) => n.id) });
  check('nadie puede marcar como leídas las notificaciones de otra persona', (await bell(D.token)).unread === mine.filter((n) => !n.read).length && (await bell(SA)).unread === before);
  const one = await http('POST', 'notifications/read', D.token, { ids: [mine.find((n) => !n.read).id] });
  check('marcar una como leída', one.ok && one.unread === mine.filter((n) => !n.read).length - 1);
  const all = await http('POST', 'notifications/read', D.token, {});
  check('marcar todas como leídas', all.unread === 0 && (await bell(D.token)).items.every((n) => n.read));
  check('una lista vacía de ids se rechaza', (await http('POST', 'notifications/read', D.token, { ids: [] })).status === 400);

  // Se borran a los 30 días y al eliminar la cuenta
  await pool.query('UPDATE notifications SET updated_at = NOW() - INTERVAL 31 DAY WHERE user_id = ? AND kind = ?', [D.user.id, 'account']);
  const { purgeNotifications } = await import('../src/notify.js');
  await purgeNotifications();
  check('las de más de 30 días se borran', !(await bell(D.token)).items.some((n) => n.kind === 'account'));
  await http('POST', `admin/users/${D.user.id}/delete`, SA, {});
  const [[left]] = await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ?', [D.user.id]);
  check('al eliminar la cuenta se borran sus notificaciones', left.n === 0);
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
  fake.stop();
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
