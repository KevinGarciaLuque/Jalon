// Recargas por solicitud: el conductor pide recargar un monto; el personal le asigna una de las cuentas de Ktracho GO
// y esa cuenta solo la ve ese conductor durante 24 horas. Después sube el comprobante como siempre (routes/driver.js).
import { pool } from '../db.js';
import { getSettings, money } from '../wallet.js';
import { app, io } from '../app.js';
import { room } from '../live.js';
import { authUser, driverOnly, staffOnly, audit } from '../access.js';
import { push, pushStaff } from '../notify.js';
import { activeAccounts } from '../services/bankAccounts.js';

export const ACCOUNT_HOURS = 24; // cuánto tiempo ve el conductor la cuenta asignada
const OPEN = "(r.status = 'waiting' OR (r.status = 'assigned' AND r.expires_at > NOW()))";
const clean = (v, max) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

const accountView = (a) => a && { id: a.id, bank: a.bank, type: a.account_type, number: a.account_number, holder: a.holder, note: a.note, active: !!a.active };

// Lo que el conductor ve de su solicitud más reciente; la cuenta solo mientras está asignada y vigente
export async function currentRequest(driverId) {
  const [[r]] = await pool.query(
    `SELECT r.*, a.bank, a.account_type, a.account_number, a.holder, a.note, (r.expires_at > NOW()) AS vigente
     FROM topup_requests r LEFT JOIN bank_accounts a ON a.id = r.bank_account_id
     WHERE r.driver_id = ? AND r.created_at > NOW() - INTERVAL 7 DAY ORDER BY r.id DESC LIMIT 1`, [driverId]
  );
  if (!r) return null;
  const status = r.status === 'assigned' && !r.vigente ? 'expired' : r.status;
  return {
    id: r.id, amount: Number(r.amount), status, note: r.review_note, createdAt: r.created_at, expiresAt: r.expires_at,
    account: status === 'assigned' ? { bank: r.bank, type: r.account_type, number: r.account_number, holder: r.holder, note: r.note } : null,
  };
}

// La solicitud con cuenta vigente de un conductor (para aceptar su comprobante)
export async function assignedRequest(driverId) {
  const [[r]] = await pool.query("SELECT r.* FROM topup_requests r WHERE r.driver_id = ? AND r.status = 'assigned' AND r.expires_at > NOW() ORDER BY r.id DESC LIMIT 1", [driverId]);
  return r || null;
}

// Las cuentas asignadas que vencieron sin comprobante se ocultan
export const expireRequests = async () => (await pool.query("UPDATE topup_requests SET status = 'expired' WHERE status = 'assigned' AND expires_at <= NOW()"))[0].affectedRows;

// ---------- Conductor ----------
app.post('/api/driver/topup-requests', authUser, driverOnly, async (req, res) => {
  if (req.user.status !== 'active') return res.status(403).json({ error: 'Tu cuenta debe estar aprobada para recargar' });
  const s = await getSettings(pool);
  if (s.commission_enabled !== '1') return res.status(409).json({ error: 'Las recargas no están activas' });
  const amount = money(req.body?.amount);
  if (!(amount >= Number(s.topup_min) && amount <= Number(s.topup_max)))
    return res.status(400).json({ error: `La recarga debe ser de L ${Number(s.topup_min)} a L ${Number(s.topup_max)}` });
  const [[counts]] = await pool.query(
    `SELECT COALESCE(SUM(${OPEN}), 0) AS open, COALESCE(SUM(r.created_at > NOW() - INTERVAL 24 HOUR), 0) AS today FROM topup_requests r WHERE r.driver_id = ?`, [req.user.id]
  );
  if (Number(counts.open)) return res.status(409).json({ error: 'Ya tienes una solicitud de recarga abierta' });
  if (Number(counts.today) >= 5) return res.status(429).json({ error: 'Ya pediste varias recargas hoy. Intenta de nuevo mañana.' });
  const [r] = await pool.query('INSERT INTO topup_requests (driver_id, amount) VALUES (?,?)', [req.user.id, amount]);
  pushStaff({ title: 'Solicitud de recarga', body: `${req.user.name} quiere recargar L ${amount.toFixed(2)}: asígnale una cuenta`, tag: `topup-req-${r.insertId}`, url: '/' }, 'wallet');
  res.json({ ok: true, request: await currentRequest(req.user.id) });
});

