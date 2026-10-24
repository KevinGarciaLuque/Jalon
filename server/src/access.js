// Quién es quién y qué puede hacer: sesiones (JWT), contraseñas, roles del personal, permisos y registro de auditoría
import jwt from 'jsonwebtoken';
import { pool } from './db.js';
import { getSettings } from './wallet.js';
import { JWT_SECRET, isProd, SESSION_COOKIE, SESSION_HEADER } from './config.js';
import { permsFor, can } from './perms.js';
import { TERMS_VERSION } from './legal.js';

// El personal maneja datos de todos: su sesión dura 12 horas; pasajeros y conductores, 30 días
export const sign = (u) => jwt.sign({ id: u.id, role: u.role, tv: u.token_version ?? 0 }, JWT_SECRET, { expiresIn: ['superadmin', 'admin', 'support'].includes(u.role) ? '12h' : '30d' });

// ---------- Dónde viaja la sesión ----------
// La app web la guarda en una cookie HttpOnly (JavaScript no la puede leer, así un script malicioso no se la roba).
// Otros clientes (las pruebas, una futura app nativa) siguen usando «Authorization: Bearer <token>».
export function readCookie(header, name) {
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return '';
}
export const wantsCookie = (req) => req.headers[SESSION_HEADER] === 'cookie';
const cookieOptions = { httpOnly: true, secure: isProd, sameSite: 'strict', path: '/' };
function writeCookie(res, token) {
  const { exp } = jwt.decode(token);
  res.cookie(SESSION_COOKIE, token, { ...cookieOptions, maxAge: Math.max(0, exp * 1000 - Date.now()) });
}
export const clearSession = (res) => res.clearCookie(SESSION_COOKIE, cookieOptions);
// Abre (o renueva) la sesión: la app web la recibe en la cookie; los demás, el token en la respuesta
export function startSession(req, res, u) {
  const token = sign(u);
  if (!wantsCookie(req)) return { token };
  writeCookie(res, token);
  return {};
}
// Pasa a la cookie una sesión que la app tenía guardada (de antes de este cambio), sin alargar su duración
export const moveToCookie = (res, token) => writeCookie(res, token);

const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);
const fail = (status, error) => Object.assign(new Error(error), { status });
// El token de la petición: primero la cabecera Authorization; si no hay, la cookie.
// Con la cookie, lo que cambia algo exige la cabecera de la app: otro sitio no puede ponerla (CSRF).
function requestToken(req) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer /, '');
  if (bearer) return bearer;
  const cookie = readCookie(req.headers.cookie, SESSION_COOKIE);
  if (cookie && !SAFE.has(req.method) && !wantsCookie(req)) throw fail(403, 'Petición no permitida');
  return cookie;
}
// La persona dueña del token, si sigue valiendo (no se cerró la sesión ni se cambió la contraseña)
export async function userFromToken(token) {
  const payload = jwt.verify(token, JWT_SECRET);
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [payload.id]);
  return rows[0] && (payload.tv ?? 0) === rows[0].token_version ? rows[0] : null;
}

// Reglas de contraseña: 8 caracteres (10 para el personal), no solo números, nada obvio y que no contenga el teléfono
const COMMON_PASSWORDS = new Set(['12345678', '123456789', '1234567890', '87654321', 'password', 'password1', 'contrasena', 'contrasena1', 'qwertyui', 'qwerty123', 'abcdefgh', 'abc12345', '11111111', '00000000', 'jalon2026', 'jalon1234', 'honduras', 'honduras1']);
export function checkPassword(password, { phone = '', role = 'passenger' } = {}) {
  const min = ['superadmin', 'admin', 'support'].includes(role) ? 10 : 8;
  if (typeof password !== 'string' || password.length < min || password.length > 72) return `La contraseña debe tener entre ${min} y 72 caracteres`;
  if (/^\d+$/.test(password)) return 'La contraseña no puede ser solo números';
  if (new Set(password).size < 4) return 'La contraseña es demasiado simple';
  if (COMMON_PASSWORDS.has(password.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''))) return 'Esa contraseña es muy común: elige otra';
  const digits = String(phone).replace(/\D/g, '').slice(-8);
  if (digits.length === 8 && password.includes(digits)) return 'La contraseña no puede contener tu teléfono';
  return null;
}
// El superadmin puede apagar la verificación en dos pasos del personal desde Ajustes (por defecto es obligatoria)
export const twoFactorRequired = async () => (await getSettings(pool)).staff_2fa_required !== '0';
// `perms`: los módulos que puede usar (la app muestra u oculta, por ejemplo, el alquiler)
export const publicUser = (u, require2fa = true, perms = []) => ({ id: u.id, name: u.name, phone: u.phone, email: u.email || null, role: u.role, status: u.status, vehicle: u.vehicle, plate: u.plate, gender: u.gender || null, genderVerified: !!u.gender_verified, ridePin: !!u.ride_pin, mustChangePassword: !!u.must_change_password, perms,
  // Pasajeros y conductores que aceptaron una versión anterior de los términos los vuelven a ver al abrir la app
  mustAcceptTerms: ['passenger', 'driver'].includes(u.role) && u.terms_version !== TERMS_VERSION, termsVersion: TERMS_VERSION,
  // El personal debe tener la verificación en dos pasos activa para usar el panel (si está exigida)
  mustEnrollTwoFactor: require2fa && isStaff(u.role) && !u.totp_enabled, twoFactorEnabled: !!u.totp_enabled });

