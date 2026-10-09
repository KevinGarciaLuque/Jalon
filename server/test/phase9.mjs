import 'dotenv/config';
// Fase 9: saldo del conductor, comisión por viaje y recargas por transferencia con comprobante
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { sanitizeJpeg } from '../src/jpeg.js';
import { API, FIXTURE, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const phone = (p) => `${p}${rnd}9`.slice(0, 8);
const UPLOADS = process.env.UPLOADS_DIR || path.join(process.cwd(), 'uploads');
const connect = async (token) => { const s = io(API, { auth: { token } }); await new Promise((r) => s.once('connect', r)); return s; };
const next = (s, ev, pred = () => true, ms = 6000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout esperando ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
const dataUrl = (buf) => `data:image/jpeg;base64,${buf.toString('base64')}`;
const IMG = dataUrl(FIXTURE);
// Comprobantes distintos entre sí (otro byte dentro de los datos de la imagen), todos con estructura de JPEG válida
const variant = (n) => { const b = Buffer.from(FIXTURE); const i = b.length - 30; b[i] = (b[i] + n) % 200; return dataUrl(b); };
const contains = (buf, text) => buf.includes(Buffer.from(text, 'latin1'));

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
// Personal sin permiso sobre dinero (soporte) y con permiso de revisar recargas (administrador)
const mkStaff = async (role, name) => {
  const [r] = await pool.query("INSERT INTO users (name, phone, password_hash, role, status, totp_enabled, terms_accepted_at) VALUES (?, ?, ?, ?, 'active', 1, NOW())", [name, phone(role === 'admin' ? '54' : '53'), await bcrypt.hash('no-se-usa-1', 4), role]);
  return jwt.sign({ id: r.insertId, role }, process.env.JWT_SECRET, { expiresIn: '10m' });
};
const ADM = await mkStaff('admin', 'T Admin');
const SUP = await mkStaff('support', 'T Soporte');

const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.1, lng: -87.2, text: 'Mall Multiplaza' };
const newDriver = async (name, ph, plate) => {
  const d = await registerUser({ name, phone: ph, password: 'Cielo-azul-77', role: 'driver', vehicle: 'Hilux', plate });
  await uploadDocs(d.token);
  return d;
};
const approve = (d) => http('POST', `admin/users/${d.user.id}/status`, ADM, { status: 'active' });
// ¿Se deja poner disponible? Devuelve lo que responde el servidor si lo niega, o null
const tryOnline = (s) => new Promise((res) => { const h = (d) => res(d); s.once('driver:denied', h); s.emit('driver:online', { lat: 14.073, lng: -87.1925 }); setTimeout(() => { s.off('driver:denied', h); res(null); }, 800); });
async function ride(ps, ds, price, { cancel = false } = {}) {
  const reqd = next(ps, 'ride:state', (r) => r.status === 'requested');
  ps.emit('ride:request', { origin, dest, price }, () => {});
  const rd = await reqd;
  const offerP = next(ps, 'offer:new');
  ds.emit('offer:make', { rideId: rd.id, price });
  const offer = await offerP;
  const acc = next(ps, 'ride:state', (r) => r.status === 'accepted');
  ps.emit('offer:accept', { offerId: offer.id });
  await acc;
  if (cancel) { const c = next(ps, 'ride:state', (r) => r.status === 'cancelled'); ds.emit('ride:driver_cancel', { rideId: rd.id }); await c; return rd; }
  for (const st of ['arrived', 'started', 'completed']) { const u = next(ps, 'ride:state', (r) => r.status === st); ds.emit('ride:status', { rideId: rd.id, status: st }); await u; }
  return rd;
}
const balanceOf = async (id) => Number((await pool.query('SELECT balance FROM users WHERE id = ?', [id]))[0][0].balance);
const ledgerSum = async (id) => Number((await pool.query('SELECT COALESCE(SUM(amount),0) AS s FROM wallet_entries WHERE user_id = ?', [id]))[0][0].s);

const P = await registerUser({ name: 'P9 Pasajero', phone: phone('88'), password: 'Cielo-azul-77', role: 'passenger' });
const D0 = await newDriver('P9 Antiguo', phone('87'), 'HPP0001'); // aprobado ANTES de activar la comisión
const D = await newDriver('P9 Conductor', phone('86'), 'HPP0002'); // aprobado después
const ps = await connect(P.token);

// ================= Ajustes (comisión apagada por defecto) =================
const defaults = await http('GET', 'admin/settings', ADM);
check('la comisión viene apagada por defecto', defaults.commission_enabled === '0' && defaults.commission_percent === '10');
check('soporte no ve los ajustes de dinero', (await http('GET', 'admin/settings', SUP)).status === 403);
check('solo el superadmin cambia los ajustes', (await http('PUT', 'admin/settings', ADM, { commission_percent: 12 })).status === 403);
check('una comisión absurda se rechaza', (await http('PUT', 'admin/settings', SA, { commission_percent: 60 })).status === 400);
check('un ajuste inventado se rechaza', (await http('PUT', 'admin/settings', SA, { puerta_trasera: 1 })).status === 400);
check('no se puede activar la comisión sin los datos bancarios', /cuenta de Jalón/.test((await http('PUT', 'admin/settings', SA, { commission_enabled: true })).error || ''));
check('la recarga máxima no puede ser menor que la mínima', (await http('PUT', 'admin/settings', SA, { topup_min: 500, topup_max: 200 })).status === 400);

// Con la comisión apagada, todo sigue como antes: no hay comisión ni se exige saldo
check('con la comisión apagada se aprueba al conductor antiguo', (await approve(D0)).ok === true);
const w0 = await http('GET', 'driver/wallet', D0.token);
check('la billetera del conductor dice que está desactivada', w0.enabled === false && w0.balance === 0);
check('y no se pueden mandar recargas', (await http('POST', 'driver/topups', D0.token, { amount: 200, bank: 'BAC', reference: 'ABC12345', image: IMG })).status === 409);
const d0s = await connect(D0.token);
check('un conductor sin saldo puede ponerse disponible mientras la comisión esté apagada', (await tryOnline(d0s)) === null);
await ride(ps, d0s, 80);
await wait(500);
check('y no se cobra comisión', (await balanceOf(D0.user.id)) === 0 && (await ledgerSum(D0.user.id)) === 0);
d0s.emit('driver:offline');

// ================= Activar la comisión =================
const bank = { bank_name: 'Banco de prueba', bank_account_type: 'Ahorros', bank_account: '12-345-678', bank_holder: 'Jalón S. de R.L.', bank_note: 'Usa tu nombre como referencia' };
const set = await http('PUT', 'admin/settings', SA, { commission_enabled: true, commission_percent: 10, welcome_credit: 50, min_balance: 30, topup_min: 100, topup_max: 1000, ...bank });
check('el superadmin activa la comisión (10%, crédito de bienvenida L 50, saldo mínimo L 30)', set.commission_enabled === '1' && set.welcome_credit === '50' && set.bank_account === '12-345-678');

// ================= Aprobar al conductor nuevo: recibe su crédito de bienvenida =================
check('se aprueba al conductor nuevo', (await approve(D)).ok === true);
await wait(500);
check('recibe L 50 de bienvenida', (await balanceOf(D.user.id)) === 50);
await http('POST', `admin/users/${D.user.id}/status`, ADM, { status: 'blocked' });
await http('POST', `admin/users/${D.user.id}/status`, ADM, { status: 'active' });
await wait(300);
check('bloquear y desbloquear no repite el crédito', (await balanceOf(D.user.id)) === 50);
const dw = await http('GET', 'driver/wallet', D.token);
check('el conductor ve su saldo, la comisión, el mínimo y a dónde transferir', dw.enabled && dw.balance === 50 && dw.percent === 10 && dw.minBalance === 30 && dw.topupMin === 100 && dw.bank.account === '12-345-678' && dw.bank.holder === 'Jalón S. de R.L.');
check('el crédito de bienvenida aparece en sus movimientos', dw.entries.some((e) => e.kind === 'bonus' && Number(e.amount) === 50));
check('la billetera exige sesión de conductor', (await http('GET', 'driver/wallet', null)).status === 401 && (await http('GET', 'driver/wallet', P.token)).status === 403);

// ================= Sin saldo suficiente no se puede trabajar =================
const denied = await tryOnline(d0s);
check('el conductor antiguo (saldo L 0, mínimo L 30) no puede ponerse disponible', denied?.status === 'balance' && denied.balance === 0 && denied.min === 30);
const ds = await connect(D.token);
check('el conductor con L 50 sí', (await tryOnline(ds)) === null);
await wait(300);

// ================= Comisión por viaje =================
const updates = [];
ds.on('wallet:update', (u) => updates.push(u));
await ride(ps, ds, 90, { cancel: true });
await wait(400);
check('un viaje cancelado no cobra comisión', (await balanceOf(D.user.id)) === 50);
await ride(ps, ds, 80);
await wait(900);
check('al completar un viaje de L 80 se descuenta L 8 (10%)', (await balanceOf(D.user.id)) === 42);
check('el conductor se entera al instante', updates.some((u) => u.balance === 42 && u.change === -8 && u.kind === 'commission'));
const mv = await http('GET', 'driver/wallet', D.token);
check('queda el movimiento con el viaje y la nota', mv.entries.some((e) => e.kind === 'commission' && Number(e.amount) === -8 && /10%/.test(e.note) && e.ride_id > 0));
let dup = null;
try { await pool.query("INSERT INTO wallet_entries (user_id, amount, kind, ride_id) SELECT user_id, amount, kind, ride_id FROM wallet_entries WHERE kind = 'commission' AND user_id = ? LIMIT 1", [D.user.id]); } catch (e) { dup = e.code; }
check('la comisión de un mismo viaje no se puede cobrar dos veces (lo impide la base de datos)', dup === 'ER_DUP_ENTRY');

const low = next(ds, 'wallet:low');
await ride(ps, ds, 200);
check('al bajar del mínimo recibe el aviso de saldo bajo', (await low).balance === 22);
check('el viaje de L 200 cobró L 20', (await balanceOf(D.user.id)) === 22);
await wait(300);
const nearby = await new Promise((r) => { ps.once('drivers:nearby', r); ps.emit('passenger:location', origin); });
check('con saldo bajo deja de aparecer disponible', !nearby.some((d) => d.id === D.user.id));
check('y no puede volver a ponerse disponible', (await tryOnline(ds))?.status === 'balance');
check('el libro de cuentas cuadra con el saldo', (await ledgerSum(D.user.id)) === (await balanceOf(D.user.id)));

// ================= Recargar: validaciones =================
const topup = (token, body) => http('POST', 'driver/topups', token, body);
const good = { amount: 200, bank: 'BAC', reference: 'TRF-998877', image: IMG };
check('recargar exige sesión', (await topup(null, good)).status === 401);
check('un pasajero no recarga', (await topup(P.token, good)).status === 403);
check('menos del mínimo se rechaza', /100/.test((await topup(D.token, { ...good, amount: 50 })).error || ''));
check('más del máximo se rechaza', (await topup(D.token, { ...good, amount: 5000 })).status === 400);
check('hay que indicar el número de referencia', (await topup(D.token, { ...good, reference: '' })).status === 400);
check('hay que subir el comprobante', (await topup(D.token, { ...good, image: undefined })).status === 400);
check('un archivo que no es una foto se rechaza', (await topup(D.token, { ...good, image: dataUrl(Buffer.from('esto no es una imagen, solo texto de prueba de varios caracteres')) })).status === 400);
check('un conductor sin aprobar no recarga', (await topup((await newDriver('P9 Nuevo', phone('85'), 'HPP0003')).token, good)).status === 403);

const t1 = await topup(D.token, good);
check('el conductor envía su recarga con el comprobante', t1.ok === true && t1.id > 0);
check('la misma transferencia (aunque cambie el formato de la referencia) no se acepta dos veces', (await topup(D.token, { ...good, reference: 'trf 998877', image: variant(1) })).status === 409);
check('el mismo comprobante tampoco, aunque cambien los datos', /comprobante/.test((await topup(D.token, { ...good, reference: 'OTRA-1111', image: IMG })).error || ''));
const t2 = await topup(D.token, { amount: 300, bank: 'Ficohsa', reference: 'FIC-100200', image: variant(2) });
const t3 = await topup(D.token, { amount: 150, bank: 'Atlántida', reference: 'ATL-300400', image: variant(3) });
check('puede tener varias recargas esperando', t2.ok && t3.ok);
check('pero no más de 3 a la vez', (await topup(D.token, { amount: 100, bank: 'BAC', reference: 'CUARTA-1', image: variant(4) })).status === 429);

// ================= Revisión del personal =================
check('los reportes de recargas no los ve soporte', (await http('GET', 'admin/topups', SUP)).status === 403);
check('ni quien no tiene sesión', (await http('GET', 'admin/topups', null)).status === 401);
const pending = await http('GET', 'admin/topups', ADM);
const p1 = pending.find((t) => t.id === t1.id);
check('el administrador ve las recargas pendientes con el conductor, el monto, la referencia y su saldo', pending.length === 3 && p1.driver === 'P9 Conductor' && p1.amount === 200 && p1.reference === 'TRF-998877' && p1.driver_balance === 22 && p1.driver_phone === D.user.phone);
const files = fs.readdirSync(UPLOADS).filter((f) => f.startsWith(`topup-${D.user.id}-`));
check('los comprobantes se guardan cifrados en el disco', files.length === 3 && files.every((f) => f.endsWith('.enc')) && !contains(fs.readFileSync(path.join(UPLOADS, files[0])), 'JFIF'));
const rcp = await fetch(`${API}/api/admin/topups/${t1.id}/receipt`, { headers: { Authorization: `Bearer ${ADM}` } });
const rbody = Buffer.from(await rcp.arrayBuffer());
check('el personal ve el comprobante (descifrado y sin datos ocultos)', rcp.status === 200 && rcp.headers.get('content-type') === 'image/jpeg' && rbody.equals(sanitizeJpeg(FIXTURE).buf));
check('soporte y quien no tiene sesión no ven comprobantes', (await fetch(`${API}/api/admin/topups/${t1.id}/receipt`, { headers: { Authorization: `Bearer ${SUP}` } })).status === 403 && (await fetch(`${API}/api/admin/topups/${t1.id}/receipt`)).status === 401);
check('el conductor no puede abrir comprobantes por el panel', (await fetch(`${API}/api/admin/topups/${t1.id}/receipt`, { headers: { Authorization: `Bearer ${D.token}` } })).status === 403);

check('soporte no puede aprobar', (await http('POST', `admin/topups/${t1.id}/approve`, SUP, {})).status === 403);
check('un monto absurdo se rechaza', (await http('POST', `admin/topups/${t1.id}/approve`, ADM, { amount: -5 })).status === 400);
// Dos personas pulsan Aprobar a la vez: solo una acredita
const both = await Promise.all([http('POST', `admin/topups/${t1.id}/approve`, ADM, { amount: 150 }), http('POST', `admin/topups/${t1.id}/approve`, SA, { amount: 150 })]);
const wins = both.filter((r) => r.ok);
check('aprobada a la vez por dos personas: se acredita una sola vez', wins.length === 1 && both.filter((r) => r.status === 409).length === 1);
check('se acredita el monto del comprobante (L 150), no el que escribió el conductor (L 200)', (await balanceOf(D.user.id)) === 172);
check('el libro de cuentas sigue cuadrando', (await ledgerSum(D.user.id)) === 172);
check('una recarga aprobada no se puede rechazar después', (await http('POST', `admin/topups/${t1.id}/reject`, ADM, { note: 'ya no' })).status === 409);
check('rechazar exige un motivo', (await http('POST', `admin/topups/${t2.id}/reject`, ADM, {})).status === 400);
check('se rechaza una recarga con motivo', (await http('POST', `admin/topups/${t2.id}/reject`, ADM, { note: 'El comprobante no se lee. Envíalo de nuevo.' })).ok === true);
check('rechazar no acredita nada', (await balanceOf(D.user.id)) === 172);
const after = await http('GET', 'driver/wallet', D.token);
check('el conductor ve el estado de cada recarga y el motivo del rechazo', after.topups.find((t) => t.id === t1.id).status === 'approved' && after.topups.find((t) => t.id === t1.id).approved_amount === 150 && after.topups.find((t) => t.id === t2.id).review_note.includes('no se lee'));
check('el conductor vuelve a poder ponerse disponible con el saldo nuevo', (await tryOnline(ds)) === null);
check('una recarga rechazada libera la referencia para volver a enviarla', (await topup(D.token, { amount: 300, bank: 'Ficohsa', reference: 'FIC-100200', image: variant(7) })).ok === true);

// ================= Ajustes manuales =================
check('solo el superadmin ajusta saldos', (await http('POST', `admin/wallet/${D.user.id}/adjust`, ADM, { amount: 25, note: 'bono por buen servicio' })).status === 403);
check('un ajuste exige explicar el motivo', (await http('POST', `admin/wallet/${D.user.id}/adjust`, SA, { amount: 25, note: 'ok' })).status === 400);
check('un ajuste de cero no tiene sentido', (await http('POST', `admin/wallet/${D.user.id}/adjust`, SA, { amount: 0, note: 'sin cambio real' })).status === 400);
check('no se ajusta el saldo de un pasajero', (await http('POST', `admin/wallet/${P.user.id}/adjust`, SA, { amount: 25, note: 'esto no debería pasar' })).status === 404);
const adj = await http('POST', `admin/wallet/${D.user.id}/adjust`, SA, { amount: -12.5, note: 'Corrección: comisión cobrada de más' });
check('el superadmin corrige el saldo con motivo (también restando)', adj.ok === true && adj.balance === 159.5);
check('el libro de cuentas sigue cuadrando con los centavos', (await ledgerSum(D.user.id)) === 159.5 && (await balanceOf(D.user.id)) === 159.5);

// ================= Ficha, registro, descarga y eliminación =================
const detail = await http('GET', `admin/users/${D.user.id}`, ADM);
check('la ficha del conductor muestra su saldo y movimientos al personal con permiso', detail.wallet.balance === 159.5 && detail.wallet.entries.length >= 5);
check('y no a soporte', (await http('GET', `admin/users/${D.user.id}`, SUP)).wallet === null);
const list = await http('GET', 'admin/users', ADM);
check('la lista de usuarios trae el saldo de cada conductor (solo con permiso)', list.users.find((u) => u.id === D.user.id).balance === 159.5 && (await http('GET', 'admin/users', SUP)).users.every((u) => !('balance' in u)));
const audit = await http('GET', 'admin/audit', SA);
const acts = new Set(audit.map((a) => a.action));
check('todo queda en el registro: ajustes, aprobaciones, rechazos y correcciones', ['settings.update', 'topup.approve', 'topup.reject', 'topup.view', 'wallet.adjust'].every((a) => acts.has(a)), `(${[...acts].filter((a) => /topup|wallet|settings/.test(a)).join(', ')})`);
check('el cambio de ajustes anota qué cambió', audit.some((a) => a.action === 'settings.update' && a.details?.changed?.includes('commission_enabled')));

const exp = await http('GET', 'me/export', D.token);
check('descargar mis datos incluye saldo, movimientos y recargas', exp.saldo === 159.5 && exp.movimientosDeSaldo.length >= 5 && exp.recargas.some((r) => r.referencia === 'TRF-998877' && r.estado === 'approved'));
const before = fs.readdirSync(UPLOADS).filter((f) => f.startsWith(`topup-${D.user.id}-`)).length;
check('al eliminar la cuenta se borran los comprobantes', before >= 3 && (await http('POST', 'me/delete', D.token, { password: 'Cielo-azul-77' })).ok === true && fs.readdirSync(UPLOADS).filter((f) => f.startsWith(`topup-${D.user.id}-`)).length === 0);
const [[kept]] = await pool.query("SELECT COUNT(*) AS n FROM wallet_entries WHERE user_id = ?", [D.user.id]);
const [[ref]] = await pool.query("SELECT COUNT(*) AS n FROM topups WHERE driver_id = ? AND reference <> '[eliminado]'", [D.user.id]);
check('los montos del libro se conservan (registro contable) pero las referencias se borran', kept.n >= 5 && ref.n === 0);

// Se deja la comisión apagada para que las demás pruebas (que no usan saldo) no se vean afectadas
await http('PUT', 'admin/settings', SA, { commission_enabled: false, welcome_credit: 0, min_balance: 0 });
ps.close(); ds.close(); d0s.close();
await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
