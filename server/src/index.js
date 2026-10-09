import 'dotenv/config';
import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import { pool } from './db.js';
import crypto from 'crypto';
import fs from 'fs/promises';
import { existsSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { distanceKm, suggestedPrice } from './geo.js';
import { searchPlaces, reversePlace, getRoute } from './maps.js';
import { normalizePhone, toE164 } from './phone.js';
import { createOtp, consumeOtp, OtpError } from './otp.js';
import { sendSms, smsConfigured } from './sms.js';
import { sanitizeJpeg } from './jpeg.js';
import { encryptBuffer, decryptBuffer, isEncrypted, keyIsDerived, encryptText, decryptText } from './secure.js';
import { TERMS_VERSION } from './legal.js';
import { getSettings, clearSettingsCache, validateSettings, postEntry, commissionFor, money } from './wallet.js';
import { chatOpen, chatAllowed, purgeOldMessages, CHAT_MAX } from './chat.js';
import { sendPush, validEndpoint, pushEnabled, publicKey as vapidPublicKey } from './push.js';
import { generateSecret, verifyTotp, otpauthUrl, generateBackupCodes, hashBackup } from './totp.js';
import { encryptLegacyDocuments } from './docs.js';

// Monitoreo de errores (opcional): con SENTRY_DSN los errores inesperados del servidor se reportan a Sentry (sin datos personales)
const Sentry = process.env.SENTRY_DSN ? await import('@sentry/node') : null;
Sentry?.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  release: process.env.RAILWAY_GIT_COMMIT_SHA,
  tracesSampleRate: 0,
  sendDefaultPii: false,
});
const reportError = (e) => { console.error(e); Sentry?.captureException(e); };

const PORT = Number(process.env.PORT || 4000);
const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
if (JWT_SECRET === 'dev-secret' || JWT_SECRET.startsWith('cambia-esto')) {
  if (process.env.NODE_ENV === 'production') throw new Error('Define un JWT_SECRET real en .env');
  console.warn('⚠ JWT_SECRET de desarrollo: cámbialo antes de publicar la app');
}
const NEARBY_KM = 5;
// Una oferta de un conductor vale este tiempo: así el pasajero no acepta una oferta vieja de alguien que ya se fue
const OFFER_TTL_SECONDS = Number(process.env.OFFER_TTL_SECONDS || 90);
const RAISE_COOLDOWN_MS = Number(process.env.RAISE_COOLDOWN_MS || 8000); // entre una subida de precio y la siguiente
const ETA_EVERY_MS = Number(process.env.ETA_EVERY_MS || 20000); // cada cuánto se recalcula el tiempo de llegada
const SHOW_PARTNER_PHONES = process.env.SHOW_PARTNER_PHONES === 'true';
const CHAT_RETENTION_DAYS = Number(process.env.CHAT_RETENTION_DAYS || 90);
const isProd = process.env.NODE_ENV === 'production';
// Sin Twilio y fuera de producción, el código se devuelve en la respuesta para poder probar sin SMS reales
// SMS_DEV_ECHO=true lo habilita también en producción mientras no haya Twilio (solo para pruebas del equipo: cualquiera vería su código)
const echoCode = !smsConfigured && (!isProd || process.env.SMS_DEV_ECHO === 'true');
if (isProd && echoCode) console.warn('⚠ SMS_DEV_ECHO activo: los códigos de verificación se muestran en pantalla. Desactívalo al configurar Twilio.');
if (isProd && !smsConfigured && !echoCode) console.warn('⚠ Twilio no está configurado: nadie podrá registrarse por SMS.');
// Baldosas del mapa: OpenStreetMap por defecto. Para producción conviene un proveedor propio o de pago (VITE_TILE_URL), porque
// los servidores públicos de OSM no están pensados para apps con muchos usuarios y bloquean a quien no cumple su política.
const TILE_URL = process.env.VITE_TILE_URL || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
function tileOrigin(url) {
  try {
    const u = new URL(url.replace('{s}', 'a').replace(/\{[^}]+\}/g, '0'));
    return url.includes('{s}') ? `https://*.${u.hostname.split('.').slice(1).join('.')}` : `https://${u.hostname}`;
  } catch {
    return 'https://*.tile.openstreetmap.org';
  }
}
const HERE = path.dirname(fileURLToPath(import.meta.url));
// En Railway el disco se borra en cada despliegue: monta un Volume y apunta UPLOADS_DIR a él (ej. /data/uploads)
const UPLOADS = process.env.UPLOADS_DIR || path.join(HERE, '..', 'uploads');
const DOC_TYPES = ['photo', 'license', 'registration'];
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
  await Promise.all(rows.filter((u) => PERMS[u.role]?.includes(perm)).map((u) => notifyUser(u.id, payload, { always: true })));
}
const push = (userId, payload, opts) => notifyUser(userId, payload, opts).catch(reportError); // sin esperar: nunca retrasa la respuesta
const pushStaff = (payload, perm) => notifyStaff(payload, perm).catch(reportError);
const hasPushSub = async (userId) => pushEnabled && (await pool.query('SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1', [userId]))[0].length > 0;

// Teléfonos del equipo que reciben un SMS cuando alguien pulsa el botón de emergencia (separados por coma)
const SOS_PHONES = (process.env.SOS_ALERT_PHONES || '').split(',').map((p) => normalizePhone(p)).filter(Boolean);
const SOS_REMINDER_MIN = Number(process.env.SOS_REMINDER_MINUTES || 3); // mientras nadie la atienda, se repite el aviso
const SOS_MAX_NOTICES = 4; // el aviso inicial y hasta 3 recordatorios
const PUBLIC_URL = process.env.PUBLIC_URL || process.env.CLIENT_ORIGIN || '';

// En desarrollo se acepta cualquier puerto de localhost (Vite cambia de puerto si el 5173 está ocupado)
const allowOrigin = (origin, cb) => cb(null, !origin || origin === ORIGIN || /^http:\/\/localhost:\d+$/.test(origin));

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY)); // detrás de nginx/Railway/etc.
app.use(helmet({
  // OpenStreetMap exige saber desde qué sitio se piden sus baldosas; con "no-referrer" (el valor por defecto de helmet) las bloquea
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', 'blob:', tileOrigin(TILE_URL)], // mapa y documentos del admin
      'connect-src': ["'self'"], // API y WebSocket del mismo servidor
    },
  },
}));
app.use(cors({ origin: allowOrigin }));
const smallJson = express.json({ limit: '10kb' });
app.use((req, res, next) => (/^\/api\/driver\/(documents|topups)/.test(req.path) ? next() : smallJson(req, res, next)));

// Una línea JSON por petición a la API (método, ruta, estado y milisegundos), útil en los registros de Railway. Sin teléfonos ni contraseñas.
if (isProd || process.env.LOG_REQUESTS === 'true') {
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') || req.path === '/api/health') return next();
    const t0 = Date.now();
    res.on('finish', () => console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: req.route?.path || req.path, s: res.statusCode, ms: Date.now() - t0 })));
    next();
  });
}

// Qué funciones del navegador puede usar la web: solo la ubicación (el mapa); cámara y micrófono nunca
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()');
  next();
});

const limitMsg = { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' };
// Solo cuentan los intentos fallidos de login (contra fuerza bruta)
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: isProd ? 10 : 500, skipSuccessfulRequests: true, message: limitMsg }); // en desarrollo es holgado: las pruebas fallan a propósito muchas veces
const mapsLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, message: limitMsg });
const trackLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, message: limitMsg });
const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: isProd ? 50 : 1000, message: limitMsg });
const otpLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: isProd ? 20 : 1000, message: limitMsg });

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: allowOrigin } });

// ---------- Estado en memoria (posiciones en vivo) ----------
const drivers = new Map(); // userId -> { id, name, vehicle, plate, lat, lng, available }
const passengers = new Map(); // userId -> { id, lat, lng }
const openRides = new Map(); // rideId -> ride listo para enviar a conductores

// El personal maneja datos de todos: su sesión dura 12 horas; pasajeros y conductores, 30 días
const sign = (u) => jwt.sign({ id: u.id, role: u.role, tv: u.token_version ?? 0 }, JWT_SECRET, { expiresIn: ['superadmin', 'admin', 'support'].includes(u.role) ? '12h' : '30d' });

// Reglas de contraseña: 8 caracteres (10 para el personal), no solo números, nada obvio y que no contenga el teléfono
const COMMON_PASSWORDS = new Set(['12345678', '123456789', '1234567890', '87654321', 'password', 'password1', 'contrasena', 'contrasena1', 'qwertyui', 'qwerty123', 'abcdefgh', 'abc12345', '11111111', '00000000', 'jalon2026', 'jalon1234', 'honduras', 'honduras1']);
function checkPassword(password, { phone = '', role = 'passenger' } = {}) {
  const min = ['superadmin', 'admin', 'support'].includes(role) ? 10 : 8;
  if (typeof password !== 'string' || password.length < min || password.length > 72) return `La contraseña debe tener entre ${min} y 72 caracteres`;
  if (/^\d+$/.test(password)) return 'La contraseña no puede ser solo números';
  if (new Set(password).size < 4) return 'La contraseña es demasiado simple';
  if (COMMON_PASSWORDS.has(password.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) return 'Esa contraseña es muy común: elige otra';
  const digits = String(phone).replace(/\D/g, '').slice(-8);
  if (digits.length === 8 && password.includes(digits)) return 'La contraseña no puede contener tu teléfono';
  return null;
}
const publicUser = (u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role, status: u.status, vehicle: u.vehicle, plate: u.plate, mustChangePassword: !!u.must_change_password,
  // El personal debe tener la verificación en dos pasos activa para usar el panel
  mustEnrollTwoFactor: isStaff(u.role) && !u.totp_enabled, twoFactorEnabled: !!u.totp_enabled });

