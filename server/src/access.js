// Quién es quién y qué puede hacer: sesiones (JWT), contraseñas, roles del personal, permisos y registro de auditoría
import jwt from 'jsonwebtoken';
import { pool } from './db.js';
import { getSettings } from './wallet.js';
import { JWT_SECRET } from './config.js';

// El personal maneja datos de todos: su sesión dura 12 horas; pasajeros y conductores, 30 días
export const sign = (u) => jwt.sign({ id: u.id, role: u.role, tv: u.token_version ?? 0 }, JWT_SECRET, { expiresIn: ['superadmin', 'admin', 'support'].includes(u.role) ? '12h' : '30d' });

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
export const publicUser = (u, require2fa = true) => ({ id: u.id, name: u.name, phone: u.phone, email: u.email || null, role: u.role, status: u.status, vehicle: u.vehicle, plate: u.plate, mustChangePassword: !!u.must_change_password,
  // El personal debe tener la verificación en dos pasos activa para usar el panel (si está exigida)
  mustEnrollTwoFactor: require2fa && isStaff(u.role) && !u.totp_enabled, twoFactorEnabled: !!u.totp_enabled });

export async function authUser(req, res, next) {
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

export const driverOnly = (req, res, next) => (req.user.role === 'driver' ? next() : res.status(403).json({ error: 'Solo conductores' }));

export const passengerOnly = (req, res, next) => (req.user.role === 'passenger' ? next() : res.status(403).json({ error: 'Solo para pasajeros' }));

// ---------- Personal: superadmin, administrador y soporte ----------
export const STAFF = ['superadmin', 'admin', 'support'];
export const isStaff = (role) => STAFF.includes(role);
// Qué puede hacer cada rol: el superadmin todo; el administrador opera la plataforma; soporte mira y atiende emergencias
export const PERMS = {
  superadmin: ['view', 'alerts', 'rides.cancel', 'users.manage', 'users.create', 'docs', 'audit', 'staff.manage', 'wallet', 'wallet.adjust', 'settings'],
  admin: ['view', 'alerts', 'rides.cancel', 'users.manage', 'docs', 'audit', 'wallet'],
  support: ['view', 'alerts', 'rides.cancel'],
};

// 'monitor' (mapa en vivo y desempeño de conductores): siempre el superadmin; un administrador solo si el superadmin se lo concedió; soporte nunca
export const permsOf = (u) => (u.role === 'superadmin' || (u.role === 'admin' && u.can_monitor) ? [...PERMS[u.role], 'monitor'] : PERMS[u.role]);

// Middleware: exige sesión de personal activo con el permiso indicado (se consulta la base en cada petición)
export function staffOnly(perm) {
  return async (req, res, next) => {
    try {
      const payload = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), JWT_SECRET);
      const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [payload.id]);
      const u = rows[0];
      if (!u || (payload.tv ?? 0) !== u.token_version) return res.status(401).json({ error: 'No autorizado' });
      if (!isStaff(u.role) || u.status !== 'active') return res.status(403).json({ error: 'Solo personal autorizado' });
      if (u.must_change_password) return res.status(403).json({ error: 'Debes cambiar tu contraseña', code: 'MUST_CHANGE_PASSWORD' });
      if (!u.totp_enabled && (await twoFactorRequired())) return res.status(403).json({ error: 'Activa la verificación en dos pasos para continuar', code: 'MUST_ENROLL_2FA' });
      if (!permsOf(u).includes(perm)) return res.status(403).json({ error: 'No tienes permiso para esto' });
      req.staff = u;
      next();
    } catch {
      res.status(401).json({ error: 'No autorizado' });
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
  else if (isStaff(t.role) && !permsOf(req.staff).includes('staff.manage')) problem = 'Solo el superadministrador gestiona al personal';
  if (problem) return void res.status(403).json({ error: problem });
  return t;
}
