import 'dotenv/config';
// Recargas por solicitud: el conductor pide, el personal le asigna una cuenta (solo él la ve, 24 horas) y luego sube el comprobante
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';
import { FIXTURE, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const phone = (p) => `${p}${rnd}${Math.floor(Math.random() * 10)}`.slice(0, 8);
const IMG = `data:image/jpeg;base64,${FIXTURE.toString('base64')}`;
const variant = (n) => { const b = Buffer.from(FIXTURE); const i = b.length - 30; b[i] = (b[i] + n + 40) % 200; return `data:image/jpeg;base64,${b.toString('base64')}`; };

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const [sup] = await pool.query("INSERT INTO users (name, phone, password_hash, role, status, totp_enabled, terms_accepted_at) VALUES ('T Soporte 29', ?, ?, 'support', 'active', 1, NOW())", [phone('53'), await bcrypt.hash('no-se-usa-1', 4)]);
const SUP = jwt.sign({ id: sup.insertId, role: 'support' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);
const activeBefore = (await pool.query('SELECT id FROM bank_accounts WHERE active = 1'))[0].map((r) => r.id);

const newDriver = async (name, ph, plate) => {
  const d = await registerUser({ name, phone: ph, password: 'Cielo-azul-77', role: 'driver', vehicle: 'Hilux', plate });
  await uploadDocs(d.token);
  await http('POST', `admin/users/${d.user.id}/status`, SA, { status: 'active' });
  return d;
};

try {
  // ---- Cuentas bancarias ----
  check('soporte no puede agregar cuentas', (await http('POST', 'admin/bank-accounts', SUP, { bank: 'X', number: '1', holder: 'Y' })).status === 403);
  check('una cuenta incompleta se rechaza', (await http('POST', 'admin/bank-accounts', SA, { bank: 'BAC' })).status === 400);
  const A1 = await http('POST', 'admin/bank-accounts', SA, { bank: 'BAC 29', type: 'Ahorros', number: '29-111-111', holder: 'Ktracho GO' });
  const A2 = await http('POST', 'admin/bank-accounts', SA, { bank: 'Ficohsa 29', number: '29-222-222', holder: 'Ktracho GO' });
  check('el superadmin agrega dos cuentas', A1.ok && A2.ok);
  await http('PUT', 'admin/settings', SA, { commission_enabled: true, topup_min: 100, topup_max: 1000 });
  const accounts = (await http('GET', 'admin/bank-accounts', SA)).accounts;
  check('la lista muestra las cuentas', accounts.some((a) => a.id === A1.id && a.number === '29-111-111' && a.active));
  check('se puede desactivar una cuenta', (await http('PUT', `admin/bank-accounts/${A2.id}`, SA, { active: false })).ok === true);
  check('una cuenta desactivada no se puede asignar', !(await http('GET', 'admin/topup-requests', SA)).accounts.some((a) => a.id === A2.id));

  // ---- El conductor pide ----
  const D = await newDriver('C29 Conductor', phone('94'), `H29${rnd.slice(0, 4)}`);
  const O = await newDriver('C29 Otro', phone('95'), `J29${rnd.slice(0, 4)}`);
  const w0 = await http('GET', 'driver/wallet', D.token);
  check('«Mi saldo» ya no trae ninguna cuenta bancaria', !('bank' in w0) && !JSON.stringify(w0).includes('29-111-111') && w0.request === null);
  check('sin cuenta asignada no se puede subir un comprobante', /solicita/.test((await http('POST', 'driver/topups', D.token, { amount: 200, bank: 'BAC', reference: 'R29-0001', image: IMG })).error || ''));
  check('pedir menos del mínimo se rechaza', (await http('POST', 'driver/topup-requests', D.token, { amount: 50 })).status === 400);
  check('un pasajero no pide recargas', (await http('POST', 'driver/topup-requests', (await registerUser({ name: 'C29 P', phone: phone('84'), password: 'Cielo-azul-77', role: 'passenger' })).token, { amount: 200 })).status === 403);
  const rq = await http('POST', 'driver/topup-requests', D.token, { amount: 300 });
  check('el conductor solicita recargar L 300', rq.ok && rq.request.status === 'waiting' && rq.request.amount === 300 && !rq.request.account);
  check('solo una solicitud abierta a la vez', (await http('POST', 'driver/topup-requests', D.token, { amount: 200 })).status === 409);

  // ---- El personal la ve y asigna ----
  check('soporte no ve las solicitudes', (await http('GET', 'admin/topup-requests', SUP)).status === 403);
  const list = await http('GET', 'admin/topup-requests', SA);
  const mine = list.requests.find((r) => r.id === rq.request.id);
  check('el personal ve la solicitud con el conductor y el monto', mine?.driver === 'C29 Conductor' && mine.amount === 300);
  const stats = await http('GET', 'admin/stats', SA);
  check('el panel cuenta las solicitudes esperando', stats.waitingRequests >= 1);
  check('no se asigna una cuenta desactivada', (await http('POST', `admin/topup-requests/${rq.request.id}/assign`, SA, { accountId: A2.id })).status === 400);
  const both = await Promise.all([1, 2].map(() => http('POST', `admin/topup-requests/${rq.request.id}/assign`, SA, { accountId: A1.id })));
  check('si dos asignan a la vez, solo una vale', both.filter((r) => r.ok).length === 1 && both.filter((r) => r.status === 409).length === 1);

  const w1 = await http('GET', 'driver/wallet', D.token);
  check('el conductor ve su cuenta asignada y cuándo vence', w1.request.status === 'assigned' && w1.request.account?.number === '29-111-111' && !!w1.request.expiresAt);
  const hours = (new Date(w1.request.expiresAt) - Date.now()) / 3600000;
  check('la cuenta le dura 24 horas', hours > 23.5 && hours <= 24.1, `(${hours.toFixed(2)} h)`);
  check('otro conductor no ve esa cuenta', !JSON.stringify(await http('GET', 'driver/wallet', O.token)).includes('29-111-111'));
  const bell = await http('GET', 'notifications', D.token);
  check('al conductor le llega el aviso «Ya puedes transferir»', bell.items?.some((n) => n.title === 'Ya puedes transferir' && n.target === 'wallet'));

  // ---- Sube el comprobante: queda unido a la solicitud y la cuenta se oculta ----
  const t = await http('POST', 'driver/topups', D.token, { amount: 300, bank: 'BAC', reference: `R29-${rnd}`, image: variant(1) });
  check('con la cuenta asignada sube su comprobante', t.ok === true);
  const [[row]] = await pool.query('SELECT request_id FROM topups WHERE id = ?', [t.id]);
  check('el comprobante queda unido a su solicitud', row.request_id === rq.request.id);
  const w2 = await http('GET', 'driver/wallet', D.token);
  check('después del comprobante la cuenta ya no se muestra', w2.request.status === 'used' && !w2.request.account);

  // ---- Vencer: a las 24 horas la cuenta se oculta ----
  const rq2 = await http('POST', 'driver/topup-requests', D.token, { amount: 150 });
  await http('POST', `admin/topup-requests/${rq2.request.id}/assign`, SA, { accountId: A1.id });
  await pool.query('UPDATE topup_requests SET expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [rq2.request.id]);
  const w3 = await http('GET', 'driver/wallet', D.token);
  check('vencida, el conductor ya no ve la cuenta', w3.request.status === 'expired' && !w3.request.account);
  check('vencida, no puede subir comprobante', (await http('POST', 'driver/topups', D.token, { amount: 150, bank: 'BAC', reference: `V29-${rnd}`, image: variant(2) })).status === 409);
  check('y puede volver a pedir', (await http('POST', 'driver/topup-requests', D.token, { amount: 150 })).ok === true);

  // ---- Cancelar y rechazar ----
  const cur = (await http('GET', 'driver/wallet', D.token)).request;
  check('el conductor cancela su solicitud', (await http('POST', `driver/topup-requests/${cur.id}/cancel`, D.token, {})).request?.status === 'cancelled');
  const rq3 = await http('POST', 'driver/topup-requests', O.token, { amount: 200 });
  check('rechazar exige un motivo', (await http('POST', `admin/topup-requests/${rq3.request.id}/reject`, SA, {})).status === 400);
  check('el personal rechaza con motivo', (await http('POST', `admin/topup-requests/${rq3.request.id}/reject`, SA, { note: 'Hoy no recibimos recargas' })).ok === true);
  const wo = await http('GET', 'driver/wallet', O.token);
  check('el conductor ve el motivo del rechazo', wo.request.status === 'rejected' && wo.request.note === 'Hoy no recibimos recargas');
  check('otro conductor no puede cancelar una solicitud ajena', (await http('POST', `driver/topup-requests/${rq3.request.id}/cancel`, D.token, {})).status === 404);

  // ---- Registro ----
  const audit = await http('GET', 'admin/audit', SA);
  check('el Registro anota cuentas creadas, editadas, asignadas y rechazos', ['bank.create', 'bank.update', 'topup.assign', 'topup.request.reject'].every((a) => audit.some((x) => x.action === a)));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await http('PUT', 'admin/settings', SA, { commission_enabled: before.commission_enabled === '1', topup_min: Number(before.topup_min), topup_max: Number(before.topup_max) });
  await pool.query('UPDATE bank_accounts SET active = 0 WHERE bank LIKE ?', ['% 29']);
  if (activeBefore.length) await pool.query('UPDATE bank_accounts SET active = 1 WHERE id IN (?)', [activeBefore]);
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