// ---------- Auth ----------
app.post('/api/register', registerLimiter, async (req, res) => {
  try {
    const { name, phone, password, role, vehicle, plate, code, acceptTerms } = req.body || {};
    if ([name, phone, password].some((v) => typeof v !== 'string' || !v.trim()) || !['passenger', 'driver'].includes(role))
      return res.status(400).json({ error: 'Datos incompletos' });
    if ([vehicle, plate].some((v) => v != null && typeof v !== 'string'))
      return res.status(400).json({ error: 'Datos inválidos' });
    if (role === 'driver' && (!vehicle || !plate))
      return res.status(400).json({ error: 'El conductor debe indicar vehículo y placa' });
    const phoneN = normalizePhone(phone);
    if (!phoneN) return res.status(400).json({ error: 'Teléfono inválido (8 dígitos de Honduras)' });
    const weak = checkPassword(password, { phone: phoneN, role });
    if (weak) return res.status(400).json({ error: weak });
    if (name.length > 100 || (vehicle || '').length > 100 || (plate || '').length > 20)
      return res.status(400).json({ error: 'Algún dato es demasiado largo' });
    if (acceptTerms !== true) return res.status(400).json({ error: 'Debes aceptar los Términos y la Política de Privacidad' });
    // El teléfono debe verificarse con el código enviado por SMS (se consume al final de las validaciones)
    if (!(await consumeOtp(phoneN, 'register', code))) return res.status(400).json({ error: 'Código incorrecto o vencido' });

    const hash = await bcrypt.hash(password, 10);
    // Los conductores quedan pendientes hasta que un administrador los apruebe
    const status = role === 'driver' ? 'pending' : 'active';
    const [r] = await pool.query(
      'INSERT INTO users (name, phone, password_hash, role, status, vehicle, plate, terms_accepted_at, terms_version) VALUES (?,?,?,?,?,?,?,NOW(),?)',
      [name.trim(), phoneN, hash, role, status, vehicle?.trim() || null, plate?.trim() || null, TERMS_VERSION]
    );
    const user = { id: r.insertId, name: name.trim(), phone: phoneN, role, status, vehicle, plate };
    res.json({ token: sign(user), user: publicUser(user) });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese teléfono ya está registrado' });
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
    if (isStaff(u.role) && u.totp_enabled) {
      return res.json({ twoFactor: true, challenge: jwt.sign({ id: u.id, purpose: '2fa' }, JWT_SECRET, { expiresIn: '5m' }) });
    }
    res.json({ token: sign(u), user: publicUser(u) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

async function sendCode(phone, purpose) {
  const code = await createOtp(phone, purpose);
  try {
    await sendSms(toE164(phone), `Jalón: tu código es ${code}. Vence en 10 minutos. No lo compartas con nadie.`);
  } catch (e) {
    console.error('SMS:', e.message);
    throw new OtpError('No se pudo enviar el SMS. Intenta de nuevo en un momento.', 502);
  }
  return code;
}
const sendError = (res, e) => (e instanceof OtpError ? res.status(e.status).json({ error: e.message }) : Promise.reject(e));

// Paso 1 del registro: enviar el código al teléfono
app.post('/api/otp/send', otpLimiter, async (req, res) => {
  const phone = normalizePhone(req.body?.phone);
  if (!phone) return res.status(400).json({ error: 'Teléfono inválido (8 dígitos de Honduras)' });
  const [rows] = await pool.query('SELECT id FROM users WHERE phone = ?', [phone]);
  if (rows[0]) return res.status(409).json({ error: 'Ese teléfono ya está registrado' });
  try {
    const code = await sendCode(phone, 'register');
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
  const [rows] = await pool.query("SELECT id FROM users WHERE phone = ? AND role IN ('passenger','driver') AND status <> 'blocked' AND deleted_at IS NULL", [phone]);
  let code = null;
  if (rows[0]) {
    try {
      code = await sendCode(phone, 'reset');
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

// Railway usa esta ruta para saber si el servicio está sano: responde 503 si no hay base de datos
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
  res.json({ token: sign(u), user: publicUser(u) });
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

// ---------- Derechos del usuario sobre sus datos ----------
// Descargar todo lo que la plataforma guarda de la persona (JSON). Las imágenes de los documentos no se incluyen: se piden a soporte.
app.get('/api/me/export', authUser, async (req, res) => {
  const u = req.user;
  const id = u.id;
  const [rides] = await pool.query(
    `SELECT r.id, r.status, r.cancelled_by, r.origin_text, r.dest_text, r.origin_lat, r.origin_lng, r.dest_lat, r.dest_lng,
            r.distance_km, r.duration_min, r.offered_price, r.final_price, r.created_at,
            IF(r.passenger_id = ?, 'pasajero', 'conductor') AS mi_rol, o.name AS otra_persona
     FROM rides r LEFT JOIN users o ON o.id = IF(r.passenger_id = ?, r.driver_id, r.passenger_id)
     WHERE r.passenger_id = ? OR r.driver_id = ? ORDER BY r.id`, [id, id, id, id]
  );
  const [given] = await pool.query('SELECT ride_id, stars, comment, created_at FROM ratings WHERE rater_id = ? ORDER BY id', [id]);
  const [received] = await pool.query('SELECT ride_id, stars, comment, created_at FROM ratings WHERE ratee_id = ? ORDER BY id', [id]);
  const [alerts] = await pool.query('SELECT ride_id, lat, lng, status, created_at FROM alerts WHERE user_id = ? ORDER BY id', [id]);
  const [docs] = await pool.query('SELECT type, status, note, created_at FROM documents WHERE user_id = ?', [id]);
  const [msgs] = await pool.query('SELECT ride_id, text, created_at FROM messages WHERE sender_id = ? ORDER BY id', [id]);
  const [favs] = await pool.query('SELECT label, text, lat, lng FROM favorite_places WHERE user_id = ? ORDER BY id', [id]);
  const [contacts] = await pool.query('SELECT name, phone FROM trusted_contacts WHERE user_id = ? ORDER BY id', [id]);
  const [reps] = await pool.query('SELECT ride_id, type, text, status, resolution, created_at FROM reports WHERE user_id = ? ORDER BY id', [id]);
  const [moves] = await pool.query('SELECT amount, kind, ride_id, note, created_at FROM wallet_entries WHERE user_id = ? ORDER BY id', [id]);
  const [tops] = await pool.query('SELECT amount, bank, reference, status, approved_amount, review_note, created_at FROM topups WHERE driver_id = ? ORDER BY id', [id]);
  res.set('Content-Disposition', 'attachment; filename="mis-datos-jalon.json"');
  res.json({
    generadoEl: new Date().toISOString(),
    cuenta: { nombre: u.name, telefono: u.phone, rol: u.role, estado: u.status, vehiculo: u.vehicle, placa: u.plate, registradoEl: u.created_at, aceptoTerminosEl: u.terms_accepted_at, versionTerminos: u.terms_version },
    viajes: rides, calificacionesQueDi: given, calificacionesQueRecibi: received, alertasDeEmergencia: alerts,
    documentos: docs.map((d) => ({ tipo: d.type, estado: d.status, nota: d.note, subidoEl: d.created_at })),
    mensajesQueEnvie: msgs.map((m) => ({ viaje: m.ride_id, texto: m.text, enviadoEl: m.created_at })),
    saldo: Number(u.balance || 0),
    movimientosDeSaldo: moves.map((m) => ({ monto: Number(m.amount), tipo: m.kind, viaje: m.ride_id, nota: m.note, fecha: m.created_at })),
    recargas: tops.map((t) => ({ monto: Number(t.amount), banco: t.bank, referencia: t.reference, estado: t.status, montoAprobado: t.approved_amount == null ? null : Number(t.approved_amount), nota: t.review_note, fecha: t.created_at })),
    lugaresFavoritos: favs,
    contactosDeConfianza: contacts,
    reportes: reps.map((r) => ({ viaje: r.ride_id, tipo: r.type, texto: r.text, estado: r.status, respuesta: r.resolution, creadoEl: r.created_at })),
  });
});

// Eliminar la propia cuenta (pide la contraseña). No se puede con un viaje en curso. El personal no se elimina solo: lo hace el superadmin.
app.post('/api/me/delete', authUser, loginLimiter, async (req, res) => {
  const u = req.user;
  if (isStaff(u.role)) return res.status(403).json({ error: 'Las cuentas del personal las elimina el superadministrador' });
  if (typeof req.body?.password !== 'string' || !(await bcrypt.compare(req.body.password, u.password_hash)))
    return res.status(403).json({ error: 'La contraseña es incorrecta' });
  if (await activeRideFor(u)) return res.status(409).json({ error: 'Tienes un viaje en curso. Termínalo o cancélalo antes de eliminar tu cuenta.' });
  await anonymizeUser(u);
  await audit(u, 'user.self_delete', { target: u.id, details: { role: u.role } });
  res.json({ ok: true });
});

const driverOnly = (req, res, next) => (req.user.role === 'driver' ? next() : res.status(403).json({ error: 'Solo conductores' }));
const photoJson = express.json({ limit: '3mb' });

// ---------- Saldo, comisión y recargas por transferencia ----------
// Con la comisión activa, el conductor necesita saldo para ponerse disponible. El saldo se recarga transfiriendo a la cuenta de Jalón
// y subiendo el comprobante; el personal lo autoriza. De ese saldo se descuenta la comisión de cada viaje cobrado en efectivo.
async function walletGate(userId) {
  const s = await getSettings(pool);
  if (s.commission_enabled !== '1') return { blocked: false };
  const [[u]] = await pool.query('SELECT balance FROM users WHERE id = ?', [userId]);
  const balance = Number(u?.balance || 0);
  return { blocked: balance < Number(s.min_balance), balance, min: Number(s.min_balance) };
}

const tellWallet = (userId, balance, extra = {}) => io.to(room(userId)).emit('wallet:update', { balance, ...extra });

async function chargeCommission(ride) {
  const s = await getSettings(pool);
  if (s.commission_enabled !== '1' || !ride.driver_id || !(Number(ride.final_price) > 0)) return;
  const amount = commissionFor(ride.final_price, s.commission_percent);
  if (!(amount > 0)) return;
  const balance = await postEntry(pool, { userId: ride.driver_id, amount: -amount, kind: 'commission', rideId: ride.id, note: `Comisión ${Number(s.commission_percent)}% del viaje #${ride.id}` });
  if (balance === null) return; // esa comisión ya estaba cobrada
  tellWallet(ride.driver_id, balance, { change: -amount, kind: 'commission', rideId: ride.id });
  if (balance < Number(s.min_balance)) {
    // Sin saldo suficiente deja de estar disponible hasta que recargue
    drivers.delete(ride.driver_id);
    io.to(room(ride.driver_id)).emit('wallet:low', { balance, min: Number(s.min_balance) });
    push(ride.driver_id, { title: 'Recarga tu saldo para seguir recibiendo viajes', body: `Tu saldo es L ${balance.toFixed(2)}`, tag: 'wallet-low', url: '/' });
  }
}

// Crédito de bienvenida: una sola vez, al aprobar al conductor, si la comisión está activa
async function grantWelcome(userId) {
  const s = await getSettings(pool);
  const amount = money(s.welcome_credit);
  if (s.commission_enabled !== '1' || !(amount > 0)) return;
  const [[done]] = await pool.query("SELECT COUNT(*) AS n FROM wallet_entries WHERE user_id = ? AND kind = 'bonus' AND note = 'Crédito de bienvenida'", [userId]);
  if (done.n) return;
  const balance = await postEntry(pool, { userId, amount, kind: 'bonus', note: 'Crédito de bienvenida' });
  if (balance !== null) tellWallet(userId, balance, { change: amount, kind: 'bonus' });
}

// Lo que ve el conductor: su saldo, cómo transferir, sus movimientos y sus recargas
app.get('/api/driver/wallet', authUser, driverOnly, async (req, res) => {
  const s = await getSettings(pool);
  const [[u]] = await pool.query('SELECT balance FROM users WHERE id = ?', [req.user.id]);
  const [entries] = await pool.query('SELECT id, amount, kind, ride_id, note, created_at FROM wallet_entries WHERE user_id = ? ORDER BY id DESC LIMIT 50', [req.user.id]);
  const [topups] = await pool.query('SELECT id, amount, bank, reference, status, approved_amount, review_note, created_at FROM topups WHERE driver_id = ? ORDER BY id DESC LIMIT 20', [req.user.id]);
  res.json({
    enabled: s.commission_enabled === '1',
    balance: Number(u.balance), minBalance: Number(s.min_balance), percent: Number(s.commission_percent),
    topupMin: Number(s.topup_min), topupMax: Number(s.topup_max),
    bank: { name: s.bank_name, type: s.bank_account_type, account: s.bank_account, holder: s.bank_holder, note: s.bank_note },
    entries, topups,
  });
});

// El conductor avisa que transfirió: monto, banco, número de referencia y foto del comprobante
app.post('/api/driver/topups', authUser, driverOnly, photoJson, async (req, res) => {
  if (req.user.status !== 'active') return res.status(403).json({ error: 'Tu cuenta debe estar aprobada para recargar' });
  const s = await getSettings(pool);
  if (s.commission_enabled !== '1') return res.status(409).json({ error: 'Las recargas no están activas' });
  const amount = money(req.body?.amount);
  if (!(amount >= Number(s.topup_min) && amount <= Number(s.topup_max)))
    return res.status(400).json({ error: `La recarga debe ser de L ${Number(s.topup_min)} a L ${Number(s.topup_max)}` });
  const bank = clean(req.body?.bank)?.slice(0, 60);
  const reference = clean(req.body?.reference)?.slice(0, 60);
  if (!bank || !reference || reference.length < 4) return res.status(400).json({ error: 'Indica el banco y el número de referencia de la transferencia' });
  const m = String(req.body?.image || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  let cleaned;
  try {
    const buf = m ? Buffer.from(m[1], 'base64') : null;
    if (!buf || buf.length > 2 * 1024 * 1024) throw new Error('imagen');
    cleaned = sanitizeJpeg(buf).buf; // se quitan los datos ocultos de la foto, igual que en los documentos
  } catch {
    return res.status(400).json({ error: 'Sube una foto o captura del comprobante (JPG, menos de 2 MB)' });
  }
  const [[open]] = await pool.query("SELECT COALESCE(SUM(status = 'pending'), 0) AS pending, COALESCE(SUM(created_at > NOW() - INTERVAL 24 HOUR), 0) AS today FROM topups WHERE driver_id = ?", [req.user.id]);
  if (Number(open.pending) >= 3) return res.status(429).json({ error: 'Ya tienes 3 recargas esperando aprobación. Espera a que el equipo las revise.' });
  if (Number(open.today) >= 5) return res.status(429).json({ error: 'Ya enviaste varias recargas hoy. Espera a que el equipo las revise.' });
  // Contra el fraude: la misma transferencia o el mismo comprobante no se pueden usar dos veces
  const referenceKey = `${bank}:${reference}`.toUpperCase().replace(/[^A-Z0-9:]/g, '');
  const hash = crypto.createHash('sha256').update(cleaned).digest('hex');
  const [dup] = await pool.query("SELECT reference_key = ? AS sameRef FROM topups WHERE status IN ('pending','approved') AND (reference_key = ? OR receipt_hash = ?) LIMIT 1", [referenceKey, referenceKey, hash]);
  if (dup[0]) return res.status(409).json({ error: dup[0].sameRef ? 'Esa transferencia ya fue enviada' : 'Ese comprobante ya fue enviado' });

  await fs.mkdir(UPLOADS, { recursive: true });
  const file = `topup-${req.user.id}-${crypto.randomBytes(8).toString('hex')}.enc`;
  await fs.writeFile(path.join(UPLOADS, file), encryptBuffer(cleaned));
  const [r] = await pool.query('INSERT INTO topups (driver_id, amount, bank, reference, reference_key, receipt_file, receipt_hash) VALUES (?,?,?,?,?,?,?)', [req.user.id, amount, bank, reference, referenceKey, file, hash]);
  pushStaff({ title: 'Nueva recarga por aprobar', body: `${req.user.name} · L ${amount}`, tag: `topup-${r.insertId}`, url: '/' }, 'wallet');
  res.json({ ok: true, id: r.insertId });
});

// ---------- Lugares favoritos (casa, trabajo...) ----------
app.get('/api/favorites', authUser, async (req, res) => {
  const [rows] = await pool.query('SELECT id, label, text, lat, lng FROM favorite_places WHERE user_id = ? ORDER BY id', [req.user.id]);
  res.json(rows);
});

app.post('/api/favorites', authUser, async (req, res) => {
  const label = clean(req.body?.label)?.slice(0, 40);
  const text = clean(req.body?.text);
  const { lat, lng } = req.body || {};
  if (!label || !text || !isPoint({ lat, lng })) return res.status(400).json({ error: 'Falta el nombre o el lugar' });
  const [[mine]] = await pool.query('SELECT COUNT(*) AS n, SUM(label = ?) AS same FROM favorite_places WHERE user_id = ?', [label, req.user.id]);
  if (mine.n >= 10 && !Number(mine.same)) return res.status(409).json({ error: 'Puedes guardar hasta 10 lugares. Borra alguno para agregar otro.' });
  // Con el mismo nombre se actualiza (p. ej. cambiar "Casa" de lugar)
  await pool.query(
    'INSERT INTO favorite_places (user_id, label, text, lat, lng) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE text = VALUES(text), lat = VALUES(lat), lng = VALUES(lng)',
    [req.user.id, label, text, lat, lng]
  );
  res.json({ ok: true });
});

app.delete('/api/favorites/:id', authUser, async (req, res) => {
  await pool.query('DELETE FROM favorite_places WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
  res.json({ ok: true });
});

// ---------- Contactos de confianza (reciben el enlace del viaje al empezar) ----------
const passengerOnly = (req, res, next) => (req.user.role === 'passenger' ? next() : res.status(403).json({ error: 'Solo para pasajeros' }));

app.get('/api/contacts', authUser, passengerOnly, async (req, res) => {
  const [rows] = await pool.query('SELECT id, name, phone FROM trusted_contacts WHERE user_id = ? ORDER BY id', [req.user.id]);
  res.json(rows);
});

app.post('/api/contacts', authUser, passengerOnly, async (req, res) => {
  const name = clean(req.body?.name)?.slice(0, 60);
  const phone = normalizePhone(req.body?.phone);
  if (!name || !phone) return res.status(400).json({ error: 'Escribe un nombre y un teléfono válido (8 dígitos)' });
  if (phone === req.user.phone) return res.status(400).json({ error: 'Ese es tu propio teléfono' });
  const [[mine]] = await pool.query('SELECT COUNT(*) AS n FROM trusted_contacts WHERE user_id = ?', [req.user.id]);
  if (mine.n >= 3) return res.status(409).json({ error: 'Puedes tener hasta 3 contactos de confianza' });
  try {
    const [r] = await pool.query('INSERT INTO trusted_contacts (user_id, name, phone) VALUES (?,?,?)', [req.user.id, name, phone]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese contacto ya está en tu lista' });
    throw e;
  }
});

app.delete('/api/contacts/:id', authUser, passengerOnly, async (req, res) => {
  await pool.query('DELETE FROM trusted_contacts WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
  res.json({ ok: true });
});

// Al empezar el viaje, cada contacto de confianza recibe un SMS con el enlace para seguirlo en vivo
async function shareWithContacts(ride) {
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
  const text = `Jalon: ${p.name.split(' ')[0].normalize('NFD').replace(/[\u0300-\u036f]/g, '')} inicio un viaje y te eligio como contacto de confianza. Sigue su viaje en vivo: ${link}`;
  const results = await Promise.allSettled(contacts.map((c) => sendSms(toE164(c.phone), text)));
  results.forEach((r, i) => r.status === 'rejected' && console.error(`Contacto de confianza: no se pudo avisar a ${contacts[i].phone}:`, r.reason?.message));
}

// ---------- Recibo del viaje ----------
app.get('/api/rides/:id/receipt', authUser, async (req, res) => {
  const ride = await getRide(Number(req.params.id));
  if (!ride || ![ride.passenger_id, ride.driver_id].includes(req.user.id)) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (ride.status !== 'completed') return res.status(409).json({ error: 'Solo los viajes completados tienen recibo' });
  const [[p]] = await pool.query('SELECT name FROM users WHERE id = ?', [ride.passenger_id]);
  const [[d]] = await pool.query('SELECT name, vehicle, plate FROM users WHERE id = ?', [ride.driver_id]);
  res.json({
    number: `JAL-${String(ride.id).padStart(6, '0')}`,
    date: ride.created_at, endedAt: ride.updated_at,
    passenger: p.name, driver: d.name, vehicle: d.vehicle, plate: d.plate,
    origin: ride.origin_text, dest: ride.dest_text,
    distanceKm: ride.distance_km, durationMin: ride.duration_min,
    price: Number(ride.final_price), payment: 'Efectivo',
  });
});

// ---------- Reportes: un problema con un viaje, un cobro, un objeto olvidado ----------
const REPORT_TYPES = { lost_item: 'Objeto olvidado', overcharge: 'Cobro indebido', behavior: 'Trato o conducta', safety: 'Seguridad', other: 'Otro problema' };

app.post('/api/rides/:id/report', authUser, async (req, res) => {
  const ride = await getRide(Number(req.params.id));
  if (!ride || ![ride.passenger_id, ride.driver_id].includes(req.user.id) || !ride.driver_id) return res.status(404).json({ error: 'Viaje no encontrado' });
  const type = req.body?.type;
  const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 1000) : '';
  if (!REPORT_TYPES[type]) return res.status(400).json({ error: 'Elige el tipo de problema' });
  if (text.length < 5) return res.status(400).json({ error: 'Cuéntanos qué pasó (al menos unas palabras)' });
  const [[recent]] = await pool.query('SELECT COUNT(*) AS n FROM reports WHERE user_id = ? AND created_at > NOW() - INTERVAL 24 HOUR', [req.user.id]);
  if (recent.n >= 5) return res.status(429).json({ error: 'Ya enviaste varios reportes hoy. El equipo los está revisando.' });
  const [r] = await pool.query('INSERT INTO reports (ride_id, user_id, type, text) VALUES (?,?,?,?)', [ride.id, req.user.id, type, text]);
  pushStaff({ title: 'Nuevo reporte', body: `${REPORT_TYPES[type]} · viaje #${ride.id}`, tag: `report-${r.insertId}`, url: '/' }, 'alerts');
  res.json({ ok: true, id: r.insertId });
});

app.get('/api/reports/mine', authUser, async (req, res) => {
  const [rows] = await pool.query('SELECT id, ride_id, type, text, status, resolution, created_at FROM reports WHERE user_id = ? ORDER BY id DESC LIMIT 50', [req.user.id]);
  res.json(rows);
});

// ---------- Suscripción a notificaciones ----------
app.get('/api/push/key', authUser, (_req, res) => res.json({ key: vapidPublicKey })); // null = el servidor no tiene notificaciones configuradas

app.post('/api/push/subscribe', authUser, async (req, res) => {
  const { endpoint, keys } = req.body?.subscription || {};
  const ok = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{16,200}$/.test(v);
  if (!validEndpoint(endpoint, { allowLocal: !isProd }) || !ok(keys?.p256dh) || !ok(keys?.auth)) return res.status(400).json({ error: 'Suscripción inválida' });
  const hash = crypto.createHash('sha256').update(endpoint).digest('hex');
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth, user_agent) VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent)`,
    [req.user.id, endpoint, hash, keys.p256dh, keys.auth, String(req.headers['user-agent'] || '').slice(0, 200)]
  );
  // Como máximo 10 dispositivos por persona: se quitan los más antiguos
  await pool.query('DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (SELECT id FROM (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 10) t)', [req.user.id, req.user.id]);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', authUser, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'Suscripción inválida' });
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?', [crypto.createHash('sha256').update(endpoint).digest('hex'), req.user.id]);
  res.json({ ok: true });
});

// Cerrar la sesión en todos los dispositivos (por si perdiste el celular o la dejaste abierta en otro): invalida todos los tokens y devuelve uno nuevo
app.post('/api/logout-all', authUser, async (req, res) => {
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [req.user.id]);
  io.in(room(req.user.id)).disconnectSockets(true);
  const [[u]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json({ ok: true, token: sign(u) });
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// ---------- Usuario autenticado (REST) ----------
async function authUser(req, res, next) {
  try {
    const payload = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    const { id } = payload;
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
    if (!rows[0] || rows[0].status === 'blocked' || (payload.tv ?? 0) !== rows[0].token_version) return res.status(401).json({ error: 'No autorizado' });
    if (rows[0].must_change_password && req.path !== '/api/password/change')
      return res.status(403).json({ error: 'Debes cambiar tu contraseña', code: 'MUST_CHANGE_PASSWORD' });
    req.user = rows[0];
    next();
  } catch {
    res.status(401).json({ error: 'No autorizado' });
  }
}

const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
const parsePoint = (str) => {
  const [lat, lng] = String(str || '').split(',').map(Number);
  return { lat, lng };
};

// Buscar direcciones por nombre (sesgado hacia la ubicación del usuario)
app.get('/api/places', authUser, mapsLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ results: [] });
  const near = { lat: num(req.query.lat), lng: num(req.query.lng) };
  try {
    res.json({ results: await searchPlaces(q, isPoint(near) ? near : null) });
  } catch (e) {
    console.warn('places:', e.message);
    res.status(502).json({ error: 'No se pudo buscar la dirección. Toca el mapa para elegir el punto.' });
  }
});

// Nombre de la calle/colonia de un punto del mapa
app.get('/api/reverse', authUser, mapsLimiter, async (req, res) => {
  const p = { lat: num(req.query.lat), lng: num(req.query.lng) };
  if (!isPoint(p)) return res.status(400).json({ error: 'Ubicación inválida' });
  try {
    res.json({ text: await reversePlace(p.lat, p.lng) });
  } catch {
    res.json({ text: null });
  }
});

// Ruta por calles con distancia, tiempo y precio sugerido
app.get('/api/route', authUser, mapsLimiter, async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!isPoint(from) || !isPoint(to)) return res.status(400).json({ error: 'Ubicación inválida' });
  if (distanceKm(from.lat, from.lng, to.lat, to.lng) > 100) return res.status(400).json({ error: 'El destino está demasiado lejos' });
  const r = await getRoute(from, to);
  res.json({ ...r, suggestedPrice: suggestedPrice(r.distanceKm) });
});

// Historial de viajes del usuario
app.get('/api/rides/mine', authUser, async (req, res) => {
  const id = req.user.id;
  const [rows] = await pool.query(
    `SELECT r.id, r.status, r.cancelled_by, r.origin_text, r.dest_text, r.distance_km, r.offered_price, r.final_price,
            r.created_at, o.name AS other_name,
            (SELECT stars FROM ratings WHERE ride_id = r.id AND rater_id = ?) AS my_stars,
            (SELECT stars FROM ratings WHERE ride_id = r.id AND ratee_id = ?) AS their_stars
     FROM rides r LEFT JOIN users o ON o.id = IF(r.passenger_id = ?, r.driver_id, r.passenger_id)
     WHERE r.passenger_id = ? OR r.driver_id = ?
     ORDER BY r.id DESC LIMIT 50`,
    [id, id, id, id, id]
  );
  res.json({ rides: rows, rating: (await ratingsOf([id])).get(id) || { avg: null, count: 0 } });
});

// Calificar al otro participante de un viaje completado (1 a 5 estrellas)
app.post('/api/rides/:id/rate', authUser, async (req, res) => {
  const stars = Number(req.body?.stars);
  const comment = clean(req.body?.comment);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return res.status(400).json({ error: 'Elige de 1 a 5 estrellas' });
  const ride = await getRide(Number(req.params.id));
  const me = req.user.id;
  if (!ride || ![ride.passenger_id, ride.driver_id].includes(me)) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (ride.status !== 'completed') return res.status(409).json({ error: 'Solo se pueden calificar viajes completados' });
  const ratee = me === ride.passenger_id ? ride.driver_id : ride.passenger_id;
  try {
    await pool.query('INSERT INTO ratings (ride_id, rater_id, ratee_id, stars, comment) VALUES (?,?,?,?,?)', [ride.id, me, ratee, stars, comment]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya calificaste este viaje' });
    throw e;
  }
});

// Enlace para que un familiar siga el viaje en vivo (solo mientras el viaje está en curso)
app.post('/api/rides/:id/share', authUser, async (req, res) => {
  const ride = await getRide(Number(req.params.id));
  if (!ride || ![ride.passenger_id, ride.driver_id].includes(req.user.id)) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (!['accepted', 'arrived', 'started'].includes(ride.status)) return res.status(409).json({ error: 'Solo se puede compartir un viaje activo' });
  let token = ride.share_token;
  if (!token) {
    token = crypto.randomBytes(16).toString('base64url');
    await pool.query('UPDATE rides SET share_token = ? WHERE id = ?', [token, ride.id]);
  }
  res.json({ token });
});

// Público: seguimiento del viaje compartido. Solo expone lo necesario (sin teléfonos ni apellidos).
app.get('/api/track/:token', trackLimiter, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM rides WHERE share_token = ? AND (status IN ('accepted','arrived','started') OR updated_at > NOW() - INTERVAL 1 HOUR)`,
    [String(req.params.token).slice(0, 32)]
  );
  const ride = rows[0];
  if (!ride) return res.status(404).json({ error: 'Este enlace ya no está disponible' });
  const [dr] = ride.driver_id ? await pool.query('SELECT name, vehicle, plate FROM users WHERE id = ?', [ride.driver_id]) : [[]];
  const live = ride.driver_id ? drivers.get(ride.driver_id) : null;
  const active = ['accepted', 'arrived', 'started'].includes(ride.status);
  res.json({
    status: ride.status,
    driver: dr[0] ? { name: dr[0].name.split(' ')[0], vehicle: dr[0].vehicle, plate: dr[0].plate } : null,
    origin: { lat: ride.origin_lat, lng: ride.origin_lng, text: ride.origin_text },
    dest: { lat: ride.dest_lat, lng: ride.dest_lng, text: ride.dest_text },
    route: ride.route_json ? JSON.parse(ride.route_json) : null,
    driverPos: active && live?.lat != null ? { lat: live.lat, lng: live.lng } : null,
  });
});

// ---------- Documentos del conductor (foto, licencia y matrícula) ----------

app.get('/api/driver/documents', authUser, driverOnly, async (req, res) => {
  const [rows] = await pool.query('SELECT type, status, note, created_at FROM documents WHERE user_id = ?', [req.user.id]);
  res.json(rows);
});

// La app reduce la foto a JPEG antes de subirla; aquí se valida que de verdad sea un JPEG
app.put('/api/driver/documents/:type', authUser, driverOnly, photoJson, async (req, res) => {
  const type = req.params.type;
  if (!DOC_TYPES.includes(type)) return res.status(400).json({ error: 'Tipo de documento inválido' });
  const m = String(req.body?.image || '').match(/^data:image\/jpeg;base64,([A-Za-z0-9+/=]+)$/);
  const buf = m ? Buffer.from(m[1], 'base64') : null;
  if (!buf || buf.length < 100 || buf.length > 2 * 1024 * 1024 || buf[0] !== 0xff || buf[1] !== 0xd8 || buf[2] !== 0xff)
    return res.status(400).json({ error: 'Sube una foto JPG de menos de 2 MB' });

  // Nunca se confía en lo que manda la app: se valida la estructura, se quitan los metadatos (ubicación GPS, modelo del celular) y se cifra
  let cleaned;
  try {
    cleaned = sanitizeJpeg(buf).buf;
  } catch {
    return res.status(400).json({ error: 'La imagen no es un JPG válido' });
  }
  await fs.mkdir(UPLOADS, { recursive: true });
  const file = `${req.user.id}-${type}-${crypto.randomBytes(8).toString('hex')}.enc`;
  await fs.writeFile(path.join(UPLOADS, file), encryptBuffer(cleaned));
  const [[before]] = await pool.query("SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND status = 'uploaded'", [req.user.id]);
  const [old] = await pool.query('SELECT file FROM documents WHERE user_id = ? AND type = ?', [req.user.id, type]);
  await pool.query(
    `INSERT INTO documents (user_id, type, file) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE file = VALUES(file), status = 'uploaded', note = NULL, created_at = NOW()`,
    [req.user.id, type, file]
  );
  if (old[0]) await fs.rm(path.join(UPLOADS, old[0].file), { force: true });
  const [[after]] = await pool.query("SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND status = 'uploaded'", [req.user.id]);
  if (before.n < DOC_TYPES.length && after.n === DOC_TYPES.length)
    pushStaff({ title: 'Nueva solicitud de conductor', body: `${req.user.name} subió sus documentos`, tag: `docs-${req.user.id}`, url: '/' }, 'users.manage');
  res.json({ ok: true });
});

// ---------- Personal: superadmin, administrador y soporte ----------
const STAFF = ['superadmin', 'admin', 'support'];
const isStaff = (role) => STAFF.includes(role);
// Qué puede hacer cada rol: el superadmin todo; el administrador opera la plataforma; soporte mira y atiende emergencias
const PERMS = {
  superadmin: ['view', 'alerts', 'rides.cancel', 'users.manage', 'docs', 'audit', 'staff.manage', 'wallet', 'wallet.adjust', 'settings'],
  admin: ['view', 'alerts', 'rides.cancel', 'users.manage', 'docs', 'audit', 'wallet'],
  support: ['view', 'alerts', 'rides.cancel'],
};

// Middleware: exige sesión de personal activo con el permiso indicado (se consulta la base en cada petición)
function staffOnly(perm) {
  return async (req, res, next) => {
    try {
      const payload = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
      const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [payload.id]);
      const u = rows[0];
      if (!u || (payload.tv ?? 0) !== u.token_version) return res.status(401).json({ error: 'No autorizado' });
      if (!isStaff(u.role) || u.status !== 'active') return res.status(403).json({ error: 'Solo personal autorizado' });
      if (u.must_change_password) return res.status(403).json({ error: 'Debes cambiar tu contraseña', code: 'MUST_CHANGE_PASSWORD' });
      if (!u.totp_enabled) return res.status(403).json({ error: 'Activa la verificación en dos pasos para continuar', code: 'MUST_ENROLL_2FA' });
      if (!PERMS[u.role].includes(perm)) return res.status(403).json({ error: 'No tienes permiso para esto' });
      req.staff = u;
      next();
    } catch {
      res.status(401).json({ error: 'No autorizado' });
    }
  };
}

// Registro de quién hizo qué
async function audit(actor, action, { target = null, details = null } = {}) {
  await pool.query('INSERT INTO audit_log (actor_id, action, target_user_id, details) VALUES (?,?,?,?)', [
    actor.id, action, target, details ? JSON.stringify(details) : null,
  ]);
}

// Igual que audit(), pero no repite la misma anotación si ya existe una reciente (abrir un documento carga 3 imágenes)
async function auditOnce(actor, action, target, minutes = 10, details = null) {
  const [r] = await pool.query(
    'SELECT 1 FROM audit_log WHERE actor_id = ? AND action = ? AND target_user_id = ? AND created_at > NOW() - INTERVAL ? MINUTE LIMIT 1',
    [actor.id, action, target, minutes]
  );
  if (!r.length) await audit(actor, action, { target, details });
}

// Contraseña temporal legible (sin letras que se confunden: 0/O, 1/l/I)
function tempPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
}

// Carga al usuario sobre el que se actúa y comprueba que quien actúa pueda tocarlo
async function actOn(req, res, { allowDeleted = false } = {}) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [Number(req.params.id)]);
  const t = rows[0];
  if (!t || (t.deleted_at && !allowDeleted)) return void res.status(404).json({ error: 'Usuario no existe' });
  let problem = null;
  if (t.id === req.staff.id) problem = 'No puedes hacer esto con tu propia cuenta (usa Cuenta para cambiar tu contraseña)';
  else if (t.role === 'superadmin') problem = 'No se puede modificar a un superadministrador';
  else if (isStaff(t.role) && !PERMS[req.staff.role].includes('staff.manage')) problem = 'Solo el superadministrador gestiona al personal';
  if (problem) return void res.status(403).json({ error: problem });
  return t;
}

app.get('/api/admin/stats', staffOnly('view'), async (_req, res) => {
  const [[u]] = await pool.query(
    `SELECT SUM(role='passenger') AS passengers, SUM(role='driver') AS drivers,
            SUM(role='driver' AND status='pending') AS pending, SUM(status='blocked' AND deleted_at IS NULL) AS blocked FROM users`
  );
  const [[r]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(status='completed') AS completed, SUM(status='cancelled') AS cancelled,
            SUM(status IN ('requested','accepted','arrived','started')) AS active,
            COALESCE(SUM(IF(status='completed', final_price, 0)),0) AS revenue
     FROM rides`
  );
  res.json({
    passengers: Number(u.passengers || 0),
    drivers: Number(u.drivers || 0),
    pendingDrivers: Number(u.pending || 0),
    blockedUsers: Number(u.blocked || 0),
    openAlerts: (await pool.query("SELECT COUNT(*) AS n FROM alerts WHERE status = 'open'"))[0][0].n,
    openReports: (await pool.query("SELECT COUNT(*) AS n FROM reports WHERE status = 'open'"))[0][0].n,
    pendingTopups: (await pool.query("SELECT COUNT(*) AS n FROM topups WHERE status = 'pending'"))[0][0].n,
    sosPhones: SOS_PHONES.length, // cuántos teléfonos reciben las emergencias por SMS (0 = nadie)
    driversOnline: [...drivers.values()].length,
    driversFree: [...drivers.values()].filter((d) => d.available && !d.disconnected).length,
    rides: { total: r.total, completed: Number(r.completed || 0), cancelled: Number(r.cancelled || 0), active: Number(r.active || 0) },
    revenue: Number(r.revenue),
  });
});

app.get('/api/admin/users', staffOnly('view'), async (req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, phone, role, status, vehicle, plate, created_at, must_change_password, deleted_at, balance,
            (SELECT COUNT(*) FROM documents d WHERE d.user_id = users.id AND d.status = 'uploaded') AS docs
     FROM users ORDER BY id DESC LIMIT 500`
  );
  const ratings = await ratingsOf(rows.map((u) => u.id));
  // Cada quien recibe también lo que puede hacer, para que la pantalla muestre solo lo permitido
  res.json({ perms: PERMS[req.staff.role], me: { id: req.staff.id, role: req.staff.role }, users: rows.map(({ balance, ...u }) => ({ ...u, ...(PERMS[req.staff.role].includes('wallet') && u.role === 'driver' ? { balance: Number(balance) } : {}), online: drivers.has(u.id), rating: ratings.get(u.id) || null })) });
});

app.get('/api/admin/rides', staffOnly('view'), async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT r.id, r.status, r.cancelled_by, r.distance_km, r.offered_price, r.final_price, r.created_at,
            p.name AS passenger, d.name AS driver
     FROM rides r JOIN users p ON p.id = r.passenger_id LEFT JOIN users d ON d.id = r.driver_id
     ORDER BY r.id DESC LIMIT 200`
  );
  res.json(rows);
});

// Ficha completa de un usuario: datos, estadísticas, últimos viajes, documentos y movimientos del personal sobre su cuenta
app.get('/api/admin/users/:id', staffOnly('view'), async (req, res) => {
  const id = Number(req.params.id);
  const [[u]] = await pool.query(
    `SELECT id, name, phone, role, status, vehicle, plate, created_at, terms_accepted_at, terms_version, must_change_password, deleted_at, totp_enabled
     FROM users WHERE id = ?`, [id]
  );
  if (!u) return res.status(404).json({ error: 'Usuario no existe' });
  const [[stats]] = await pool.query(
    `SELECT COALESCE(SUM(passenger_id = ?),0) AS asPassenger, COALESCE(SUM(driver_id = ?),0) AS asDriver,
            COALESCE(SUM(status = 'completed'),0) AS completed, COALESCE(SUM(status = 'cancelled'),0) AS cancelled,
            COALESCE(SUM(IF(status = 'completed', final_price, 0)),0) AS money
     FROM rides WHERE passenger_id = ? OR driver_id = ?`, [id, id, id, id]
  );
  const [rides] = await pool.query(
    `SELECT r.id, r.status, r.cancelled_by, r.dest_text, r.distance_km, r.final_price, r.offered_price, r.created_at, o.name AS other_name
     FROM rides r LEFT JOIN users o ON o.id = IF(r.passenger_id = ?, r.driver_id, r.passenger_id)
     WHERE r.passenger_id = ? OR r.driver_id = ? ORDER BY r.id DESC LIMIT 10`, [id, id, id]
  );
  const can = PERMS[req.staff.role];
  const docs = can.includes('docs') ? (await pool.query('SELECT id, type, status, note, created_at FROM documents WHERE user_id = ?', [id]))[0] : null;
  const history = can.includes('audit')
    ? (await pool.query(
        `SELECT a.id, a.action, a.details, a.created_at, s.name AS actor FROM audit_log a JOIN users s ON s.id = a.actor_id
         WHERE a.target_user_id = ? ORDER BY a.id DESC LIMIT 15`, [id]
      ))[0].map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }))
    : null;
  let wallet = null;
  if (can.includes('wallet') && u.role === 'driver') {
    const [[b]] = await pool.query('SELECT balance FROM users WHERE id = ?', [id]);
    const [entries] = await pool.query('SELECT id, amount, kind, ride_id, note, created_at FROM wallet_entries WHERE user_id = ? ORDER BY id DESC LIMIT 15', [id]);
    wallet = { balance: Number(b.balance), entries };
  }
  res.json({
    user: { ...u, online: drivers.has(id) },
    wallet,
    stats: { ...stats, money: Number(stats.money) },
    rating: (await ratingsOf([id])).get(id) || null,
    rides, docs, history,
  });
});

// Corregir los datos de un usuario (nombre, teléfono, vehículo y placa)
app.patch('/api/admin/users/:id', staffOnly('users.manage'), async (req, res) => {
  const t = await actOn(req, res);
  if (!t) return;
  const { name, phone, vehicle, plate } = req.body || {};
  const fields = {};
  if (name !== undefined) {
    if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'Nombre inválido' });
    fields.name = name.trim();
  }
  if (phone !== undefined) {
    const p = normalizePhone(phone);
    if (!p) return res.status(400).json({ error: 'Teléfono inválido (8 dígitos de Honduras)' });
    fields.phone = p;
  }
  if (t.role === 'driver') {
    if (vehicle !== undefined) {
      if (typeof vehicle !== 'string' || !vehicle.trim() || vehicle.length > 100) return res.status(400).json({ error: 'Vehículo inválido' });
      fields.vehicle = vehicle.trim();
    }
    if (plate !== undefined) {
      if (typeof plate !== 'string' || !plate.trim() || plate.length > 20) return res.status(400).json({ error: 'Placa inválida' });
      fields.plate = plate.trim();
    }
  }
  const keys = Object.keys(fields).filter((k) => fields[k] !== t[k]);
  if (!keys.length) return res.status(400).json({ error: 'No hay cambios que guardar' });
  try {
    await pool.query(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => fields[k]), t.id]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese teléfono ya pertenece a otra cuenta' });
    throw e;
  }
  await audit(req.staff, 'user.edit', { target: t.id, details: { changed: keys } });
  res.json({ ok: true });
});

// Restablecer la contraseña: se genera una temporal que se muestra una sola vez y el usuario debe cambiarla al entrar
app.post('/api/admin/users/:id/reset-password', staffOnly('users.manage'), async (req, res) => {
  const t = await actOn(req, res);
  if (!t) return;
  const temp = tempPassword();
  await pool.query('UPDATE users SET password_hash = ?, must_change_password = 1, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(temp, 10), t.id]);
  io.in(room(t.id)).disconnectSockets(true);
  await audit(req.staff, 'user.reset_password', { target: t.id });
  res.json({ tempPassword: temp });
});

// Eliminar una cuenta = anonimizarla: se borran sus datos personales y documentos; los viajes quedan sin direcciones para estadísticas y reclamos
async function anonymizeUser(t) {
  await kickUser(t.id); // cancela sus viajes y cierra sus conexiones
  const [docs] = await pool.query('SELECT file FROM documents WHERE user_id = ?', [t.id]);
  for (const d of docs) await fs.rm(path.join(UPLOADS, d.file), { force: true });
  await pool.query('DELETE FROM documents WHERE user_id = ?', [t.id]);
  await pool.query('DELETE FROM otp_codes WHERE phone = ?', [t.phone]);
  await pool.query('UPDATE ratings SET comment = NULL WHERE rater_id = ?', [t.id]);
  await pool.query("UPDATE messages SET text = '[mensaje eliminado]' WHERE sender_id = ?", [t.id]);
  await pool.query('DELETE FROM favorite_places WHERE user_id = ?', [t.id]);
  await pool.query('DELETE FROM trusted_contacts WHERE user_id = ?', [t.id]);
  // Los comprobantes de transferencia se borran; los montos del libro de cuentas se conservan (son registros contables)
  const [receipts] = await pool.query('SELECT receipt_file FROM topups WHERE driver_id = ? AND receipt_file IS NOT NULL', [t.id]);
  for (const r of receipts) await fs.rm(path.join(UPLOADS, r.receipt_file), { force: true });
  await pool.query("UPDATE topups SET receipt_file = NULL, receipt_hash = NULL, reference = '[eliminado]', reference_key = NULL WHERE driver_id = ?", [t.id]);
  await pool.query("UPDATE reports SET text = '[reporte eliminado]' WHERE user_id = ?", [t.id]);
  await pool.query('UPDATE rides SET origin_text = NULL, dest_text = NULL, share_token = NULL WHERE passenger_id = ? OR driver_id = ?', [t.id, t.id]);
  await pool.query(
    `UPDATE users SET name = 'Cuenta eliminada', phone = ?, password_hash = ?, vehicle = NULL, plate = NULL, status = 'blocked',
            must_change_password = 0, totp_enabled = 0, totp_secret = NULL, backup_codes = NULL, totp_last_step = NULL,
            deleted_at = NOW(), token_version = token_version + 1 WHERE id = ?`,
    [`del-${t.id}`, await bcrypt.hash(tempPassword() + tempPassword(), 10), t.id]
  );
}

app.post('/api/admin/users/:id/delete', staffOnly('staff.manage'), async (req, res) => {
  const t = await actOn(req, res);
  if (!t) return;
  await anonymizeUser(t);
  await audit(req.staff, 'user.delete', { target: t.id, details: { role: t.role } });
  res.json({ ok: true });
});

// Aprobar / desbloquear (active) o bloquear (blocked) a un usuario
app.post('/api/admin/users/:id/status', staffOnly('users.manage'), async (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'blocked'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
  const t = await actOn(req, res);
  if (!t) return;
  if (status === 'active' && t.role === 'driver') {
    const [[c]] = await pool.query("SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND status = 'uploaded'", [t.id]);
    if (c.n < DOC_TYPES.length)
      return res.status(409).json({ error: 'El conductor debe subir los 3 documentos (foto, licencia y matrícula) antes de aprobarlo' });
  }
  await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, t.id]);
  io.to(room(t.id)).emit('account:status', { status });
  if (status === 'blocked') await kickUser(t.id);
  await audit(req.staff, status === 'blocked' ? 'user.block' : t.status === 'pending' ? 'user.approve' : 'user.unblock', { target: t.id });
  if (status === 'active' && t.role === 'driver' && t.status === 'pending') grantWelcome(t.id).catch(reportError);
  res.json({ ok: true });
});

// --- Gestión del personal (solo superadmin) ---
app.post('/api/admin/users/:id/reset-2fa', staffOnly('staff.manage'), async (req, res) => {
  const t = await actOn(req, res);
  if (!t) return;
  if (!isStaff(t.role)) return res.status(400).json({ error: 'Esa cuenta no es del personal' });
  await pool.query(
    `UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, backup_codes = NULL, two_fa_failures = 0,
            two_fa_locked_until = NULL, token_version = token_version + 1 WHERE id = ?`, [t.id]
  );
  await audit(req.staff, '2fa.reset', { target: t.id });
  res.json({ ok: true });
});

app.post('/api/admin/staff', staffOnly('staff.manage'), async (req, res) => {
  const { name, phone, role } = req.body || {};
  const p = normalizePhone(phone);
  if (typeof name !== 'string' || !name.trim() || name.length > 100) return res.status(400).json({ error: 'Nombre inválido' });
  if (!p) return res.status(400).json({ error: 'Teléfono inválido (8 dígitos de Honduras)' });
  if (!['admin', 'support'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });
  const temp = tempPassword();
  try {
    const [r] = await pool.query(
      "INSERT INTO users (name, phone, password_hash, role, status, must_change_password) VALUES (?,?,?,?, 'active', 1)",
      [name.trim(), p, await bcrypt.hash(temp, 10), role]
    );
    await audit(req.staff, 'staff.create', { target: r.insertId, details: { role } });
    res.json({ id: r.insertId, tempPassword: temp });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese teléfono ya está registrado' });
    throw e;
  }
});

app.post('/api/admin/staff/:id/role', staffOnly('staff.manage'), async (req, res) => {
  const { role } = req.body || {};
  if (!['admin', 'support'].includes(role)) return res.status(400).json({ error: 'Rol inválido' });
  const t = await actOn(req, res);
  if (!t) return;
  if (!isStaff(t.role)) return res.status(400).json({ error: 'Esa cuenta no es del personal' });
  if (t.role === role) return res.status(400).json({ error: 'Ya tiene ese rol' });
  await pool.query('UPDATE users SET role = ? WHERE id = ?', [role, t.id]);
  await audit(req.staff, 'staff.role', { target: t.id, details: { from: t.role, to: role } });
  res.json({ ok: true });
});

app.get('/api/admin/audit', staffOnly('audit'), async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, a.action, a.details, a.created_at, a.target_user_id, s.name AS actor, s.role AS actor_role, t.name AS target_name
     FROM audit_log a JOIN users s ON s.id = a.actor_id LEFT JOIN users t ON t.id = a.target_user_id
     ORDER BY a.id DESC LIMIT 200`
  );
  res.json(rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null })));
});

// Documentos de un conductor y descarga de cada imagen
app.get('/api/admin/users/:id/documents', staffOnly('docs'), async (req, res) => {
  const [rows] = await pool.query('SELECT id, type, status, note, created_at FROM documents WHERE user_id = ?', [Number(req.params.id)]);
  res.json(rows);
});

app.get('/api/admin/documents/:id/file', staffOnly('docs'), async (req, res) => {
  const [rows] = await pool.query('SELECT user_id, file FROM documents WHERE id = ?', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'No existe' });
  let blob;
  try {
    blob = await fs.readFile(path.join(UPLOADS, rows[0].file));
  } catch {
    return res.status(404).json({ error: 'El archivo no está disponible' });
  }
  await auditOnce(req.staff, 'doc.view', rows[0].user_id); // queda anotado quién abrió los documentos de quién
  res.set('Cache-Control', 'private, no-store');
  res.type('image/jpeg').send(isEncrypted(blob) ? decryptBuffer(blob) : blob);
});

