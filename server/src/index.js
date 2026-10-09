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

const PORT = Number(process.env.PORT || 4000);
const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
if (JWT_SECRET === 'dev-secret' || JWT_SECRET.startsWith('cambia-esto')) {
  if (process.env.NODE_ENV === 'production') throw new Error('Define un JWT_SECRET real en .env');
  console.warn('⚠ JWT_SECRET de desarrollo: cámbialo antes de publicar la app');
}
const NEARBY_KM = 5;
const isProd = process.env.NODE_ENV === 'production';
// Sin Twilio y fuera de producción, el código se devuelve en la respuesta para poder probar sin SMS reales
// SMS_DEV_ECHO=true lo habilita también en producción mientras no haya Twilio (solo para pruebas del equipo: cualquiera vería su código)
const echoCode = !smsConfigured && (!isProd || process.env.SMS_DEV_ECHO === 'true');
if (isProd && echoCode) console.warn('⚠ SMS_DEV_ECHO activo: los códigos de verificación se muestran en pantalla. Desactívalo al configurar Twilio.');
if (isProd && !smsConfigured && !echoCode) console.warn('⚠ Twilio no está configurado: nadie podrá registrarse por SMS.');
const HERE = path.dirname(fileURLToPath(import.meta.url));
// En Railway el disco se borra en cada despliegue: monta un Volume y apunta UPLOADS_DIR a él (ej. /data/uploads)
const UPLOADS = process.env.UPLOADS_DIR || path.join(HERE, '..', 'uploads');
const DOC_TYPES = ['photo', 'license', 'registration'];

// En desarrollo se acepta cualquier puerto de localhost (Vite cambia de puerto si el 5173 está ocupado)
const allowOrigin = (origin, cb) => cb(null, !origin || origin === ORIGIN || /^http:\/\/localhost:\d+$/.test(origin));

const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY)); // detrás de nginx/Railway/etc.
app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', 'blob:', 'https://*.tile.openstreetmap.org'], // mapa y documentos del admin
      'connect-src': ["'self'"], // API y WebSocket del mismo servidor
    },
  },
}));
app.use(cors({ origin: allowOrigin }));
const smallJson = express.json({ limit: '10kb' });
app.use((req, res, next) => (req.path.startsWith('/api/driver/documents') ? next() : smallJson(req, res, next)));

const limitMsg = { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' };
// Solo cuentan los intentos fallidos de login (contra fuerza bruta)
const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, skipSuccessfulRequests: true, message: limitMsg });
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

const sign = (u) => jwt.sign({ id: u.id, role: u.role, tv: u.token_version ?? 0 }, JWT_SECRET, { expiresIn: '30d' });
const publicUser = (u) => ({ id: u.id, name: u.name, phone: u.phone, role: u.role, status: u.status, vehicle: u.vehicle, plate: u.plate });

