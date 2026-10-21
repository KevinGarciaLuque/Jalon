// Permisos por módulo: el superadmin decide qué ve cada rol y le da o le quita un módulo a una persona en particular
import { pool } from '../db.js';
import { app } from '../app.js';
import { staffOnly, audit, actOn } from '../access.js';
import { MODULES, ROLES, grantable, rolePerms, saveRolePerms, overridesOf, permsFor } from '../perms.js';

// Qué módulos hay, a qué roles se pueden dar y qué tiene cada rol
app.get('/api/admin/permissions', staffOnly('staff.manage'), async (_req, res) => {
  res.json({ modules: MODULES, roles: await rolePerms() });
});

app.put('/api/admin/permissions/:role', staffOnly('staff.manage'), async (req, res) => {
  const role = req.params.role;
  if (!ROLES.includes(role)) return res.status(400).json({ error: 'Rol inválido' });
  const perms = req.body?.perms;
  if (!Array.isArray(perms) || perms.some((p) => typeof p !== 'string')) return res.status(400).json({ error: 'Indica la lista de módulos' });
  const bad = perms.find((p) => !grantable(role, p));
  if (bad) return res.status(400).json({ error: `Ese módulo no se puede dar a este rol: ${bad}` });
  const before = (await rolePerms())[role];
  const saved = await saveRolePerms(role, perms, req.staff.id);
  await audit(req.staff, 'perms.role', { details: { role, added: saved.filter((p) => !before.includes(p)), removed: before.filter((p) => !saved.includes(p)) } });
  res.json({ ok: true, perms: saved });
});

// Permisos de una persona: los de su rol, sus excepciones y el resultado
app.get('/api/admin/users/:id/permissions', staffOnly('staff.manage'), async (req, res) => {
  const [[u]] = await pool.query('SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL', [Number(req.params.id)]);
  if (!u) return res.status(404).json({ error: 'Usuario no existe' });
  if (!ROLES.includes(u.role)) return res.json({ role: u.role, modules: [], roleDefault: [], overrides: {}, effective: await permsFor(u) });
  res.json({
    role: u.role,
    modules: MODULES.filter((m) => m.roles.includes(u.role)),
    roleDefault: (await rolePerms())[u.role],
    overrides: await overridesOf(u.id),
    effective: await permsFor(u),
  });
});

// allow: true = se lo da, false = se lo quita, null = vuelve a lo de su rol
app.put('/api/admin/users/:id/permissions', staffOnly('staff.manage'), async (req, res) => {
  const t = await actOn(req, res);
  if (!t) return;
  const { perm, allow } = req.body || {};
  if (!grantable(t.role, perm)) return res.status(400).json({ error: 'Ese módulo no se puede dar a una persona de este rol' });
  if (allow !== null && typeof allow !== 'boolean') return res.status(400).json({ error: 'Indica si se da, se quita o vuelve a lo de su rol' });
  if (allow === null) await pool.query('DELETE FROM user_permissions WHERE user_id = ? AND perm = ?', [t.id, perm]);
  else await pool.query('INSERT INTO user_permissions (user_id, perm, allow, updated_by) VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE allow = VALUES(allow), updated_by = VALUES(updated_by)', [t.id, perm, allow ? 1 : 0, req.staff.id]);
  if (perm === 'monitor') await pool.query('UPDATE users SET can_monitor = ? WHERE id = ?', [allow ? 1 : 0, t.id]); // compatibilidad
  await audit(req.staff, 'perms.user', { target: t.id, details: { perm, allow } });
  res.json({ ok: true, effective: await permsFor(t) });
});