app.post('/api/admin/documents/:id/reject', staffOnly('docs'), async (req, res) => {
  const [rows] = await pool.query('SELECT user_id, type FROM documents WHERE id = ?', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'No existe' });
  const note = clean(req.body?.note);
  await pool.query("UPDATE documents SET status = 'rejected', note = ? WHERE id = ?", [note, Number(req.params.id)]);
  io.to(room(rows[0].user_id)).emit('docs:changed');
  await audit(req.staff, 'doc.reject', { target: rows[0].user_id, details: { type: rows[0].type, note } });
  res.json({ ok: true });
});

// Chat de un viaje con una emergencia, para entender qué pasó. Solo viajes con alerta; cada consulta queda anotada.
app.get('/api/admin/rides/:id/chat', staffOnly('alerts'), async (req, res) => {
  const id = Number(req.params.id);
  const [[ride]] = await pool.query('SELECT id, passenger_id, driver_id FROM rides WHERE id = ?', [id]);
  if (!ride) return res.status(404).json({ error: 'Viaje no encontrado' });
  const [[has]] = await pool.query('SELECT (SELECT COUNT(*) FROM alerts WHERE ride_id = ?) + (SELECT COUNT(*) FROM reports WHERE ride_id = ?) AS n', [id, id]);
  if (!has.n) return res.status(403).json({ error: 'El chat solo se puede ver en viajes con una emergencia o un reporte' });
  await auditOnce(req.staff, 'chat.view', ride.passenger_id, 10, { ride: id });
  const [rows] = await pool.query('SELECT m.id, m.sender_id AS senderId, u.name AS sender, m.text, m.created_at AS at FROM messages m JOIN users u ON u.id = m.sender_id WHERE m.ride_id = ? ORDER BY m.id', [id]);
  res.json({ passengerId: ride.passenger_id, driverId: ride.driver_id, messages: rows });
});

