// Notificaciones al celular (Web Push): a una persona o al personal con cierto permiso
import { pool } from './db.js';
import { sendPush, pushEnabled } from './push.js';
import { reportError } from './config.js';
import { io } from './app.js';
import { room } from './live.js';
import { permsFor } from './perms.js';

// ---------- Notificaciones push ----------
const hasLiveSocket = async (userId) => (await io.in(room(userId)).fetchSockets()).length > 0;

// Avisa a todos los dispositivos de una persona. Por defecto solo si no tiene la app abierta (si la tiene, ya se enteró por el socket).
async function notifyUser(userId, payload, { always = false } = {}) {
  if (!pushEnabled || (!always && (await hasLiveSocket(userId)))) return;
  const [subs] = await pool.query('SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?', [userId]);
  await Promise.all(subs.map(async (s) => {
    // 404/410: el dispositivo ya no existe (desinstalaron la app o quitaron el permiso): se borra la suscripción
    if ((await sendPush(s, payload)) === 'gone') await pool.query('DELETE FROM push_subscriptions WHERE id = ?', [s.id]);
  }));
}
// Al personal siempre se le avisa (no usa sockets); solo a quienes tienen el permiso indicado
async function notifyStaff(payload, perm = 'alerts') {
  if (!pushEnabled) return;
  const [rows] = await pool.query("SELECT DISTINCT u.id, u.role FROM push_subscriptions p JOIN users u ON u.id = p.user_id WHERE u.role IN ('superadmin','admin','support') AND u.status = 'active'");
  const allowed = [];
  for (const u of rows) if ((await permsFor(u)).includes(perm)) allowed.push(u);
  await Promise.all(allowed.map((u) => notifyUser(u.id, payload, { always: true })));
}
export const push = (userId, payload, opts) => notifyUser(userId, payload, opts).catch(reportError); // sin esperar: nunca retrasa la respuesta
export const pushStaff = (payload, perm) => notifyStaff(payload, perm).catch(reportError);
export const hasPushSub = async (userId) => pushEnabled && (await pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1', [userId]))[0].length > 0;
