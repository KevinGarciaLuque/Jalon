// Avisos: se guardan en la campanita de cada persona y, si no tiene la app a la vista, le llegan al celular (Web Push)
import { pool } from './db.js';
import { sendPush, pushEnabled } from './push.js';
import { reportError } from './config.js';
import { io } from './app.js';
import { room } from './live.js';
import { permsFor } from './perms.js';

// ¿Tiene la app abierta y a la vista? La app avisa por el socket cuando pasa a segundo plano o se bloquea la pantalla:
// con la app minimizada el socket puede seguir conectado, pero igual hay que mandar la notificación al celular.
const hasVisibleApp = async (userId) => (await io.in(room(userId)).fetchSockets()).some((s) => s.data.visible !== false);

// Qué tipo de aviso es y a dónde lleva al tocarlo en la campanita (sale de la etiqueta del aviso, si no se indica)
const KINDS = [['chat-', 'chat'], ['offer-', 'offer'], ['ride-', 'ride'], ['topup-', 'wallet'], ['wallet-', 'wallet'], ['report-', 'report'], ['rental', 'rental'], ['sos-', 'sos'], ['docs', 'docs'], ['rate-', 'rating'], ['account', 'account']];
const kindOf = (tag = '') => KINDS.find(([p]) => tag.startsWith(p))?.[1] || 'info';
// En el panel, cada tipo abre su pestaña
const STAFF_TARGET = { sos: 'alerts', report: 'reports', wallet: 'topups', docs: 'users', rental: 'rentals' };
// Los mensajes del chat y las ofertas de un mismo viaje se juntan en uno («3 mensajes nuevos») mientras no se lean
const GROUPED = new Set(['chat', 'offer']);

async function save(userId, payload, kind, target) {
  if (payload.bell === false) return; // avisos que vencen en segundos (p. ej. «Nuevo viaje cerca de ti»): solo al celular
  const title = String(payload.title || '').slice(0, 120);
  const body = payload.body ? String(payload.body).slice(0, 300) : null;
  const tag = payload.tag ? String(payload.tag).slice(0, 80) : null;
  if (GROUPED.has(kind) && tag) {
    const [r] = await pool.query('UPDATE notifications SET title = ?, body = ?, count = count + 1 WHERE user_id = ? AND tag = ? AND read_at IS NULL ORDER BY id DESC LIMIT 1', [title, body, userId, tag]);
    if (r.affectedRows) return;
  }
  await pool.query('INSERT INTO notifications (user_id, kind, title, body, tag, target) VALUES (?,?,?,?,?,?)', [userId, kind, title, body, tag, target || null]);
}

export const unreadCount = async (userId) => (await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL', [userId]))[0][0].n;

async function sendToPhone(userId, payload) {
  const [subs] = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);
  await Promise.all(subs.map(async (s) => {
    // 404/410: el dispositivo ya no existe (desinstalaron la app o quitaron el permiso): se borra la suscripción
    if ((await sendPush(s, payload)) === 'gone') await pool.query('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
  }));
}

// Un aviso para una persona. `always`: al celular aunque tenga la app a la vista (p. ej. una recarga aprobada)
async function notifyUser(userId, payload, { always = false, staff = false } = {}) {
  const kind = payload.kind || kindOf(payload.tag);
  await save(userId, payload, kind, payload.target || (staff ? STAFF_TARGET[kind] : null));
  if (payload.bell !== false) io.to(room(userId)).emit('notify:new', { unread: await unreadCount(userId), title: payload.title });
  if (pushEnabled && (always || !(await hasVisibleApp(userId)))) await sendToPhone(userId, payload);
}

// Al personal con el permiso indicado: a todos en la campanita (aunque no hayan activado las notificaciones del celular) y al celular a quien las activó
async function notifyStaff(payload, perm = 'alerts') {
  const [rows] = await pool.query("SELECT id, role FROM users WHERE role IN ('superadmin','admin','support') AND status = 'active' AND deleted_at IS NULL");
  for (const u of rows) {
    if ((await permsFor(u)).includes(perm)) await notifyUser(u.id, payload, { always: true, staff: true });
  }
}

export const push = (userId, payload, opts) => notifyUser(userId, payload, opts).catch(reportError); // sin esperar: nunca retrasa la respuesta
export const pushStaff = (payload, perm) => notifyStaff(payload, perm).catch(reportError);
export const hasPushSub = async (userId) => pushEnabled && (await pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1', [userId]))[0].length > 0;

// Se borran a los 30 días
export const purgeNotifications = async () => (await pool.query('DELETE FROM notifications WHERE updated_at < NOW() - INTERVAL 30 DAY'))[0].affectedRows;