app.post('/api/driver/topup-requests/:id/cancel', authUser, driverOnly, async (req, res) => {
  const [r] = await pool.query(`UPDATE topup_requests r SET r.status = 'cancelled' WHERE r.id = ? AND r.driver_id = ? AND ${OPEN}`, [Number(req.params.id), req.user.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Esa solicitud ya no está abierta' });
  res.json({ ok: true, request: await currentRequest(req.user.id) });
});

// ---------- Personal: solicitudes ----------
app.get('/api/admin/topup-requests', staffOnly('wallet'), async (_req, res) => {
  await expireRequests();
  const [rows] = await pool.query(
    `SELECT r.id, r.amount, r.created_at, u.id AS driver_id, u.name AS driver, u.phone AS driver_phone, u.balance AS driver_balance
     FROM topup_requests r JOIN users u ON u.id = r.driver_id WHERE r.status = 'waiting' ORDER BY r.id LIMIT 100`
  );
  res.json({ requests: rows.map((r) => ({ ...r, amount: Number(r.amount), driver_balance: Number(r.driver_balance) })), accounts: (await activeAccounts()).map(accountView) });
});

app.post('/api/admin/topup-requests/:id/assign', staffOnly('wallet'), async (req, res) => {
  const id = Number(req.params.id);
  const [[account]] = await pool.query('SELECT * FROM bank_accounts WHERE id = ? AND active = 1', [Number(req.body?.accountId) || 0]);
  if (!account) return res.status(400).json({ error: 'Elige una cuenta activa' });
  const [[r]] = await pool.query('SELECT * FROM topup_requests WHERE id = ?', [id]);
  if (!r) return res.status(404).json({ error: 'Solicitud no encontrada' });
  // Atómico: si dos personas asignan a la vez, solo una lo logra
  const [claim] = await pool.query(
    "UPDATE topup_requests SET status = 'assigned', bank_account_id = ?, expires_at = NOW() + INTERVAL ? HOUR, handled_by = ?, handled_at = NOW() WHERE id = ? AND status = 'waiting'",
    [account.id, ACCOUNT_HOURS, req.staff.id, id]
  );
  if (claim.affectedRows !== 1) return res.status(409).json({ error: 'Esa solicitud ya fue atendida' });
  await audit(req.staff, 'topup.assign', { target: r.driver_id, details: { request: id, account: account.id, bank: account.bank } });
  io.to(room(r.driver_id)).emit('wallet:update', {}); // su «Mi saldo» se actualiza solo
  push(r.driver_id, { title: 'Ya puedes transferir', body: `Te asignamos una cuenta de ${account.bank} para recargar L ${Number(r.amount).toFixed(2)}. Tienes ${ACCOUNT_HOURS} horas.`, tag: `topup-req-${id}`, target: 'wallet', url: '/' }, { always: true });
  res.json({ ok: true });
});

app.post('/api/admin/topup-requests/:id/reject', staffOnly('wallet'), async (req, res) => {
  const note = clean(req.body?.note, 300);
  if (note.length < 3) return res.status(400).json({ error: 'Escribe el motivo (el conductor lo verá)' });
  const id = Number(req.params.id);
  const [[r]] = await pool.query('SELECT driver_id FROM topup_requests WHERE id = ?', [id]);
  if (!r) return res.status(404).json({ error: 'Solicitud no encontrada' });
  const [u] = await pool.query("UPDATE topup_requests SET status = 'rejected', review_note = ?, handled_by = ?, handled_at = NOW() WHERE id = ? AND status = 'waiting'", [note, req.staff.id, id]);
  if (u.affectedRows !== 1) return res.status(409).json({ error: 'Esa solicitud ya fue atendida' });
  await audit(req.staff, 'topup.request.reject', { target: r.driver_id, details: { request: id, note } });
  io.to(room(r.driver_id)).emit('wallet:update', {});
  push(r.driver_id, { title: 'Solicitud de recarga rechazada', body: note, tag: `topup-req-${id}`, target: 'wallet', url: '/' }, { always: true });
  res.json({ ok: true });
});

// ---------- Personal: las cuentas de Ktracho GO ----------
function readAccount(body) {
  const a = { bank: clean(body?.bank, 60), account_type: clean(body?.type, 40) || null, account_number: clean(body?.number, 60), holder: clean(body?.holder, 100), note: clean(body?.note, 400) || null };
  if (!a.bank || !a.account_number || !a.holder) return { error: 'Escribe el banco, el número de cuenta y a nombre de quién' };
  return { account: a };
}

app.get('/api/admin/bank-accounts', staffOnly('wallet'), async (_req, res) => {
  const [rows] = await pool.query('SELECT * FROM bank_accounts ORDER BY active DESC, id');
  res.json({ accounts: rows.map(accountView) });
});

app.post('/api/admin/bank-accounts', staffOnly('settings'), async (req, res) => {
  const { account, error } = readAccount(req.body);
  if (error) return res.status(400).json({ error });
  const [r] = await pool.query('INSERT INTO bank_accounts (bank, account_type, account_number, holder, note, created_by) VALUES (?,?,?,?,?,?)',
    [account.bank, account.account_type, account.account_number, account.holder, account.note, req.staff.id]);
  await audit(req.staff, 'bank.create', { details: { account: r.insertId, bank: account.bank } });
  res.json({ ok: true, id: r.insertId });
});

app.put('/api/admin/bank-accounts/:id', staffOnly('settings'), async (req, res) => {
  const id = Number(req.params.id);
  const [[cur]] = await pool.query('SELECT * FROM bank_accounts WHERE id = ?', [id]);
  if (!cur) return res.status(404).json({ error: 'Cuenta no encontrada' });
  const onlyActive = Object.keys(req.body || {}).every((k) => k === 'active');
  let next = cur;
  if (!onlyActive) {
    const { account, error } = readAccount(req.body);
    if (error) return res.status(400).json({ error });
    next = { ...cur, ...account };
  }
  const active = req.body?.active === undefined ? !!cur.active : !!req.body.active;
  // Con la comisión activa tiene que quedar al menos una cuenta para asignar
  if (!active && cur.active && (await getSettings(pool)).commission_enabled === '1' && (await activeAccounts()).length <= 1)
    return res.status(409).json({ error: 'Es la única cuenta activa y la comisión está encendida: agrega otra antes de desactivarla' });
  await pool.query('UPDATE bank_accounts SET bank = ?, account_type = ?, account_number = ?, holder = ?, note = ?, active = ? WHERE id = ?',
    [next.bank, next.account_type, next.account_number, next.holder, next.note, active ? 1 : 0, id]);
  await audit(req.staff, 'bank.update', { details: { account: id, bank: next.bank, active } });
  res.json({ ok: true });
});