// --- Recargas de saldo: el personal revisa el comprobante y autoriza ---
app.get('/api/admin/topups', staffOnly('wallet'), async (req, res) => {
  const status = ['approved', 'rejected'].includes(req.query.status) ? req.query.status : 'pending';
  const [rows] = await pool.query(
    `SELECT t.id, t.amount, t.bank, t.reference, t.status, t.approved_amount, t.review_note, t.created_at, t.reviewed_at,
            u.id AS driver_id, u.name AS driver, u.phone AS driver_phone, u.balance AS driver_balance, r.name AS reviewer
     FROM topups t JOIN users u ON u.id = t.driver_id LEFT JOIN users r ON r.id = t.reviewed_by
     WHERE t.status = ? ORDER BY t.id DESC LIMIT 200`, [status]
  );
  res.json(rows.map((t) => ({ ...t, amount: Number(t.amount), approved_amount: t.approved_amount == null ? null : Number(t.approved_amount), driver_balance: Number(t.driver_balance) })));
});

app.get('/api/admin/topups/:id/receipt', staffOnly('wallet'), async (req, res) => {
  const [rows] = await pool.query('SELECT driver_id, receipt_file FROM topups WHERE id = ?', [Number(req.params.id)]);
  if (!rows[0]?.receipt_file) return res.status(404).json({ error: 'No hay comprobante' });
  let blob;
  try {
    blob = await fs.readFile(path.join(UPLOADS, rows[0].receipt_file));
  } catch {
    return res.status(404).json({ error: 'El archivo no está disponible' });
  }
  await auditOnce(req.staff, 'topup.view', rows[0].driver_id, 10, { topup: Number(req.params.id) });
  res.set('Cache-Control', 'private, no-store');
  res.type('image/jpeg').send(decryptBuffer(blob));
});

