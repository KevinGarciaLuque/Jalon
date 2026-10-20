// Registro, ingreso, códigos de verificación, contraseñas y verificación en dos pasos
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { pool } from '../db.js';
import { normalizePhone, toE164 } from '../phone.js';
import { createOtp, consumeOtp, OtpError } from '../otp.js';
import { sendSms } from '../sms.js';
import { sendMail, normalizeEmail, domainAcceptsMail } from '../mail.js';
import { encryptText, decryptText } from '../secure.js';
import { TERMS_VERSION } from '../legal.js';
import { generateSecret, verifyTotp, otpauthUrl, generateBackupCodes, hashBackup } from '../totp.js';
import { JWT_SECRET, OTP_CHANNELS, echoCode } from '../config.js';
import { app, loginLimiter, registerLimiter, otpLimiter } from '../app.js';
import { sign, checkPassword, twoFactorRequired, publicUser, authUser, isStaff, audit } from '../access.js';

// ---------- Auth ----------
app.post('/api/register', registerLimiter, async (req, res) => {
  try {
    const { name, phone, password, role, vehicle, plate, code, acceptTerms } = req.body || {};
    const email = normalizeEmail(req.body?.email);
    if ([name, phone, password].some((v) => typeof v !== 'string' || !v.trim()) || !['passenger', 'driver'].includes(role))
      return res.status(400).json({ error: 'Datos incompletos' });
    if ([vehicle, plate].some((v) => v != null && typeof v !== 'string'))
      return res.status(400).json({ error: 'Datos inválidos' });
    if (role === 'driver' && (!vehicle || !plate))
      return res.status(400).json({ error: 'El conductor debe indicar vehículo y placa' });
    const phoneN = normalizePhone(phone);
    if (!phoneN) return res.status(400).json({ error: 'Teléfono inválido (8 dígitos de Honduras)' });
    if (!email) return res.status(400).json({ error: 'Escribe un correo electrónico válido' });
    const weak = checkPassword(password, { phone: phoneN, role });
    if (weak) return res.status(400).json({ error: weak });
    if (name.length > 100 || (vehicle || '').length > 100 || (plate || '').length > 20)
      return res.status(400).json({ error: 'Algún dato es demasiado largo' });
    if (acceptTerms !== true) return res.status(400).json({ error: 'Debes aceptar los Términos y la Política de Privacidad' });
    // El código se envió al correo (o al SMS) y solo vale para ese correo; se consume al final de las validaciones
    if (!(await consumeOtp(phoneN, 'register', code, email))) return res.status(400).json({ error: 'Código incorrecto o vencido' });

    const hash = await bcrypt.hash(password, 10);
    // Los conductores quedan pendientes hasta que un administrador los apruebe
    const status = role === 'driver' ? 'pending' : 'active';
    const [r] = await pool.query(
      'INSERT INTO users (name, phone, email, password_hash, role, status, vehicle, plate, terms_accepted_at, terms_version) VALUES (?,?,?,?,?,?,?,?,NOW(),?)',
      [name.trim(), phoneN, email, hash, role, status, vehicle?.trim() || null, plate?.trim() || null, TERMS_VERSION]
    );
    const user = { id: r.insertId, name: name.trim(), phone: phoneN, email, role, status, vehicle, plate };
    res.json({ token: sign(user), user: publicUser(user) });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: /email/.test(e.message) ? 'Ese correo ya está registrado' : 'Ese teléfono ya está registrado' });
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

app.post('/api/login', loginLimiter, async (req, res) => {
  try {
    const { phone, password } = req.body || {};
    if (typeof phone !== 'string' || typeof password !== 'string')
      return res.status(400).json({ error: 'Datos incompletos' });
    const [rows] = await pool.query('SELECT * FROM users WHERE phone = ?', [normalizePhone(phone) ?? phone.trim()]);
    const u = rows[0];
    if (!u || !(await bcrypt.compare(password, u.password_hash)))
      return res.status(401).json({ error: 'Teléfono o contraseña incorrectos' });
    if (u.status === 'blocked') return res.status(403).json({ error: 'Tu cuenta está bloqueada. Contacta a soporte.' });
    // Personal con verificación en dos pasos: la contraseña sola no da sesión; se devuelve un desafío válido 5 minutos
    // (si el superadmin apagó la verificación en dos pasos, basta la contraseña)
    const require2fa = isStaff(u.role) && (await twoFactorRequired());
    if (require2fa && u.totp_enabled) {
      return res.json({ twoFactor: true, challenge: jwt.sign({ id: u.id, purpose: '2fa' }, JWT_SECRET, { expiresIn: '5m' }) });
    }
    res.json({ token: sign(u), user: publicUser(u, require2fa) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

// Envía el código por los canales activos. El correo va a `email`; el SMS al teléfono. Con al menos un envío logrado alcanza.
async function sendCode(phone, purpose, email) {
  const code = await createOtp(phone, purpose, email);
  const text = `Jalón: tu código es ${code}. Vence en 10 minutos. No lo compartas con nadie.`;
  const jobs = [];
  if (OTP_CHANNELS.includes('email') && email) jobs.push(sendMail(email, `Tu código de Jalón: ${code}`, `${text}\n\nSi no lo pediste tú, ignora este mensaje.`));
  if (OTP_CHANNELS.includes('sms')) jobs.push(sendSms(toE164(phone), text));
  const results = await Promise.allSettled(jobs);
  results.filter((r) => r.status === 'rejected').forEach((r) => console.error('Código de verificación:', r.reason?.message));
  if (!results.some((r) => r.status === 'fulfilled')) throw new OtpError('No se pudo enviar el código. Intenta de nuevo en un momento.', 502);
  return code;
}
const sendError = (res, e) => (e instanceof OtpError ? res.status(e.status).json({ error: e.message }) : Promise.reject(e));

// Paso 1 del registro: enviar el código al correo (y al SMS si ese canal está activo)
app.post('/api/otp/send', otpLimiter, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'Teléfono inválido (8 dígitos de Honduras)' });
  const email = normalizeEmail(req.body?.email);
  if (!email) return res.status(400).json({ error: 'Escribe un correo electrónico válido' });
  if (!(await domainAcceptsMail(email))) return res.status(400).json({ error: 'Ese correo no parece existir. Revisa cómo lo escribiste.' });
  const [rows] = await pool.query('SELECT phone, email FROM users WHERE phone = ? OR email = ?', [phone, email]);
  if (rows.some((r) => r.phone === phone)) return res.status(409).json({ error: 'Ese teléfono ya está registrado' });
  if (rows.length) return res.status(409).json({ error: 'Ese correo ya está registrado' });
  try {
    const code = await sendCode(phone, 'register', email);
    res.json({ ok: true, ...(echoCode ? { devCode: code } : {}) });
  } catch (e) {
    sendError(res, e);
  }
});

// Recuperar contraseña: siempre responde igual, exista o no la cuenta (no revela qué teléfonos están registrados)
app.post('/api/password/forgot', otpLimiter, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'Teléfono inválido (8 dígitos de Honduras)' });
  // Las cuentas de administrador no se recuperan por SMS
  const [rows] = await pool.query("SELECT id, email FROM users WHERE phone = ? AND role IN ('passenger','driver') AND status <> 'blocked' AND deleted_at IS NULL", [phone]);
  let code = null;
  // El código va al correo registrado en la cuenta (o al SMS si ese canal está activo); una cuenta sin correo y sin SMS no puede recuperarse sola
  if (rows[0] && (rows[0].email || OTP_CHANNELS.includes('sms'))) {
    try {
      code = await sendCode(phone, 'reset', rows[0].email);
    } catch (e) {
      return sendError(res, e);
    }
  }
  res.json({ ok: true, ...(echoCode && code ? { devCode: code } : {}) });
});