// ---------- Auth ----------
app.post('/api/register', registerLimiter, async (req, res) => {
  try {
    const { name, phone, password, role, vehicle, plate, code } = req.body || {};
    if ([name, phone, password].some((v) => typeof v !== 'string' || !v.trim()) || !['passenger', 'driver'].includes(role))
      return res.status(400).json({ error: 'Datos incompletos' });
    if ([vehicle, plate].some((v) => v != null && typeof v !== 'string'))
      return res.status(400).json({ error: 'Datos inválidos' });
    if (role === 'driver' && (!vehicle || !plate))
      return res.status(400).json({ error: 'El conductor debe indicar vehículo y placa' });
    if (password.length < 6 || password.length > 72) return res.status(400).json({ error: 'La contraseña debe tener entre 6 y 72 caracteres' });
    const phoneN = normalizePhone(phone);
    if (!phoneN) return res.status(400).json({ error: 'Teléfono inválido (8 dígitos de Honduras)' });
    if (name.length > 100 || (vehicle || '').length > 100 || (plate || '').length > 20)
      return res.status(400).json({ error: 'Algún dato es demasiado largo' });
    // El teléfono debe verificarse con el código enviado por SMS (se consume al final de las validaciones)
    if (!(await consumeOtp(phoneN, 'register', code))) return res.status(400).json({ error: 'Código incorrecto o vencido' });

    const hash = await bcrypt.hash(password, 10);
    // Los conductores quedan pendientes hasta que un administrador los apruebe
    const status = role === 'driver' ? 'pending' : 'active';
    const [r] = await pool.query(
      'INSERT INTO users (name, phone, password_hash, role, status, vehicle, plate) VALUES (?,?,?,?,?,?,?)',
      [name.trim(), phoneN, hash, role, status, vehicle?.trim() || null, plate?.trim() || null]
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
  const [rows] = await pool.query("SELECT id FROM users WHERE phone = ? AND role <> 'admin' AND status <> 'blocked'", [phone]);
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
  if (!phone || typeof password !== 'string' || password.length < 6 || password.length > 72)
    return res.status(400).json({ error: 'La contraseña debe tener entre 6 y 72 caracteres' });
  const [rows] = await pool.query("SELECT id FROM users WHERE phone = ? AND role <> 'admin' AND status <> 'blocked'", [phone]);
  if (!rows[0] || !(await consumeOtp(phone, 'reset', code))) return res.status(400).json({ error: 'Código incorrecto o vencido' });
  // token_version + 1 cierra todas las sesiones abiertas con la contraseña anterior
  await pool.query('UPDATE users SET password_hash = ?, token_version = token_version + 1 WHERE id = ?', [await bcrypt.hash(password, 10), rows[0].id]);
  res.json({ ok: true });
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---------- Usuario autenticado (REST) ----------
async function authUser(req, res, next) {
  try {
    const payload = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    const { id } = payload;
    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [id]);
    if (!rows[0] || rows[0].status === 'blocked' || (payload.tv ?? 0) !== rows[0].token_version) return res.status(401).json({ error: 'No autorizado' });
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
const driverOnly = (req, res, next) => (req.user.role === 'driver' ? next() : res.status(403).json({ error: 'Solo conductores' }));
const photoJson = express.json({ limit: '3mb' });

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

  await fs.mkdir(UPLOADS, { recursive: true });
  const file = `${req.user.id}-${type}-${crypto.randomBytes(8).toString('hex')}.jpg`;
  await fs.writeFile(path.join(UPLOADS, file), buf);
  const [old] = await pool.query('SELECT file FROM documents WHERE user_id = ? AND type = ?', [req.user.id, type]);
  await pool.query(
    `INSERT INTO documents (user_id, type, file) VALUES (?,?,?)
     ON DUPLICATE KEY UPDATE file = VALUES(file), status = 'uploaded', note = NULL, created_at = NOW()`,
    [req.user.id, type, file]
  );
  if (old[0]) await fs.rm(path.join(UPLOADS, old[0].file), { force: true });
  res.json({ ok: true });
});

// ---------- Admin ----------
async function adminOnly(req, res, next) {
  try {
    const payload = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
    const { id } = payload;
    // Se consulta la base: un admin degradado o bloqueado pierde acceso aunque su token siga vigente
    const [rows] = await pool.query('SELECT role, status, token_version FROM users WHERE id = ?', [id]);
    if (rows[0] && (payload.tv ?? 0) !== rows[0].token_version) return res.status(401).json({ error: 'No autorizado' });
    if (rows[0]?.role !== 'admin' || rows[0].status !== 'active') return res.status(403).json({ error: 'Solo administradores' });
    next();
  } catch {
    res.status(401).json({ error: 'No autorizado' });
  }
}

app.get('/api/admin/stats', adminOnly, async (_req, res) => {
  const [[u]] = await pool.query(
    `SELECT SUM(role='passenger') AS passengers, SUM(role='driver') AS drivers,
            SUM(role='driver' AND status='pending') AS pending, SUM(status='blocked') AS blocked FROM users`
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
    driversOnline: [...drivers.values()].length,
    driversFree: [...drivers.values()].filter((d) => d.available).length,
    rides: { total: r.total, completed: Number(r.completed || 0), cancelled: Number(r.cancelled || 0), active: Number(r.active || 0) },
    revenue: Number(r.revenue),
  });
});

app.get('/api/admin/users', adminOnly, async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT id, name, phone, role, status, vehicle, plate, created_at,
            (SELECT COUNT(*) FROM documents d WHERE d.user_id = users.id AND d.status = 'uploaded') AS docs
     FROM users ORDER BY id DESC LIMIT 500`
  );
  const ratings = await ratingsOf(rows.map((u) => u.id));
  res.json(rows.map((u) => ({ ...u, online: drivers.has(u.id), rating: ratings.get(u.id) || null })));
});

app.get('/api/admin/rides', adminOnly, async (_req, res) => {
  const [rows] = await pool.query(
    `SELECT r.id, r.status, r.cancelled_by, r.distance_km, r.offered_price, r.final_price, r.created_at,
            p.name AS passenger, d.name AS driver
     FROM rides r JOIN users p ON p.id = r.passenger_id LEFT JOIN users d ON d.id = r.driver_id
     ORDER BY r.id DESC LIMIT 200`
  );
  res.json(rows);
});

// Documentos de un conductor y descarga de cada imagen (solo administradores)
app.get('/api/admin/users/:id/documents', adminOnly, async (req, res) => {
  const [rows] = await pool.query('SELECT id, type, status, note, created_at FROM documents WHERE user_id = ?', [Number(req.params.id)]);
  res.json(rows);
});

app.get('/api/admin/documents/:id/file', adminOnly, async (req, res) => {
  const [rows] = await pool.query('SELECT file FROM documents WHERE id = ?', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'No existe' });
  res.set('Cache-Control', 'private, no-store');
  res.type('image/jpeg').sendFile(path.join(UPLOADS, rows[0].file));
});

app.post('/api/admin/documents/:id/reject', adminOnly, async (req, res) => {
  const [rows] = await pool.query('SELECT user_id FROM documents WHERE id = ?', [Number(req.params.id)]);
  if (!rows[0]) return res.status(404).json({ error: 'No existe' });
  await pool.query("UPDATE documents SET status = 'rejected', note = ? WHERE id = ?", [clean(req.body?.note), Number(req.params.id)]);
  io.to(room(rows[0].user_id)).emit('docs:changed');
  res.json({ ok: true });
});

// Alertas de emergencia (botón SOS) con los datos de quienes viajan
app.get('/api/admin/alerts', adminOnly, async (_req, res) => {
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

app.post('/api/admin/alerts/:id/resolve', adminOnly, async (req, res) => {
  await pool.query("UPDATE alerts SET status = 'resolved', resolved_at = NOW() WHERE id = ?", [Number(req.params.id)]);
  res.json({ ok: true });
});

// Aprobar / desbloquear (active) o bloquear (blocked) a un usuario
app.post('/api/admin/users/:id/status', adminOnly, async (req, res) => {
  const id = Number(req.params.id);
  const { status } = req.body || {};
  if (!['active', 'blocked'].includes(status)) return res.status(400).json({ error: 'Estado inválido' });
  const [rows] = await pool.query('SELECT id, role FROM users WHERE id = ?', [id]);
  if (!rows[0]) return res.status(404).json({ error: 'Usuario no existe' });
  if (rows[0].role === 'admin') return res.status(400).json({ error: 'No se puede modificar a un administrador' });
  if (status === 'active' && rows[0].role === 'driver') {
    const [[c]] = await pool.query("SELECT COUNT(*) AS n FROM documents WHERE user_id = ? AND status = 'uploaded'", [id]);
    if (c.n < DOC_TYPES.length)
      return res.status(409).json({ error: 'El conductor debe subir los 3 documentos (foto, licencia y matrícula) antes de aprobarlo' });
  }
  await pool.query('UPDATE users SET status = ? WHERE id = ?', [status, id]);
  io.to(room(id)).emit('account:status', { status });
  if (status === 'blocked') await kickUser(id);
  res.json({ ok: true });
});

app.post('/api/admin/rides/:id/cancel', adminOnly, async (req, res) => {
  const view = await cancelRide(Number(req.params.id), 'admin');
  if (!view) return res.status(409).json({ error: 'El viaje ya no está activo' });
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
  const [users] = await pool.query('SELECT id,name,phone,vehicle,plate FROM users WHERE id IN (?)', [ids]);
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

function nearbyDrivers(lat, lng) {
  return [...drivers.values()]
    .filter((d) => d.available && d.lat != null && distanceKm(lat, lng, d.lat, d.lng) <= NEARBY_KM)
    .map((d) => ({ id: d.id, name: d.name, vehicle: d.vehicle, lat: d.lat, lng: d.lng }));
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

// Cancela un viaje activo (by: passenger | driver | admin | system) y avisa a las dos partes
async function cancelRide(rideId, by) {
  const ride = await getRide(rideId);
  if (!ride || !['requested', 'accepted', 'arrived', 'started'].includes(ride.status)) return null;
  await pool.query('UPDATE rides SET status = "cancelled", cancelled_by = ? WHERE id = ?', [by, rideId]);
  closeOpenRide(rideId);
  if (ride.driver_id) releaseDriver(ride.driver_id);
  const view = await rideView(await getRide(rideId));
  io.to(room(ride.passenger_id)).to(room(ride.driver_id || 0)).emit('ride:state', view);
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
  const on = (ev, fn) => socket.on(ev, (...args) => Promise.resolve(fn(...args)).catch((e) => console.error(`[${ev}]`, e)));
  socket.join(room(user.id));
  if (user.role === 'driver') socket.join('drivers');
  socket.emit('account:status', { status: user.status });
  console.log(`+ ${user.role} ${user.name}`);

  // Restaurar viaje activo si el usuario recarga la página
  const active = await activeRideFor(user);
  if (active) socket.emit('ride:state', await rideView(active));

  // ----- Conductor -----
  if (user.role === 'driver') {
    on('driver:online', async (pos) => {
      if (!isPoint(pos)) return;
      const [[u]] = await pool.query('SELECT status FROM users WHERE id = ?', [user.id]);
      if (u?.status !== 'active') return socket.emit('driver:denied', { status: u?.status });
      const { lat, lng } = pos;
      const busy = await activeRideFor(user); // si se reconecta en pleno viaje, sigue ocupado
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
      if (ride) io.to(room(ride.passenger_id)).emit('ride:driver_location', { lat, lng });
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
        await pool.query('UPDATE offers SET price = ? WHERE id = ?', [price, offerId]);
      } else {
        const [r] = await pool.query('INSERT INTO offers (ride_id, driver_id, price) VALUES (?,?,?)', [rideId, user.id, price]);
        offerId = r.insertId;
      }
      io.to(room(ride.passenger_id)).emit('offer:new', {
        id: offerId, rideId, price,
        driver: { id: user.id, name: user.name, vehicle: user.vehicle, plate: user.plate, rating: (await ratingsOf([user.id])).get(user.id) || { avg: null, count: 0 } },
        distanceToPickupKm: d.lat != null ? distanceKm(d.lat, d.lng, ride.origin_lat, ride.origin_lng) : null,
      });
      socket.emit('offer:sent', { rideId, price });
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
      if (status === 'completed') releaseDriver(user.id);
      const view = await rideView(await getRide(rideId));
      io.to(room(ride.passenger_id)).to(room(user.id)).emit('ride:state', view);
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
          if (d.available && distanceKm(d.lat, d.lng, origin.lat, origin.lng) <= NEARBY_KM)
            io.to(room(d.id)).emit('ride:new', ride);
        }
        socket.emit('ride:state', ride);
        ack?.({ ok: true });
      } catch (e) {
        console.error(e);
        ack?.({ error: 'No se pudo crear el viaje' });
      }
    });

    on('offer:accept', async ({ offerId }) => {
      const [rows] = await pool.query('SELECT * FROM offers WHERE id = ? AND status = "pending"', [offerId]);
      const offer = rows[0];
      if (!offer) return;
      const ride = await getRide(offer.ride_id);
      const d = drivers.get(offer.driver_id);
      if (!ride || ride.passenger_id !== user.id || ride.status !== 'requested') return;
      if (!d?.available) {
        await pool.query('UPDATE offers SET status = "rejected" WHERE id = ?', [offer.id]);
        return socket.emit('offer:invalid', { offerId: offer.id });
      }

      await pool.query('UPDATE rides SET driver_id = ?, final_price = ?, status = "accepted" WHERE id = ?', [offer.driver_id, offer.price, ride.id]);
      await pool.query('UPDATE offers SET status = IF(id = ?, "accepted", "rejected") WHERE ride_id = ?', [offer.id, ride.id]);
      d.available = false;
      closeOpenRide(ride.id);

      const view = await rideView(await getRide(ride.id));
      io.to(room(user.id)).to(room(offer.driver_id)).emit('ride:state', view);
    });

    on('ride:cancel', async ({ rideId }) => {
      const ride = await getRide(rideId);
      if (!ride || ride.passenger_id !== user.id || !['requested', 'accepted', 'arrived'].includes(ride.status)) return;
      await cancelRide(rideId, 'passenger');
    });
  }

  // Botón de emergencia: registra la alerta para el administrador junto con la ubicación
  on('ride:sos', async (pos, ack) => {
    const ride = await activeRideFor(user);
    if (!ride || ride.status === 'requested') return ack?.({ error: 'Solo disponible durante un viaje' });
    const live = user.role === 'driver' ? drivers.get(user.id) : passengers.get(user.id);
    const at = isPoint(pos) ? pos : live?.lat != null ? live : null;
    await pool.query('INSERT INTO alerts (ride_id, user_id, lat, lng) VALUES (?,?,?,?)', [ride.id, user.id, at?.lat ?? null, at?.lng ?? null]);
    console.warn(`🆘 SOS de ${user.name} (viaje ${ride.id})`);
    ack?.({ ok: true });
  });

  socket.on('disconnect', async () => {
    // Si el usuario sigue conectado desde otra pestaña, no se toca nada
    if ((await io.in(room(user.id)).fetchSockets()).length) return;
    if (user.role === 'driver') {
      const d = drivers.get(user.id);
      if (d?.available) drivers.delete(user.id);
      else if (d) d.disconnected = true; // con viaje activo: se quita del mapa cuando termine
    }
    if (user.role === 'passenger') passengers.delete(user.id);
  });
});

// Cada 3 s se envían a cada pasajero los conductores libres cercanos
setInterval(() => {
  for (const p of passengers.values()) {
    io.to(room(p.id)).emit('drivers:nearby', nearbyDrivers(p.lat, p.lng));
  }
}, 3000);

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
  app.use(express.static(DIST, { index: false, maxAge: '1h' }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

server.listen(PORT, () => console.log(`Jalón API en http://localhost:${PORT}`));