app.post('/api/admin/topups/:id/approve', staffOnly('wallet'), async (req, res) => {
  const id = Number(req.params.id);
  const [[t]] = await pool.query('SELECT * FROM topups WHERE id = ?', [id]);
  if (!t) return res.status(404).json({ error: 'Recarga no encontrada' });
  // El monto acreditado es el que muestra el comprobante (puede ser distinto al que escribió el conductor)
  const amount = req.body?.amount === undefined ? Number(t.amount) : money(req.body.amount);
  if (!(amount > 0 && amount <= 50000)) return res.status(400).json({ error: 'Monto inválido' });
  // Se "reclama" la solicitud de forma atómica: aunque dos personas pulsen Aprobar a la vez, solo una acredita
  const [claim] = await pool.query("UPDATE topups SET status = 'approved', approved_amount = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ? AND status = 'pending'", [amount, req.staff.id, id]);
  if (claim.affectedRows !== 1) return res.status(409).json({ error: 'Esa recarga ya fue revisada' });
  let balance;
  try {
    balance = await postEntry(pool, { userId: t.driver_id, amount, kind: 'topup', topupId: id, note: `Recarga por transferencia (${t.bank} ${t.reference})`, by: req.staff.id });
  } catch (e) {
    await pool.query("UPDATE topups SET status = 'pending', approved_amount = NULL, reviewed_by = NULL, reviewed_at = NULL WHERE id = ?", [id]); // no quedó acreditada: vuelve a la cola
    throw e;
  }
  await audit(req.staff, 'topup.approve', { target: t.driver_id, details: { topup: id, amount } });
  tellWallet(t.driver_id, balance, { change: amount, kind: 'topup' });
  push(t.driver_id, { title: 'Recarga aprobada', body: `Se acreditaron L ${amount.toFixed(2)}. Tu saldo es L ${balance.toFixed(2)}`, tag: `topup-${id}`, url: '/' }, { always: true });
  res.json({ ok: true, balance });
});