app.post('/api/password/reset', otpLimiter, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  const { code, password } = req.body || {};
  const weak = phone ? checkPassword(password, { phone }) : 'Teléfono inválido (8 dígitos de Honduras)';
  if (weak) return res.status(400).json({ error: weak });
  const [rows] = await pool.query("SELECT id FROM users WHERE phone = ? AND role IN ('passenger','driver') AND status <> 'blocked' AND deleted_at IS NULL", [phone]);
  if (!rows[0] || !(await consumeOtp(phone, 'reset', code))) return res.status(400).json({ error: 'Código incorrecto o vencido' });
  // token_version + 1 cierra todas las sesiones abiertas con la contraseña anterior
  await pool.query('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(password, 10), rows[0].id]);
  res.json({ ok: true });
});

// Cambiar la contraseña conociendo la actual. Cierra las demás sesiones y devuelve un token nuevo para esta.
app.post('/api/password/change', authUser, loginLimiter, async (req, res) => {
  const { current, password } = req.body || {};
  if (typeof current !== 'string') return res.status(400).json({ error: 'Falta la contraseña actual' });
  const weak = checkPassword(password, { phone: req.user.phone, role: req.user.role });
  if (weak) return res.status(400).json({ error: weak });
  if (!(await bcrypt.compare(current, req.user.password_hash))) return res.status(403).json({ error: 'La contraseña actual es incorrecta' });
  if (current === password) return res.status(400).json({ error: 'La contraseña nueva debe ser distinta de la actual' });
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = 0, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(password, 10), req.user.id]);
  const [[u]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json({ ok: true, token: sign(u) });
});

// ---------- Verificación en dos pasos (personal) ----------
// Segundo paso del login: código de 6 dígitos de la app, o un código de respaldo (de un solo uso)
async function secondFactorOk(u, code) {
  if (/^\d{6}$/.test(code)) {
    const step = verifyTotp(decryptText(u.totp_secret), code, { lastStep: Number(u.totp_last_step || 0) });
    if (!step) return false;
    // Un mismo código no sirve dos veces: el intervalo usado queda anotado (la condición evita carreras)
    const [r] = await pool.query('UPDATE users SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)', [step, u.id, step]);
    return r.affectedRows === 1;
  }
  const hash = hashBackup(code);
  const list = JSON.parse(u.backup_codes || '[]');
  if (!list.includes(hash)) return false;
  const [r] = await pool.query('UPDATE users SET backup_codes = ? WHERE id = ? AND backup_codes = ?', [JSON.stringify(list.filter((h) => h !== hash)), u.id, u.backup_codes]);
  return r.affectedRows === 1;
}

