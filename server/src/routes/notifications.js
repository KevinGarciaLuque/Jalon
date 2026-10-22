// La campanita: las últimas notificaciones de cada persona (pasajero, conductor o personal) y marcarlas como leídas
import { pool } from '../db.js';
import { app, io } from '../app.js';
import { room } from '../live.js';
import { authUser } from '../access.js';
import { unreadCount } from '../notify.js';

const view = (n) => ({ id: n.id, kind: n.kind, title: n.title, body: n.body, count: n.count, target: n.target, read: !!n.read_at, at: n.updated_at });

app.get('/api/notifications', authUser, async (req, res) => {
  const [rows] = await pool.query('SELECT * FROM notifications WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 50', [req.user.id]);
  res.json({ unread: await unreadCount(req.user.id), items: rows.map(view) });
});

// Solo el número (el panel lo consulta cada pocos segundos)
app.get('/api/notifications/unread', authUser, async (req, res) => {
  res.json({ unread: await unreadCount(req.user.id) });
});

// Marcar como leídas: las indicadas, o todas si no se indica ninguna
app.post('/api/notifications/read', authUser, async (req, res) => {
  const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isInteger).slice(0, 100) : null;
  if (ids && !ids.length) return res.status(400).json({ error: 'Nada que marcar' });
  await pool.query(
    `UPDATE notifications SET read_at = NOW(), updated_at = updated_at WHERE user_id = ? AND read_at IS NULL${ids ? ' AND id IN (?)' : ''}`,
    ids ? [req.user.id, ids] : [req.user.id]
  );
  const unread = await unreadCount(req.user.id);
  io.to(room(req.user.id)).emit('notify:read', { unread }); // los otros dispositivos de la persona también se ponen al día
  res.json({ ok: true, unread });
});