app.post('/api/admin/topups/:id/reject', staffOnly('wallet'), async (req, res) => {
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 300) : '';
  if (note.length < 3) return res.status(400).json({ error: 'Escribe el motivo (el conductor lo verá)' });
  const id = Number(req.params.id);
  const [[t]] = await pool.query('SELECT driver_id FROM topups WHERE id = ?', [id]);
  if (!t) return res.status(404).json({ error: 'Recarga no encontrada' });
  const [r] = await pool.query("UPDATE topups SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = NOW() WHERE id = ? AND status = 'pending'", [note, req.staff.id, id]);
  if (r.affectedRows !== 1) return res.status(409).json({ error: 'Esa recarga ya fue revisada' });
  await audit(req.staff, 'topup.reject', { target: t.driver_id, details: { topup: id, note } });
  push(t.driver_id, { title: 'Recarga rechazada', body: note, tag: `topup-${id}`, url: '/' }, { always: true });
  res.json({ ok: true });
});

// Corrección manual del saldo (solo superadmin, con motivo): queda en el libro y en el registro
app.post('/api/admin/wallet/:userId/adjust', staffOnly('wallet.adjust'), async (req, res) => {
  const amount = money(req.body?.amount);
  const note = typeof req.body?.note === 'string' ? req.body.note.trim().slice(0, 200) : '';
  if (!amount || Math.abs(amount) > 50000) return res.status(400).json({ error: 'Monto inválido' });
  if (note.length < 5) return res.status(400).json({ error: 'Explica el motivo del ajuste' });
  const [[d]] = await pool.query("SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL", [Number(req.params.userId)]);
  if (!d || d.role !== 'driver') return res.status(404).json({ error: 'Conductor no encontrado' });
  const balance = await postEntry(pool, { userId: d.id, amount, kind: 'adjustment', note: `Ajuste: ${note}`, by: req.staff.id });
  await audit(req.staff, 'wallet.adjust', { target: d.id, details: { amount, note } });
  tellWallet(d.id, balance, { change: amount, kind: 'adjustment' });
  res.json({ ok: true, balance });
});

app.get('/api/admin/settings', staffOnly('wallet'), async (_req, res) => res.json(await getSettings(pool)));

app.put('/api/admin/settings', staffOnly('settings'), async (req, res) => {
  const current = await getSettings(pool);
  const { values, error } = validateSettings(req.body || {}, current);
  if (error) return res.status(400).json({ error });
  const changed = Object.keys(values).filter((k) => values[k] !== current[k]);
  for (const k of changed) await pool.query('INSERT INTO settings (name, value, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)', [k, values[k], req.staff.id]);
  clearSettingsCache();
  if (changed.length) await audit(req.staff, 'settings.update', { details: { changed } });
  res.json(await getSettings(pool));
});

// Reportes de los usuarios, con los datos de las dos personas del viaje para poder contactarlas
app.get('/api/admin/reports', staffOnly('alerts'), async (req, res) => {
  const status = req.query.status === 'resolved' ? 'resolved' : 'open';
  const [rows] = await pool.query(
    `SELECT rp.id, rp.ride_id, rp.type, rp.text, rp.status, rp.resolution, rp.created_at, rp.resolved_at,
            u.id AS reporter_id, u.name AS reporter, u.phone AS reporter_phone, u.role AS reporter_role,
            o.id AS other_id, o.name AS other, o.phone AS other_phone, o.role AS other_role
     FROM reports rp JOIN rides r ON r.id = rp.ride_id JOIN users u ON u.id = rp.user_id
     LEFT JOIN users o ON o.id = IF(rp.user_id = r.passenger_id, r.driver_id, r.passenger_id)
     WHERE rp.status = ? ORDER BY rp.id DESC LIMIT 200`, [status]
  );
  res.json(rows.map((r) => ({ ...r, type_label: REPORT_TYPES[r.type] })));
});

app.post('/api/admin/reports/:id/resolve', staffOnly('alerts'), async (req, res) => {
  const resolution = typeof req.body?.resolution === 'string' ? req.body.resolution.trim().slice(0, 500) : '';
  if (resolution.length < 3) return res.status(400).json({ error: 'Escribe cómo se resolvió (la persona lo verá)' });
  const [[rep]] = await pool.query('SELECT id, user_id, status FROM reports WHERE id = ?', [Number(req.params.id)]);
  if (!rep) return res.status(404).json({ error: 'Reporte no encontrado' });
  if (rep.status === 'resolved') return res.status(409).json({ error: 'Ese reporte ya estaba resuelto' });
  await pool.query("UPDATE reports SET status = 'resolved', resolution = ?, resolved_by = ?, resolved_at = NOW() WHERE id = ?", [resolution, req.staff.id, rep.id]);
  await audit(req.staff, 'report.resolve', { target: rep.user_id, details: { report: rep.id } });
  push(rep.user_id, { title: 'Tu reporte fue atendido', body: resolution.length > 100 ? `${resolution.slice(0, 97)}…` : resolution, tag: `report-${rep.id}`, url: '/' }, { always: true });
  res.json({ ok: true });
});