export async function authUser(req, res, next) {
  try {
    const u = await userFromToken(requestToken(req));
    if (!u || u.status === 'blocked') return res.status(401).json({ error: 'No autorizado' });
    if (u.must_change_password && req.path !== '/api/password/change')
      return res.status(403).json({ error: 'Debes cambiar tu contraseña', code: 'MUST_CHANGE_PASSWORD' });
    req.user = u;
    next();
  } catch (e) {
    res.status(e.status || 401).json({ error: e.status ? e.message : 'No autorizado' });
  }
}

export const driverOnly = (req, res, next) => (req.user.role === 'driver' ? next() : res.status(403).json({ error: 'Solo conductores' }));

export const passengerOnly = (req, res, next) => (req.user.role === 'passenger' ? next() : res.status(403).json({ error: 'Solo para pasajeros' }));

// Exige que la persona (pasajero o conductor) tenga ese módulo (por su rol o porque el superadmin se lo dio)
export const needs = (perm) => async (req, res, next) => ((await can(req.user, perm)) ? next() : res.status(403).json({ error: 'No tienes acceso a esta función' }));

// ---------- Personal: superadmin, administrador y soporte ----------
export const STAFF = ['superadmin', 'admin', 'support'];
export const isStaff = (role) => STAFF.includes(role);
// Qué puede hacer cada quien lo decide el superadmin por rol y por persona (perms.js)

// Middleware: exige sesión de personal activo con el permiso indicado (se consulta la base en cada petición)
export function staffOnly(perm) {
  return async (req, res, next) => {
    try {
      const u = await userFromToken(requestToken(req));
      if (!u) return res.status(401).json({ error: 'No autorizado' });
      if (!isStaff(u.role) || u.status !== 'active') return res.status(403).json({ error: 'Solo personal autorizado' });
      if (u.must_change_password) return res.status(403).json({ error: 'Debes cambiar tu contraseña', code: 'MUST_CHANGE_PASSWORD' });
      if (!u.totp_enabled && (await twoFactorRequired())) return res.status(403).json({ error: 'Activa la verificación en dos pasos para continuar', code: 'MUST_ENROLL_2FA' });
      const perms = await permsFor(u);
      if (!perms.includes(perm)) return res.status(403).json({ error: 'No tienes permiso para esto' });
      req.staff = u;
      req.perms = perms;
      next();
    } catch (e) {
      res.status(e.status || 401).json({ error: e.status ? e.message : 'No autorizado' });
    }
  };
}

// Registro de quién hizo qué
export async function audit(actor, action, { target = null, details = null } = {}) {
  await pool.query('INSERT INTO audit_log (actor_id, action, target_user_id, details) VALUES (?,?,?,?)', [
    actor.id, action, target, details ? JSON.stringify(details) : null,
  ]);
}

// Igual que audit(), pero no repite la misma anotación si ya existe una reciente (abrir un documento carga 3 imágenes)
export async function auditOnce(actor, action, target, minutes = 10, details = null) {
  const [r] = await pool.query(
    'SELECT 1 FROM audit_log WHERE actor_id = ? AND action = ? AND target_user_id = ? AND created_at > NOW() - INTERVAL ? MINUTE LIMIT 1',
    [actor.id, action, target, minutes]
  );
  if (!r.length) await audit(actor, action, { target, details });
}

// Carga al usuario sobre el que se actúa y comprueba que quien actúa pueda tocarlo
export async function actOn(req, res, { allowDeleted = false } = {}) {
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [Number(req.params.id)]);
  const t = rows[0];
  if (!t || (t.deleted_at && !allowDeleted)) return void res.status(404).json({ error: 'Usuario no existe' });
  let problem = null;
  if (t.id === req.staff.id) problem = 'No puedes hacer esto con tu propia cuenta (usa Cuenta para cambiar tu contraseña)';
  else if (t.role === 'superadmin') problem = 'No se puede modificar a un superadministrador';
  else if (isStaff(t.role) && !req.perms.includes('staff.manage')) problem = 'Solo el superadministrador gestiona al personal';
  if (problem) return void res.status(403).json({ error: problem });
  return t;
}
