// Eliminar una cuenta (anonimizarla) y avisar a los contactos de confianza cuando empieza un viaje
import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { sendSms } from '../sms.js';
import { toE164 } from '../phone.js';
import { UPLOADS, PUBLIC_URL } from '../config.js';
import { tempPassword } from '../util.js';
import { kickUser } from './rides.js';

// Eliminar una cuenta = anonimizarla: se borran sus datos personales y documentos; los viajes quedan sin direcciones para estadísticas y reclamos
export async function anonymizeUser(t) {
  await kickUser(t.id); // cancela sus viajes y cierra sus conexiones
  const [docs] = await pool.query('SELECT file FROM documents WHERE user_id = ?', [t.id]);
  for (const d of docs) await fs.rm(path.join(UPLOADS, d.file), { force: true });
  await pool.query('DELETE FROM documents WHERE user_id = ?', [t.id]);
  const [selfies] = await pool.query('SELECT file FROM driver_selfies WHERE driver_id = ?', [t.id]);
  for (const s of selfies) await fs.rm(path.join(UPLOADS, s.file), { force: true });
  await pool.query('DELETE FROM driver_selfies WHERE driver_id = ?', [t.id]);
  await pool.query('DELETE FROM passkeys WHERE user_id = ?', [t.id]); // sus llaves de Face ID / huella
  await pool.query('DELETE FROM otp_codes WHERE phone = ?', [t.phone]);
  await pool.query('UPDATE ratings SET comment = NULL WHERE rater_id = ?', [t.id]);
  await pool.query("UPDATE messages SET text = '[mensaje eliminado]' WHERE sender_id = ?", [t.id]);
  await pool.query('DELETE FROM favorite_places WHERE user_id = ?', [t.id]);
  await pool.query('DELETE FROM trusted_contacts WHERE user_id = ?', [t.id]);
  await pool.query('DELETE FROM notifications WHERE user_id = ?', [t.id]);
  // Alquileres: los pendientes se cancelan y se borran sus datos personales (recogida, notas y comprobantes); los montos se conservan
  await pool.query("UPDATE rental_bookings SET status = 'cancelled', cancelled_by = 'admin' WHERE (renter_id = ? OR owner_driver_id = ?) AND status IN ('requested','confirmed')", [t.id, t.id]);
  const [rentalReceipts] = await pool.query('SELECT receipt_file FROM rental_bookings WHERE renter_id = ? AND receipt_file IS NOT NULL', [t.id]);
  for (const r of rentalReceipts) await fs.rm(path.join(UPLOADS, r.receipt_file), { force: true });
  await pool.query("UPDATE rental_bookings SET pickup_text = NULL, note = NULL, receipt_file = NULL, receipt_hash = NULL, reference = '[eliminado]', reference_key = NULL WHERE renter_id = ?", [t.id]);
  // Su vehículo se borra y la placa queda libre. Si ya aparece en alquileres, se conserva sin datos para no romper ese historial.
  const [[rented]] = await pool.query('SELECT COUNT(*) AS n FROM rental_bookings b JOIN vehicles v ON v.id = b.vehicle_id WHERE v.driver_id = ?', [t.id]);
  if (rented.n) {
    await pool.query("UPDATE rental_listings l JOIN vehicles v ON v.id = l.vehicle_id SET l.active = 0 WHERE v.driver_id = ?", [t.id]);
    await pool.query("UPDATE vehicles SET plate = CONCAT('DEL', id), make = NULL, model = NULL, color = NULL, year = NULL WHERE driver_id = ?", [t.id]);
  } else {
    await pool.query('DELETE FROM vehicles WHERE driver_id = ?', [t.id]);
  }
  // Los comprobantes de transferencia se borran; los montos del libro de cuentas se conservan (son registros contables)
  const [receipts] = await pool.query('SELECT receipt_file FROM topups WHERE driver_id = ? AND receipt_file IS NOT NULL', [t.id]);
  for (const r of receipts) await fs.rm(path.join(UPLOADS, r.receipt_file), { force: true });
  await pool.query("UPDATE topups SET receipt_file = NULL, receipt_hash = NULL, reference = '[eliminado]', reference_key = NULL WHERE driver_id = ?", [t.id]);
  await pool.query("UPDATE reports SET text = '[reporte eliminado]' WHERE user_id = ?", [t.id]);
  await pool.query('UPDATE rides SET origin_text = NULL, dest_text = NULL, share_token = NULL WHERE passenger_id = ? OR driver_id = ?', [t.id, t.id]);
  // El camino real de sus viajes y sus horas conectado también se borran
  await pool.query('DELETE p FROM ride_points p JOIN rides r ON r.id = p.ride_id WHERE r.passenger_id = ? OR r.driver_id = ?', [t.id, t.id]);
  await pool.query('DELETE FROM driver_sessions WHERE driver_id = ?', [t.id]);
  await pool.query(
    `UPDATE users SET name = 'Cuenta eliminada', phone = ?, email = NULL, password_hash = ?, vehicle = NULL, plate = NULL, status = 'blocked',
            must_change_password = 0, totp_enabled = 0, totp_secret = NULL, backup_codes = NULL, totp_last_step = NULL,
            deleted_at = NOW(), token_version = token_version + 1 WHERE id = ?`,
    [`del-${t.id}`, await bcrypt.hash(tempPassword() + tempPassword(), 10), t.id]
  );
}

// Al empezar el viaje, cada contacto de confianza recibe un SMS con el enlace para seguirlo en vivo
export async function shareWithContacts(ride) {
  const [contacts] = await pool.query('SELECT name, phone FROM trusted_contacts WHERE user_id = ?', [ride.passenger_id]);
  if (!contacts.length) return;
  let token = ride.share_token;
  if (!token) {
    token = crypto.randomBytes(16).toString('base64url');
    await pool.query('UPDATE rides SET share_token = ? WHERE id = ?', [token, ride.id]);
  }
  const [[p]] = await pool.query('SELECT name FROM users WHERE id = ?', [ride.passenger_id]);
  const link = `${PUBLIC_URL || 'http://localhost:5173'}/t/${token}`;
  // Sin tildes ni emojis para que sea un solo SMS barato
  const text = `Ktracho GO: ${p.name.split(' ')[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '')} inicio un viaje y te eligio como contacto de confianza. Sigue su viaje en vivo: ${link}`;
  const results = await Promise.allSettled(contacts.map((c) => sendSms(toE164(c.phone), text)));
  results.forEach((r, i) => r.status === 'rejected' && console.error(`Contacto de confianza: no se pudo avisar a ${contacts[i].phone}:`, r.reason?.message));
}