// Alertas de emergencia (botón SOS) con los datos de quienes viajan
app.get('/api/admin/alerts', staffOnly('alerts'), async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT a.id, a.lat, a.lng, a.created_at, a.ride_id, r.status AS ride_status,
            u.name AS user_name, u.phone AS user_phone, u.role AS user_role,
            p.name AS passenger, p.phone AS passenger_phone,
            d.name AS driver, d.phone AS driver_phone, d.vehicle, d.plate
     FROM alerts a JOIN rides r ON r.id = a.ride_id JOIN users u ON u.id = a.user_id
     JOIN users p ON p.id = r.passenger_id LEFT JOIN users d ON d.id = r.driver_id
     WHERE a.status = 'open' ORDER BY a.id DESC`
  );
  res.json(rows);
});

app.post('/api/admin/alerts/:id/resolve', staffOnly('alerts'), async (req, res) => {
  await pool.query("UPDATE alerts SET status = 'resolved', resolved_at = NOW() WHERE id = ?", [Number(req.params.id)]);
  await audit(req.staff, 'alert.resolve', { details: { alert: Number(req.params.id) } });
  res.json({ ok: true });
});

app.post('/api/admin/rides/:id/cancel', staffOnly('rides.cancel'), async (req, res) => {
  const view = await cancelRide(Number(req.params.id), 'admin');
  if (!view) return res.status(409).json({ error: 'El viaje ya no está activo' });
  await audit(req.staff, 'ride.cancel', { details: { ride: Number(req.params.id) } });
  res.json({ ok: true });
});

// ---------- Helpers ----------
const room = (id) => `user:${id}`;

const MAX_PRICE = 5000; // L
const REQUEST_TTL_MIN = 10; // un viaje sin conductor se cancela solo
const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const isPoint = (p) => p && isNum(p.lat) && isNum(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
const isPrice = (n) => isNum(n) && n >= 1 && n <= MAX_PRICE;
// Ejecuta tareas con la misma clave una tras otra (evita carreras por doble clic)
const locks = new Map();
function serial(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, run);
  run.finally(() => locks.get(key) === run && locks.delete(key)).catch(() => {});
  return run;
}
const clean = (t) => (typeof t === 'string' ? t.trim().slice(0, 200) : null) || null;

async function getRide(id) {
  const [rows] = await pool.query('SELECT * FROM rides WHERE id = ?', [id]);
  return rows[0];
}

async function activeRideFor(user) {
  const col = user.role === 'driver' ? 'driver_id' : 'passenger_id';
  const [rows] = await pool.query(
    `SELECT * FROM rides WHERE ${col} = ? AND status IN ('requested','accepted','arrived','started') ORDER BY id DESC LIMIT 1`,
    [user.id]
  );
  return rows[0];
}

// Promedio y cantidad de calificaciones recibidas: Map(userId -> { avg, count })
async function ratingsOf(ids) {
  const map = new Map();
  if (!ids.length) return map;
  const [rows] = await pool.query('SELECT ratee_id, AVG(stars) AS avg, COUNT(*) AS n FROM ratings WHERE ratee_id IN (?) GROUP BY ratee_id', [ids]);
  for (const r of rows) map.set(r.ratee_id, { avg: Math.round(Number(r.avg) * 10) / 10, count: r.n });
  return map;
}

async function rideView(ride) {
  const ids = [ride.passenger_id, ride.driver_id].filter(Boolean);
  // El teléfono de la otra persona NO se entrega (se coordina por el chat). SHOW_PARTNER_PHONES=true lo vuelve a mostrar.
  const [users] = await pool.query(`SELECT id,name,vehicle,plate${SHOW_PARTNER_PHONES ? ',phone' : ''} FROM users WHERE id IN (?)`, [ids]);
  const ratings = await ratingsOf(ids);
  const byId = Object.fromEntries(users.map((u) => [u.id, { ...u, rating: ratings.get(u.id) || { avg: null, count: 0 } }]));
  const { route_json, share_token, ...rest } = ride;
  return {
    ...rest,
    route: route_json ? JSON.parse(route_json) : null,
    passenger: byId[ride.passenger_id] || null,
    driver: ride.driver_id ? byId[ride.driver_id] : null,
  };
}

// Solo se mandan los más cercanos: con cientos de conductores, enviar la lista completa a cada pasajero cada 3 s satura el servidor
// y en un teléfono no se distinguen más. El cliente muestra "25+" cuando llega al tope.
const MAX_NEARBY = 25;
function nearbyDrivers(lat, lng) {
  const near = [];
  for (const d of drivers.values()) {
    if (!d.available || d.disconnected || d.lat == null) continue; // los que solo se alcanzan por notificación no se muestran en el mapa
    const km = distanceKm(lat, lng, d.lat, d.lng);
    if (km <= NEARBY_KM) near.push({ km, d });
  }
  return near
    .sort((a, b) => a.km - b.km)
    .slice(0, MAX_NEARBY)
    .map(({ d }) => ({ id: d.id, name: d.name, vehicle: d.vehicle, lat: d.lat, lng: d.lng }));
}

function openRidesNear(lat, lng) {
  return [...openRides.values()].filter((r) => distanceKm(lat, lng, r.origin_lat, r.origin_lng) <= NEARBY_KM);
}

function closeOpenRide(rideId) {
  openRides.delete(rideId);
  io.to('drivers').emit('ride:closed', { rideId });
}

// El conductor termina un viaje: vuelve a estar libre, o se quita del mapa si ya se desconectó
function releaseDriver(driverId) {
  const d = drivers.get(driverId);
  if (!d) return;
  if (d.disconnected) drivers.delete(driverId);
  else d.available = true;
}

// Tiempo estimado de llegada: del conductor al pasajero (viaje aceptado) o al destino (viaje en curso).
// Se recalcula como máximo cada ETA_EVERY_MS por viaje para no saturar el servicio de rutas.
const etaAt = new Map(); // "viaje:fase" -> última vez
async function sendEta(ride, from) {
  const phase = ride.status === 'accepted' ? 'pickup' : ride.status === 'started' ? 'dropoff' : null;
  if (!phase) return;
  const key = `${ride.id}:${phase}`;
  if (Date.now() - (etaAt.get(key) || 0) < ETA_EVERY_MS) return;
  etaAt.set(key, Date.now());
  if (etaAt.size > 500) etaAt.delete(etaAt.keys().next().value);
  const to = phase === 'pickup' ? { lat: ride.origin_lat, lng: ride.origin_lng } : { lat: ride.dest_lat, lng: ride.dest_lng };
  const route = await getRoute(from, to);
  const eta = { rideId: ride.id, phase, minutes: Math.max(1, Math.ceil(route.durationMin)), km: Math.round(route.distanceKm * 10) / 10, estimated: route.estimated };
  io.to(room(ride.passenger_id)).emit('ride:eta', eta);
  io.to(room(ride.driver_id)).emit('ride:eta', { ...eta, coords: route.coords }); // el conductor además recibe el camino para verlo en el mapa
}

// Las ofertas que vencen se avisan a las dos partes (y quedan como "vencidas")
async function expireOffers() {
  const [rows] = await pool.query(
    `SELECT o.id, o.ride_id, o.driver_id, r.passenger_id FROM offers o JOIN rides r ON r.id = o.ride_id
     WHERE o.status = 'pending' AND o.expires_at < NOW()`
  );
  for (const o of rows) {
    await pool.query("UPDATE offers SET status = 'expired' WHERE id = ? AND status = 'pending'", [o.id]);
    io.to(room(o.passenger_id)).to(room(o.driver_id)).emit('offer:expired', { offerId: o.id, rideId: o.ride_id });
  }
}
setInterval(() => expireOffers().catch(reportError), Number(process.env.OFFER_SWEEP_MS || 5000)).unref();

// Cancela un viaje activo (by: passenger | driver | admin | system) y avisa a las dos partes
async function cancelRide(rideId, by) {
  const ride = await getRide(rideId);
  if (!ride || !['requested', 'accepted', 'arrived', 'started'].includes(ride.status)) return null;
  await pool.query('UPDATE rides SET status = "cancelled", cancelled_by = ? WHERE id = ?', [by, rideId]);
  closeOpenRide(rideId);
  if (ride.driver_id) releaseDriver(ride.driver_id);
  const view = await rideView(await getRide(rideId));
  io.to(room(ride.passenger_id)).to(room(ride.driver_id || 0)).emit('ride:state', view);
  const cancelled = { title: 'Viaje cancelado', body: by === 'system' ? 'Nadie tomó tu solicitud a tiempo.' : 'El viaje fue cancelado.', tag: `ride-${rideId}`, url: '/' };
  if (by !== 'passenger') push(ride.passenger_id, cancelled);
  if (by !== 'driver' && ride.driver_id) push(ride.driver_id, cancelled);
  return view;
}

// Saca a un usuario bloqueado: cancela sus viajes, lo quita del mapa y cierra sus conexiones
async function kickUser(userId) {
  const [rows] = await pool.query(
    "SELECT id FROM rides WHERE (passenger_id = ? OR driver_id = ?) AND status IN ('requested','accepted','arrived','started')",
    [userId, userId]
  );
  for (const r of rows) await cancelRide(r.id, 'admin');
  drivers.delete(userId);
  passengers.delete(userId);
  io.in(room(userId)).disconnectSockets(true);
}

// ---------- Sockets ----------
io.use(async (socket, next) => {
  try {
    const payload = jwt.verify(socket.handshake.auth?.token, JWT_SECRET);
    const { id } = payload;
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
    if (!rows[0]) return next(new Error('Usuario no existe'));
    if (rows[0].status === 'blocked') return next(new Error('Cuenta bloqueada'));
    if (rows[0].must_change_password) return next(new Error('Debes cambiar tu contraseña'));
    if ((payload.tv ?? 0) !== rows[0].token_version) return next(new Error('No autorizado'));
    socket.user = rows[0];
    next();
  } catch {
    next(new Error('No autorizado'));
  }
});

io.on('connection', async (socket) => {
  const user = socket.user;
  // Un error dentro de un manejador no debe tumbar el servidor
  const on = (ev, fn) => socket.on(ev, (...args) => Promise.resolve(fn(...args)).catch((e) => reportError(Object.assign(e, { event: ev }))));
  socket.join(room(user.id));
  if (user.role === 'driver') socket.join('drivers');
  socket.emit('account:status', { status: user.status });
  console.log(`+ ${user.role} ${user.name}`);

  // ----- Conductor -----
  if (user.role === 'driver') {
    on('driver:online', async (pos) => {
      if (!isPoint(pos)) return;
      const [[u]] = await pool.query('SELECT status FROM users WHERE id = ?', [user.id]);
      if (u?.status !== 'active') return socket.emit('driver:denied', { status: u?.status });
      const { lat, lng } = pos;
      const busy = await activeRideFor(user); // si se reconecta en pleno viaje, sigue ocupado
      if (!busy) {
        const gate = await walletGate(user.id);
        if (gate.blocked) return socket.emit('driver:denied', { status: 'balance', balance: gate.balance, min: gate.min });
      }
      drivers.set(user.id, {
        id: user.id, name: user.name, vehicle: user.vehicle, plate: user.plate,
        lat, lng, available: !busy,
      });
      socket.emit('rides:open', openRidesNear(lat, lng));
    });

    on('driver:offline', () => drivers.delete(user.id));

    on('driver:location', async (pos) => {
      if (!isPoint(pos)) return;
      const { lat, lng } = pos;
      const d = drivers.get(user.id);
      if (d) { d.lat = lat; d.lng = lng; }
      const ride = await activeRideFor(user);
      if (!ride) return;
      io.to(room(ride.passenger_id)).emit('ride:driver_location', { lat, lng });
      sendEta(ride, { lat, lng }).catch(reportError); // sin esperar: el aviso de ubicación no depende de la ruta
    });

    on('offer:make', async ({ rideId, price }) => {
      const d = drivers.get(user.id);
      const ride = openRides.get(rideId);
      price = Number(price);
      if (!d || !d.available || !ride || !isPrice(price)) return;
      await serial(`offer:${user.id}:${rideId}`, async () => {
      // Si el conductor ya ofertó en este viaje, se actualiza su oferta en lugar de duplicarla
      const [prev] = await pool.query('SELECT id FROM offers WHERE ride_id = ? AND driver_id = ? AND status = "pending"', [rideId, user.id]);
      let offerId;
      if (prev[0]) {
        offerId = prev[0].id;
        await pool.query('UPDATE offers SET price = ?, expires_at = NOW() + INTERVAL ? SECOND WHERE id = ?', [price, OFFER_TTL_SECONDS, offerId]);
      } else {
        const [r] = await pool.query('INSERT INTO offers (ride_id, driver_id, price, expires_at) VALUES (?,?,?, NOW() + INTERVAL ? SECOND)', [rideId, user.id, price, OFFER_TTL_SECONDS]);
        offerId = r.insertId;
      }
      io.to(room(ride.passenger_id)).emit('offer:new', {
        id: offerId, rideId, price, ttl: OFFER_TTL_SECONDS, // segundos que vale la oferta
        driver: { id: user.id, name: user.name, vehicle: user.vehicle, plate: user.plate, rating: (await ratingsOf([user.id])).get(user.id) || { avg: null, count: 0 } },
        distanceToPickupKm: d.lat != null ? distanceKm(d.lat, d.lng, ride.origin_lat, ride.origin_lng) : null,
      });
      socket.emit('offer:sent', { rideId, price, ttl: OFFER_TTL_SECONDS });
      push(ride.passenger_id, { title: 'Nueva oferta para tu viaje', body: `${user.name} ofrece L ${Math.round(price)}`, tag: `offer-${rideId}`, url: '/' });
      });
    });

    // El conductor puede cancelar antes de iniciar el viaje
    on('ride:driver_cancel', async ({ rideId }) => {
      const ride = await getRide(rideId);
      if (!ride || ride.driver_id !== user.id || !['accepted', 'arrived'].includes(ride.status)) return;
      await cancelRide(rideId, 'driver');
    });

    on('ride:status', async ({ rideId, status }) => {
      const order = { arrived: 'accepted', started: 'arrived', completed: 'started' };
      const ride = await getRide(rideId);
      if (!ride || ride.driver_id !== user.id || order[status] !== ride.status) return;
      await pool.query('UPDATE rides SET status = ? WHERE id = ?', [status, rideId]);
      if (status === 'completed') {
        releaseDriver(user.id);
        chargeCommission(ride).catch(reportError); // se descuenta del saldo del conductor; sin await para no retrasar la respuesta
      }
      const view = await rideView(await getRide(rideId));
      io.to(room(ride.passenger_id)).to(room(user.id)).emit('ride:state', view);
      if (status === 'started') shareWithContacts(ride).catch(reportError);
      if (status === 'arrived') push(ride.passenger_id, { title: 'Tu conductor llegó', body: `${user.name} te espera · ${user.vehicle || ''} ${user.plate || ''}`.trim(), tag: `ride-${rideId}`, url: '/' });
    });
  }

  // ----- Pasajero -----
  if (user.role === 'passenger') {
    on('passenger:location', (pos) => {
      if (!isPoint(pos)) return;
      const { lat, lng } = pos;
      passengers.set(user.id, { id: user.id, lat, lng, socketId: socket.id });
      socket.emit('drivers:nearby', nearbyDrivers(lat, lng));
    });

    on('ride:request', async ({ origin, dest, price }, ack) => {
      try {
        if (!isPoint(origin) || !isPoint(dest)) return ack?.({ error: 'Ubicación inválida' });
        if (await activeRideFor(user)) return ack?.({ error: 'Ya tienes un viaje activo' });
        const straight = distanceKm(origin.lat, origin.lng, dest.lat, dest.lng);
        if (straight < 0.1) return ack?.({ error: 'El destino está demasiado cerca' });
        if (straight > 100) return ack?.({ error: 'El destino está demasiado lejos' });
        // La distancia y la ruta las calcula el servidor, no la app (no se pueden falsear)
        const route = await getRoute(origin, dest);
        const km = route.distanceKm;
        const offered = price == null || price === '' ? suggestedPrice(km) : Number(price);
        if (!isPrice(offered)) return ack?.({ error: `El precio debe estar entre L 1 y L ${MAX_PRICE}` });
        const [r] = await pool.query(
          `INSERT INTO rides (passenger_id, origin_lat, origin_lng, origin_text, dest_lat, dest_lng, dest_text, distance_km, duration_min, route_json, offered_price)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
          [user.id, origin.lat, origin.lng, clean(origin.text), dest.lat, dest.lng, clean(dest.text), km, route.durationMin, JSON.stringify(route.coords), offered]
        );
        const ride = await rideView(await getRide(r.insertId));
        openRides.set(ride.id, ride);
        // Avisar a conductores libres cercanos
        for (const d of drivers.values()) {
          if (!d.available || distanceKm(d.lat, d.lng, origin.lat, origin.lng) > NEARBY_KM) continue;
          if (!d.disconnected) io.to(room(d.id)).emit('ride:new', ride);
          else push(d.id, { title: 'Nuevo viaje cerca de ti', body: `${ride.dest_text ? `A ${ride.dest_text}` : 'Viaje disponible'} · L ${Math.round(ride.offered_price)}`, tag: `ride-${ride.id}`, url: '/' });
        }
        socket.emit('ride:state', ride);
        ack?.({ ok: true });
      } catch (e) {
        console.error(e);
        ack?.({ error: 'No se pudo crear el viaje' });
      }
    });

    on('offer:accept', async ({ offerId }) => {
      const [rows] = await pool.query('SELECT *, (expires_at IS NOT NULL AND expires_at < NOW()) AS expired FROM offers WHERE id = ? AND status = "pending"', [offerId]);
      const offer = rows[0];
      if (!offer) return socket.emit('offer:invalid', { offerId }); // ya venció, la retiraron o no existe: la pantalla debe quitarla
      if (offer.expired) return socket.emit('offer:invalid', { offerId: offer.id }); // venció antes de que la aceptaran
      const ride = await getRide(offer.ride_id);
      const d = drivers.get(offer.driver_id);
      if (!ride || ride.passenger_id !== user.id || ride.status !== 'requested') return;
      if (!d?.available || d.disconnected) {
        await pool.query('UPDATE offers SET status = "rejected" WHERE id = ?', [offer.id]);
        return socket.emit('offer:invalid', { offerId: offer.id });
      }

      await pool.query('UPDATE rides SET driver_id = ?, final_price = ?, status = "accepted" WHERE id = ?', [offer.driver_id, offer.price, ride.id]);
      await pool.query('UPDATE offers SET status = IF(id = ?, "accepted", "rejected") WHERE ride_id = ?', [offer.id, ride.id]);
      d.available = false;
      closeOpenRide(ride.id);

      const view = await rideView(await getRide(ride.id));
      io.to(room(user.id)).to(room(offer.driver_id)).emit('ride:state', view);
      push(offer.driver_id, { title: '¡Te aceptaron el viaje!', body: `${user.name} · L ${Math.round(offer.price)}`, tag: `ride-${ride.id}`, url: '/' });
    });

    // Mientras nadie acepta, el pasajero puede subir su oferta: los conductores cercanos ven el precio nuevo
    const lastRaise = new Map();
    on('ride:raise', async (data, ack) => {
      const price = Number(data?.price);
      const ride = await getRide(Number(data?.rideId));
      if (!ride || ride.passenger_id !== user.id || ride.status !== 'requested') return ack?.({ error: 'Ese viaje ya no está buscando conductor' });
      if (!isPrice(price)) return ack?.({ error: `El precio debe estar entre L 1 y L ${MAX_PRICE}` });
      if (price <= Number(ride.offered_price)) return ack?.({ error: 'El precio nuevo debe ser mayor al actual' });
      if (Date.now() - (lastRaise.get(ride.id) || 0) < RAISE_COOLDOWN_MS) return ack?.({ error: 'Espera unos segundos antes de volver a subir el precio' });
      lastRaise.set(ride.id, Date.now());
      await pool.query('UPDATE rides SET offered_price = ? WHERE id = ? AND status = "requested"', [price, ride.id]);
      const view = await rideView(await getRide(ride.id));
      openRides.set(ride.id, view);
      for (const d of drivers.values()) {
        if (!d.available || distanceKm(d.lat, d.lng, ride.origin_lat, ride.origin_lng) > NEARBY_KM) continue;
        if (!d.disconnected) io.to(room(d.id)).emit('ride:new', view); // el cliente reemplaza la solicitud por la del precio nuevo
        else push(d.id, { title: 'El pasajero subió su oferta', body: `${ride.dest_text ? `A ${ride.dest_text}` : 'Viaje cercano'} · L ${Math.round(price)}`, tag: `ride-${ride.id}`, url: '/' });
      }
      socket.emit('ride:state', view);
      ack?.({ ok: true, price });
    });

    on('ride:cancel', async ({ rideId }) => {
      const ride = await getRide(rideId);
      if (!ride || ride.passenger_id !== user.id || !['requested', 'accepted', 'arrived'].includes(ride.status)) return;
      await cancelRide(rideId, 'passenger');
    });
  }

  // ----- Chat del viaje -----
  const rideForChat = async (rideId) => {
    const [rows] = await pool.query('SELECT *, (updated_at > NOW() - INTERVAL 30 MINUTE) AS recent FROM rides WHERE id = ?', [Number(rideId)]);
    const ride = rows[0];
    return ride && [ride.passenger_id, ride.driver_id].includes(user.id) ? ride : null; // solo quienes participan
  };

  on('chat:send', async (data, ack) => {
    const ride = await rideForChat(data?.rideId);
    if (!ride) return ack?.({ error: 'Viaje no encontrado' });
    if (!chatOpen(ride)) return ack?.({ error: 'El chat de este viaje ya está cerrado' });
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text) return ack?.({ error: 'Escribe un mensaje' });
    if (text.length > CHAT_MAX) return ack?.({ error: `Máximo ${CHAT_MAX} caracteres` });
    if (!chatAllowed(user.id)) return ack?.({ error: 'Estás enviando demasiados mensajes. Espera un momento.' });
    const [r] = await pool.query('INSERT INTO messages (ride_id, sender_id, text) VALUES (?,?,?)', [ride.id, user.id, text]);
    const message = { id: r.insertId, rideId: ride.id, senderId: user.id, text, at: new Date().toISOString() };
    const other = user.id === ride.passenger_id ? ride.driver_id : ride.passenger_id;
    io.to(room(user.id)).to(room(other)).emit('chat:message', message);
    push(other, { title: user.name, body: text.length > 100 ? `${text.slice(0, 97)}…` : text, tag: `chat-${ride.id}`, url: '/' });
    ack?.({ ok: true, message });
  });

  // Mensajes anteriores del viaje (al abrir el chat o reconectarse) y cuántos no ha leído esta persona
  on('chat:history', async (data, ack) => {
    const ride = await rideForChat(data?.rideId);
    if (!ride) return ack?.({ error: 'Viaje no encontrado' });
    const [rows] = await pool.query(
      'SELECT id, sender_id AS senderId, text, created_at AS at, (read_at IS NOT NULL) AS isRead FROM messages WHERE ride_id = ? ORDER BY id DESC LIMIT 200', [ride.id]
    );
    const messages = rows.reverse().map((m) => ({ id: m.id, rideId: ride.id, senderId: m.senderId, text: m.text, at: m.at, read: !!m.isRead }));
    ack?.({ ok: true, messages, unread: messages.filter((m) => m.senderId !== user.id && !m.read).length, open: chatOpen(ride) });
  });

  on('chat:read', async (data) => {
    const ride = await rideForChat(data?.rideId);
    if (!ride) return;
    await pool.query('UPDATE messages SET read_at = NOW() WHERE ride_id = ? AND sender_id <> ? AND read_at IS NULL', [ride.id, user.id]);
    const other = user.id === ride.passenger_id ? ride.driver_id : ride.passenger_id;
    if (other) io.to(room(other)).emit('chat:read', { rideId: ride.id, by: user.id });
  });

  // Botón de emergencia: registra la alerta para el administrador junto con la ubicación
  on('ride:sos', async (pos, ack) => {
    const ride = await activeRideFor(user);
    if (!ride || ride.status === 'requested') return ack?.({ error: 'Solo disponible durante un viaje' });
    const live = user.role === 'driver' ? drivers.get(user.id) : passengers.get(user.id);
    const at = isPoint(pos) ? pos : live?.lat != null ? live : null;
    const [r] = await pool.query('INSERT INTO alerts (ride_id, user_id, lat, lng) VALUES (?,?,?,?)', [ride.id, user.id, at?.lat ?? null, at?.lng ?? null]);
    console.warn(`🆘 SOS de ${user.name} (viaje ${ride.id})`);
    ack?.({ ok: true });
    notifySos(r.insertId, false).catch((e) => console.error('SOS:', e)); // el SMS no debe retrasar la respuesta al usuario
    pushStaff({ title: '🆘 EMERGENCIA', body: `${user.name} pidió ayuda (viaje ${ride.id})`, tag: `sos-${r.insertId}`, url: '/', requireInteraction: true }, 'alerts');
  });

  socket.on('disconnect', async () => {
    // Si el usuario sigue conectado desde otra pestaña, no se toca nada
    if ((await io.in(room(user.id)).fetchSockets()).length) return;
    if (user.role === 'driver') {
      const d = drivers.get(user.id);
      if (d?.available) {
        // Con notificaciones activadas se le sigue avisando de viajes cercanos aunque cierre la app (hasta 30 min sin volver)
        if (await hasPushSub(user.id)) { d.disconnected = true; d.lastSeen = Date.now(); } else drivers.delete(user.id);
      } else if (d) d.disconnected = true; // con viaje activo: se quita del mapa cuando termine
    }
    if (user.role === 'passenger') passengers.delete(user.id);
  });

  // Restaurar el viaje activo si la persona recarga la página o se reconecta.
  // Va AL FINAL a propósito: todos los eventos ya están registrados antes de cualquier consulta a la base de datos. Si fuera al inicio,
  // un mensaje que el celular manda justo al reconectarse (p. ej. "estoy disponible") llegaría antes de que el servidor lo escuche y se perdería.
  const active = await activeRideFor(user);
  if (active) socket.emit('ride:state', await rideView(active));
});