app.post('/api/login/2fa', loginLimiter, async (req, res) => {
  let payload;
  try {
    payload = jwt.verify(String(req.body?.challenge || ''), JWT_SECRET);
  } catch {
    return res.status(401).json({ error: 'La verificación venció: vuelve a escribir tu contraseña' });
  }
  if (payload.purpose !== '2fa') return res.status(401).json({ error: 'No autorizado' });
  const [rows] = await pool.query('SELECT *, (two_fa_locked_until > NOW()) AS locked FROM users WHERE id = ?', [payload.id]);
  const u = rows[0];
  if (!u || !isStaff(u.role) || !u.totp_enabled || u.status === 'blocked') return res.status(401).json({ error: 'No autorizado' });
  if (u.locked) return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera 15 minutos o pide a otro superadministrador que restablezca tu verificación.' });
  const code = String(req.body?.code || '').trim();
  if (!(await secondFactorOk(u, code))) {
    // 5 errores seguidos bloquean la verificación 15 minutos (aunque cambien de dirección)
    await pool.query(
      // (en un UPDATE de MySQL las asignaciones usan los valores ya cambiados: el bloqueo va primero para leer el contador anterior)
      `UPDATE users SET two_fa_locked_until = IF(two_fa_failures + 1 >= 5, NOW() + INTERVAL 15 MINUTE, two_fa_locked_until),
              two_fa_failures = two_fa_failures + 1 WHERE id = ?`, [u.id]
    );
    await pool.query('UPDATE users SET two_fa_failures = 0 WHERE id = ? AND two_fa_failures >= 5', [u.id]);
    return res.status(401).json({ error: 'Código incorrecto' });
  }
  await pool.query('UPDATE users SET two_fa_failures = 0, two_fa_locked_until = NULL WHERE id = ?', [u.id]);
  res.json({ token: sign(u), user: publicUser(u, await twoFactorRequired()) });
});

// Paso 1 de la activación: se crea un secreto (todavía no vale hasta confirmarlo con un código)
app.post('/api/2fa/setup', authUser, async (req, res) => {
  if (!isStaff(req.user.role)) return res.status(403).json({ error: 'Solo el personal usa la verificación en dos pasos' });
  if (req.user.totp_enabled) return res.status(409).json({ error: 'Ya está activada' });
  const secret = generateSecret();
  await pool.query('UPDATE users SET totp_secret = ?, totp_last_step = NULL WHERE id = ?', [encryptText(secret), req.user.id]);
  res.json({ secret, otpauthUrl: otpauthUrl({ secret, account: req.user.phone }) });
});

// Paso 2: se confirma con un código de la app; se activa y se entregan 10 códigos de respaldo (se muestran una sola vez)
app.post('/api/2fa/enable', authUser, loginLimiter, async (req, res) => {
  const u = req.user;
  if (!isStaff(u.role)) return res.status(403).json({ error: 'Solo el personal usa la verificación en dos pasos' });
  if (u.totp_enabled) return res.status(409).json({ error: 'Ya está activada' });
  if (!u.totp_secret) return res.status(400).json({ error: 'Empieza de nuevo la activación' });
  const step = verifyTotp(decryptText(u.totp_secret), String(req.body?.code || '').trim());
  if (!step) return res.status(400).json({ error: 'Código incorrecto. Revisa que la hora de tu teléfono sea automática.' });
  const codes = generateBackupCodes();
  await pool.query('UPDATE users SET totp_enabled = 1, totp_last_step = ?, backup_codes = ?, two_fa_failures = 0 WHERE id = ?', [step, JSON.stringify(codes.map(hashBackup)), u.id]);
  await audit(u, '2fa.enable');
  res.json({ ok: true, backupCodes: codes });
});

// Códigos de respaldo nuevos (los anteriores dejan de servir). Pide la contraseña.
app.post('/api/2fa/backup-codes', authUser, loginLimiter, async (req, res) => {
  const u = req.user;
  if (!isStaff(u.role) || !u.totp_enabled) return res.status(409).json({ error: 'La verificación en dos pasos no está activa' });
  if (typeof req.body?.password !== 'string' || !(await bcrypt.compare(req.body.password, u.password_hash)))
    return res.status(403).json({ error: 'La contraseña es incorrecta' });
  const codes = generateBackupCodes();
  await pool.query('UPDATE users SET backup_codes = ? WHERE id = ?', [JSON.stringify(codes.map(hashBackup)), u.id]);
  await audit(u, '2fa.backup_codes');
  res.json({ backupCodes: codes });
});
