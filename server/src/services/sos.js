// Emergencias (botón SOS): SMS al equipo y recordatorios mientras nadie la atienda
import { pool } from '../db.js';
import { sendSms } from '../sms.js';
import { toE164 } from '../phone.js';
import { isProd, SOS_PHONES, SOS_REMINDER_MIN, SOS_MAX_NOTICES, PUBLIC_URL } from '../config.js';

// SMS al equipo con lo esencial (sin tildes ni emojis para que cada SMS sea de un solo tramo y no cueste de más)
export async function notifySos(alertId, reminder) {
  const [[a]] = await pool.query(
    `SELECT a.id, a.ride_id, a.lat, a.lng, a.status, a.notified_count, u.name, u.phone, u.role
     FROM alerts a JOIN users u ON u.id = a.user_id WHERE a.id = ?`, [alertId]
  );
  if (!a || a.status !== 'open') return;
  const where = a.lat != null ? ` Mapa: https://maps.google.com/?q=${a.lat},${a.lng}` : ' Sin ubicacion.';
  const text = `${reminder ? 'RECORDATORIO ' : ''}JALON SOS #${a.id}: ${a.name} (${a.role === 'driver' ? 'conductor' : 'pasajero'}) en viaje ${a.ride_id}. Tel ${a.phone}.${where}${PUBLIC_URL ? ` Panel: ${PUBLIC_URL}` : ''}`;
  await pool.query('UPDATE alerts SET notified_count = notified_count + 1, last_notified_at = NOW() WHERE id = ?', [alertId]);
  if (!SOS_PHONES.length) return console.warn('⚠ SOS sin SMS: define SOS_ALERT_PHONES para que alguien reciba las emergencias');
  const results = await Promise.allSettled(SOS_PHONES.map((p) => sendSms(toE164(p), text)));
  results.forEach((r, i) => r.status === 'rejected' && console.error(`SOS: no se pudo avisar a ${SOS_PHONES[i]}:`, r.reason?.message));
}

// Una emergencia que nadie atiende se vuelve a avisar cada SOS_REMINDER_MIN minutos
export async function remindOpenAlerts() {
  const [rows] = await pool.query(
    `SELECT id FROM alerts WHERE status = 'open' AND notified_count BETWEEN 1 AND ? AND last_notified_at < NOW() - INTERVAL ? MINUTE`,
    [SOS_MAX_NOTICES - 1, SOS_REMINDER_MIN]
  );
  for (const a of rows) await notifySos(a.id, true);
}

if (isProd && !SOS_PHONES.length) console.warn('⚠ SOS_ALERT_PHONES no está definido: las emergencias solo se ven en el panel');