// Los mensajes del chat no se guardan para siempre (CHAT_RETENTION_DAYS, 90 por defecto)
const purgeChat = () => purgeOldMessages(pool, CHAT_RETENTION_DAYS).then((n) => n && console.log(`Se borraron ${n} mensajes antiguos del chat`)).catch(reportError);
purgeChat();
setInterval(purgeChat, 6 * 3600 * 1000).unref();

// Un conductor que cerró la app solo se conserva 30 minutos (después su ubicación ya no es confiable)
setInterval(() => {
  for (const [id, d] of drivers) if (d.disconnected && d.available && Date.now() - (d.lastSeen || 0) > 30 * 60 * 1000) drivers.delete(id);
}, 60000).unref();

// Cada 3 s se envían a cada pasajero los conductores libres cercanos
setInterval(() => {
  for (const p of passengers.values()) {
    io.to(room(p.id)).emit('drivers:nearby', nearbyDrivers(p.lat, p.lng));
  }
}, 3000);

// SMS al equipo con lo esencial (sin tildes ni emojis para que cada SMS sea de un solo tramo y no cueste de más)
async function notifySos(alertId, reminder) {
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
async function remindOpenAlerts() {
  const [rows] = await pool.query(
    `SELECT id FROM alerts WHERE status = 'open' AND notified_count BETWEEN 1 AND ? AND last_notified_at < NOW() - INTERVAL ? MINUTE`,
    [SOS_MAX_NOTICES - 1, SOS_REMINDER_MIN]
  );
  for (const a of rows) await notifySos(a.id, true);
}
setInterval(() => remindOpenAlerts().catch(console.error), 30000);

if (isProd && !SOS_PHONES.length) console.warn('⚠ SOS_ALERT_PHONES no está definido: las emergencias solo se ven en el panel');

// Viajes sin conductor tras REQUEST_TTL_MIN minutos se cancelan solos
async function expireStaleRides() {
  const [stale] = await pool.query(
    `SELECT id, passenger_id FROM rides WHERE status = 'requested' AND created_at < NOW() - INTERVAL ? MINUTE`,
    [REQUEST_TTL_MIN]
  );
  for (const r of stale) await cancelRide(r.id, 'system');
}
setInterval(() => expireStaleRides().catch(console.error), 30000);

// Al reiniciar, las solicitudes abiertas se pierden de memoria: se cancelan para no dejar viajes huérfanos
await pool.query("UPDATE rides SET status = 'cancelled', cancelled_by = 'system' WHERE status = 'requested'");

// En producción el mismo servidor entrega la web ya compilada (client/dist), incluida /t/<código> del seguimiento
const DIST = path.join(HERE, '..', '..', 'client', 'dist');
if (existsSync(DIST)) {
  app.use('/assets', express.static(path.join(DIST, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(DIST, {
    index: false,
    maxAge: '1h',
    setHeaders: (res, file) => {
      if (/(sw\.js|manifest\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

// Los documentos que se guardaron antes del cifrado se cifran una sola vez al arrancar
const legacyDocs = await encryptLegacyDocuments(UPLOADS);
if (legacyDocs) console.log(`Se cifraron ${legacyDocs} documento(s) guardados antes del cifrado.`);
if (isProd && keyIsDerived) console.warn('⚠ DATA_KEY no está definida: la llave de cifrado se deriva de JWT_SECRET. Define DATA_KEY (ver README) para poder rotar JWT_SECRET sin perder los documentos.');

// Errores no controlados: siempre JSON, sin filtrar detalles internos
app.use((err, _req, res, _next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) reportError(err);
  res.status(status).json({ error: status === 500 ? 'Error del servidor' : 'Solicitud inválida' });
});

// Errores que se escapan de todo: se reportan y, si el estado puede estar dañado, el proceso se reinicia (Railway lo levanta de nuevo)
process.on('unhandledRejection', (e) => reportError(e));
process.on('uncaughtException', async (e) => {
  reportError(e);
  await Sentry?.close(2000);
  process.exit(1);
});

// Railway envía SIGTERM al desplegar una versión nueva: se cierran las conexiones con orden
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} recibido: cerrando…`);
    io.close(() => pool.end().finally(async () => { await Sentry?.close(2000); process.exit(0); }));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

server.listen(PORT, () => console.log(`Jalón API en http://localhost:${PORT}`));
