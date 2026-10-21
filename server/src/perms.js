// Permisos por módulo. El superadmin decide qué ve cada rol (Ajustes → role_perms) y puede darle o quitarle un módulo
// a una persona en particular (tabla user_permissions). El superadmin siempre tiene todo.
import { pool } from './db.js';
import { getSettings, clearSettingsCache } from './wallet.js';

// Cada módulo dice a qué roles se puede dar. 'settings' y 'staff.manage' (Ajustes y Personal) son solo del superadmin.
export const MODULES = [
  { key: 'view', label: 'Ver viajes, usuarios e indicadores del panel', group: 'panel', roles: ['admin', 'support'] },
  { key: 'alerts', label: 'Emergencias, reportes y chat de viajes con problemas', group: 'panel', roles: ['admin', 'support'] },
  { key: 'rides.cancel', label: 'Cancelar viajes', group: 'panel', roles: ['admin', 'support'] },
  { key: 'users.manage', label: 'Aprobar, bloquear y editar usuarios', group: 'panel', roles: ['admin', 'support'] },
  { key: 'users.create', label: 'Agregar pasajeros', group: 'panel', roles: ['admin', 'support'] },
  { key: 'docs', label: 'Documentos de los conductores', group: 'panel', roles: ['admin', 'support'] },
  { key: 'audit', label: 'Registro de movimientos', group: 'panel', roles: ['admin', 'support'] },
  { key: 'wallet', label: 'Recargas y saldo de los conductores', group: 'panel', roles: ['admin', 'support'] },
  { key: 'wallet.adjust', label: 'Ajustar el saldo de un conductor', group: 'panel', roles: ['admin'] },
  { key: 'monitor', label: 'Mapa en vivo y desempeño de conductores', group: 'panel', roles: ['admin', 'support'] },
  { key: 'rentals', label: 'Alquileres: reservas y pagos', group: 'panel', roles: ['admin', 'support'] },
  { key: 'fleet', label: 'Flota de Jalón: agregar carros y precios', group: 'panel', roles: ['admin'] },
  { key: 'rent', label: 'Alquilar un carro por días', group: 'app', roles: ['passenger'] },
  { key: 'rent.offer', label: 'Ofrecer su carro en alquiler', group: 'app', roles: ['driver'] },
];
export const ROLES = ['admin', 'support', 'driver', 'passenger'];
const SUPERADMIN_ONLY = ['settings', 'staff.manage'];
export const ALL_PERMS = [...MODULES.map((m) => m.key), ...SUPERADMIN_ONLY];
export const grantable = (role, perm) => !!MODULES.find((m) => m.key === perm)?.roles.includes(role);

// Lo que ve cada rol al principio (igual que antes de los permisos configurables; el alquiler, solo el superadmin)
export const DEFAULT_ROLE_PERMS = {
  admin: ['view', 'alerts', 'rides.cancel', 'users.manage', 'docs', 'audit', 'wallet'],
  support: ['view', 'alerts', 'rides.cancel'],
  driver: [],
  passenger: [],
};

// Permisos de cada rol según Ajustes (si nunca se cambiaron, los de arriba)
export async function rolePerms() {
  const s = await getSettings(pool);
  let saved = {};
  try { saved = s.role_perms ? JSON.parse(s.role_perms) : {}; } catch { saved = {}; }
  return Object.fromEntries(ROLES.map((r) => [r, (saved[r] || DEFAULT_ROLE_PERMS[r]).filter((p) => grantable(r, p))]));
}

export async function saveRolePerms(role, perms, by) {
  const all = await rolePerms();
  all[role] = [...new Set(perms)].filter((p) => grantable(role, p));
  await pool.query('INSERT INTO settings (name, value, updated_by) VALUES (?,?,?) ON DUPLICATE KEY UPDATE value = VALUES(value), updated_by = VALUES(updated_by)', ['role_perms', JSON.stringify(all), by]);
  clearSettingsCache();
  return all[role];
}

export async function overridesOf(userId) {
  const [rows] = await pool.query('SELECT perm, allow FROM user_permissions WHERE user_id = ?', [userId]);
  return Object.fromEntries(rows.map((r) => [r.perm, !!r.allow]));
}

// Lo que puede hacer esta persona: lo de su rol, más lo que se le dio, menos lo que se le quitó
export async function permsFor(u) {
  if (u.role === 'superadmin') return [...ALL_PERMS];
  const base = new Set((await rolePerms())[u.role] || []);
  for (const [perm, allow] of Object.entries(await overridesOf(u.id))) {
    if (!grantable(u.role, perm)) continue;
    if (allow) base.add(perm);
    else base.delete(perm);
  }
  return [...base];
}

export const can = async (u, perm) => (await permsFor(u)).includes(perm);
