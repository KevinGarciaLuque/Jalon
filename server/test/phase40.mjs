import 'dotenv/config';
// Códigos promocionales: el personal los crea, el pasajero paga menos en efectivo y Ktracho GO le pone la diferencia al conductor
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin, waitForBell } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
const next = (s, ev, pred = () => true, ms = 6000) => new Promise((res, rej) => { const h = (d) => { if (pred(d)) { s.off(ev, h); res(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); rej(new Error(`no llegó ${ev}`)); }, ms); });
const emitAck = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza' };
const sockets = [];
const track = (s) => { sockets.push(s); return s; };

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);
const FIX = `F40${rnd}`;
const PCT = `P40${rnd}`;
const ONE = `U40${rnd}`;
const pass = async (n) => {
  const u = await registerUser({ name: `C40 Pasajero ${n}`, phone: `8${n}${rnd}4`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  return { ...u, s: track(await connect(u.token)) };
};

try {
  // ---------- El personal crea los códigos ----------
  check('con porcentaje hay que poner un tope en lempiras', (await http('POST', 'admin/promos', SA, { code: PCT, kind: 'percent', value: 20 })).status === 400);
  check('un código muy corto no sirve', (await http('POST', 'admin/promos', SA, { code: 'A1', kind: 'fixed', value: 30 })).status === 400);
  const fix = await http('POST', 'admin/promos', SA, { code: FIX.toLowerCase(), description: 'L 30 menos', kind: 'fixed', value: 30, max_uses: 3 });
  check('crea un código de monto fijo (se guarda en mayúsculas)', !!fix.id);
  check('no se repite un código', (await http('POST', 'admin/promos', SA, { code: FIX, kind: 'fixed', value: 10 })).status === 409);
  const pct = await http('POST', 'admin/promos', SA, { code: PCT, kind: 'percent', value: 20, max_discount: 15, first_ride_only: true });
  const one = await http('POST', 'admin/promos', SA, { code: ONE, kind: 'fixed', value: 20, max_uses: 1 });
  check('crea uno de porcentaje para el primer viaje y uno de un solo uso', !!pct.id && !!one.id);

  const A = await pass(1);
  check('un pasajero no ve la lista de códigos', (await http('GET', 'admin/promos', A.token)).status === 403);
  const off = await http('GET', `promos/check?code=${FIX}&price=100`, A.token);
  check('con la comisión apagada los códigos no se pueden usar', off.status === 409 && /no están disponibles/.test(off.error));
  check('el panel avisa que la comisión está apagada', (await http('GET', 'admin/promos', SA)).commissionEnabled === false);

  // La comisión necesita una cuenta bancaria activa
  await http('POST', 'admin/bank-accounts', SA, { bank: 'Banco 40', type: 'Ahorros', number: `40-${rnd}`, holder: 'Ktracho GO' });
  const on = await http('PUT', 'admin/settings', SA, { commission_enabled: true, commission_percent: 10, welcome_credit: 0, min_balance: -500 });
  check('se activa la comisión', on.commission_enabled === '1', JSON.stringify(on.error || ''));
  await wait(200);

  // ---------- El pasajero prueba un código ----------
  check('un código que no existe', /no existe/.test((await http('GET', 'promos/check?code=NOEXISTE40&price=100', A.token)).error || ''));
  const ok = await http('GET', `promos/check?code=${FIX.toLowerCase()}&price=100`, A.token);
  check('un código bueno dice cuánto descuenta', ok.discount === 30 && ok.toPay === 70 && ok.promo?.code === FIX, JSON.stringify(ok));
  check('un conductor no prueba códigos', (await http('GET', `promos/check?code=${FIX}&price=100`, SA)).status === 403);

  // ---------- Un viaje con código ----------
  const D = await registerUser({ name: 'C40 Conductor', phone: `94${rnd}0`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HP4${rnd.slice(0, 4)}` });
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  const ds = track(await connect(D.token));
  ds.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(600);

  const requested = next(A.s, 'ride:state', (r) => r.status === 'requested');
  const rideNew = next(ds, 'ride:new');
  const ack = await emitAck(A.s, 'ride:request', { origin, dest, price: 100, promoCode: FIX });
  const rq = await requested;
  check('pide el viaje con el código', ack?.ok && rq.promo?.code === FIX && rq.discount === 30 && rq.toPay === 70, JSON.stringify(ack));
  const rn = await rideNew;
  // El conductor ofrece más: el descuento sigue siendo L 30
  const offer = next(A.s, 'offer:new');
  ds.emit('offer:make', { rideId: rn.id, price: 120 });
  const o = await offer;
  const accP = next(A.s, 'ride:state', (r) => r.status === 'accepted');
  const accD = next(ds, 'ride:state', (r) => r.status === 'accepted');
  A.s.emit('offer:accept', { offerId: o.id });
  const [ap, ad] = await Promise.all([accP, accD]);
  check('al aceptar, el pasajero paga el precio menos el descuento', ap.final_price === 120 && ap.discount === 30 && ap.toPay === 90, JSON.stringify({ f: ap.final_price, d: ap.discount, t: ap.toPay }));
  check('el conductor ve cuánto cobra en efectivo', ad.toPay === 90 && ad.discount === 30);
  const [[stored]] = await pool.query('SELECT promo_id, discount FROM rides WHERE id = ?', [ap.id]);
  check('el descuento queda guardado en el viaje', stored.promo_id === fix.id && Number(stored.discount) === 30);
  for (const st of ['arrived', 'started']) {
    const moved = next(ds, 'ride:state', (r) => r.status === st);
    ds.emit('ride:status', { rideId: ap.id, status: st });
    await moved;
  }
  const done = next(A.s, 'ride:state', (r) => r.status === 'completed');
  ds.emit('ride:status', { rideId: ap.id, status: 'completed' });
  const fin = await done;
  check('al terminar, el total a pagar es con el descuento', fin.toPay === 90);
  await wait(500);
  const [entries] = await pool.query('SELECT kind, amount, note FROM wallet_entries WHERE user_id = ? AND ride_id = ? ORDER BY id', [D.user.id, ap.id]);
  const promoEntry = entries.find((e) => e.kind === 'promo');
  check('Ktracho GO le pone al conductor el descuento en su saldo', Number(promoEntry?.amount) === 30 && promoEntry.note.includes(FIX), JSON.stringify(entries));
  check('la comisión se cobra sobre el precio completo', Number(entries.find((e) => e.kind === 'commission')?.amount) === -12);
  const wallet = await http('GET', 'driver/wallet', D.token);
  check('el saldo del conductor queda en +18 (30 del código − 12 de comisión)', Number(wallet.balance) === 18, JSON.stringify(wallet.balance));
  const bell = await waitForBell(A.token, (n) => n.title === 'Llegaste a tu destino');
  check('el aviso de llegada dice el total con descuento', bell.items?.some((n) => n.title === 'Llegaste a tu destino' && /L 90\b/.test(n.body)));
  const receipt = await http('GET', `rides/${ap.id}/receipt`, A.token);
  check('el recibo muestra precio, descuento y lo pagado', receipt.price === 120 && receipt.discount === 30 && receipt.paid === 90 && receipt.promoCode === FIX);
  const hist = await http('GET', 'rides/mine', A.token);
  check('en el historial del pasajero, lo gastado es lo que pagó', hist.month?.total === 90 && Number(hist.rides?.[0]?.discount) === 30);
  check('en el del conductor, lo cobrado es el precio completo', (await http('GET', 'rides/mine', D.token)).month?.total === 120);

  // ---------- Reglas ----------
  check('el mismo pasajero no lo usa dos veces', /Ya usaste/.test((await emitAck(A.s, 'ride:request', { origin, dest, price: 100, promoCode: FIX })).error || ''));
  check('«solo primer viaje» no sirve a quien ya viajó', /primer viaje/.test((await http('GET', `promos/check?code=${PCT}&price=100`, A.token)).error || ''));
  const B = await pass(2);
  const pb = await http('GET', `promos/check?code=${PCT}&price=100`, B.token);
  check('a un pasajero nuevo el 20% de L 100 le llega hasta el tope de L 15', pb.discount === 15 && pb.toPay === 85, JSON.stringify(pb));

  // Un solo uso: el que pide primero se lo lleva; si cancela, se devuelve
  const C = await pass(3);
  const [b1, c1] = await Promise.all([
    emitAck(B.s, 'ride:request', { origin, dest, price: 100, promoCode: ONE }),
    emitAck(C.s, 'ride:request', { origin, dest, price: 100, promoCode: ONE }),
  ]);
  check('dos pasajeros a la vez por el último uso: solo uno lo consigue', [b1, c1].filter((r) => r?.ok).length === 1 && [b1, c1].some((r) => /se terminó/.test(r?.error || '') && r.promo === true), JSON.stringify([b1, c1]));
  const [winner, loser] = b1?.ok ? [B, C] : [C, B];
  const cancelled = next(winner.s, 'ride:state', (r) => r.status === 'cancelled');
  const [[wr]] = await pool.query("SELECT id FROM rides WHERE passenger_id = ? AND status = 'requested'", [winner.user.id]);
  winner.s.emit('ride:cancel', { rideId: wr.id });
  await cancelled;
  check('si cancela, el uso se devuelve y otro lo puede usar', (await emitAck(loser.s, 'ride:request', { origin, dest, price: 100, promoCode: ONE }))?.ok === true);

  // Apagado, vencido, y no se cambia el descuento de un código ya usado
  await http('PUT', `admin/promos/${pct.id}`, SA, { active: false });
  check('un código apagado ya no sirve', /no existe o ya no está activo/.test((await http('GET', `promos/check?code=${PCT}&price=100`, B.token)).error || ''));
  await pool.query('UPDATE promo_codes SET active = 1, expires_at = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [pct.id]);
  check('un código vencido ya no sirve', /venció/.test((await http('GET', `promos/check?code=${PCT}&price=100`, B.token)).error || ''));
  check('a un código ya usado no se le cambia el descuento', (await http('PUT', `admin/promos/${fix.id}`, SA, { value: 50 })).status === 409);
  check('pero sí se puede apagar o cambiar su vencimiento', (await http('PUT', `admin/promos/${fix.id}`, SA, { active: false, expires_at: '2027-01-31T23:59:00Z' })).ok === true);
  const list = (await http('GET', 'admin/promos', SA)).promos.find((p) => p.id === fix.id);
  check('la lista dice cuántas veces se usó y cuánto puso Ktracho GO', list.used === 1 && list.total_discount === 30 && list.active === 0, JSON.stringify(list));
  check('el Registro anota quién creó el código', (await http('GET', 'admin/audit', SA)).some((a) => a.action === 'promo.create' && a.details?.code === FIX));
  check('un viaje sin código sigue igual', (await emitAck(B.s, 'ride:request', { origin, dest, price: 80 }))?.ok === true);
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
  await pool.query("UPDATE rides SET status = 'cancelled', cancelled_by = 'system' WHERE status IN ('requested','accepted','arrived','started') AND passenger_id IN (SELECT id FROM users WHERE name LIKE 'C40 %')");
  await http('PUT', 'admin/settings', SA, { commission_enabled: before.commission_enabled === '1', commission_percent: Number(before.commission_percent), welcome_credit: Number(before.welcome_credit), min_balance: Number(before.min_balance) });
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
