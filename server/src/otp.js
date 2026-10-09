// Códigos de verificación de un solo uso (registro y recuperación de contraseña)
import crypto from 'crypto';
import { pool } from './db.js';

const TTL_MIN = 10;
const COOLDOWN_SEC = 60;
const MAX_PER_HOUR = 5;
const MAX_ATTEMPTS = 5;
const KEY = process.env.JWT_SECRET || 'dev-secret';

const hash = (phone, purpose, code) => crypto.createHmac('sha256', KEY).update(`${phone}:${purpose}:${code}`).digest('hex');

export class OtpError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

// Crea un código nuevo e invalida los anteriores. La espera de 60 s es por tipo de código; el tope por hora, por teléfono. Devuelve el código en claro para enviarlo por SMS.
export async function createOtp(phone, purpose, email = null) {
  const [[recent]] = await pool.query(
    `SELECT SUM(purpose = ? AND created_at > NOW() - INTERVAL ? SECOND) AS cooling, COUNT(*) AS hour
     FROM otp_codes WHERE phone = ? AND created_at > NOW() - INTERVAL 1 HOUR`,
    [purpose, COOLDOWN_SEC, phone]
  );
  if (Number(recent.cooling) > 0) throw new OtpError(`Espera ${COOLDOWN_SEC} segundos antes de pedir otro código`, 429);
  if (recent.hour >= MAX_PER_HOUR) throw new OtpError('Pediste demasiados códigos. Intenta de nuevo en una hora.', 429);

  const code = String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  await pool.query('UPDATE otp_codes SET used = 1 WHERE phone = ? AND purpose = ? AND used = 0', [phone, purpose]);
  await pool.query(
    `INSERT INTO otp_codes (phone, purpose, code_hash, expires_at, email) VALUES (?,?,?, NOW() + INTERVAL ? MINUTE, ?)`,
    [phone, purpose, hash(phone, purpose, code), TTL_MIN, email]
  );
  return code;
}

// Verifica y consume el código (una sola vez). Tras 5 intentos fallidos el código queda inutilizable.
// Con `email`, el código solo vale si se envió a ese mismo correo (el que quedará en la cuenta).
export async function consumeOtp(phone, purpose, code, email) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code.trim())) return false;
  const [rows] = await pool.query(
    'SELECT * FROM otp_codes WHERE phone = ? AND purpose = ? AND used = 0 AND expires_at > NOW() ORDER BY id DESC LIMIT 1',
    [phone, purpose]
  );
  const o = rows[0];
  if (!o || o.attempts >= MAX_ATTEMPTS) return false;
  if (email !== undefined && (o.email || null) !== (email || null)) {
    await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [o.id]);
    return false;
  }
  const given = Buffer.from(hash(phone, purpose, code.trim()));
  const stored = Buffer.from(o.code_hash);
  if (!crypto.timingSafeEqual(given, stored)) {
    await pool.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = ?', [o.id]);
    return false;
  }
  const [r] = await pool.query('UPDATE otp_codes SET used = 1 WHERE id = ? AND used = 0', [o.id]);
  return r.affectedRows === 1;
}
