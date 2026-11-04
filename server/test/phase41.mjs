import 'dotenv/config';
// Referidos: «Invita y gana». El invitado se registra con el código; cuando viaja, quien lo invitó gana su premio
// (código de descuento si es pasajero, saldo si es conductor). Apagado hasta que el superadmin lo active.
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
let n = 0;
const passenger = async (name, referral) => {
  n += 1;
  const u = await registerUser({ name: `${name} C41`, phone: `8${n}${rnd}6`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger', referral });
  return u.token ? { ...u, s: track(await connect(u.token)) } : u;
};
const driver = async (name, referral) => {
  n += 1;
  const u = await registerUser({ name: `${name} C41`, phone: `9${n}${rnd}6`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HR${n}${rnd.slice(0, 4)}`, referral });
  await uploadDocs(u.token);
  await http('POST', `admin/users/${u.user.id}/status`, SA, { status: 'active' });
  return u;
};
const online = async (d) => {
  const s = track(await connect(d.token));
  s.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(500);
  return s;
};
// Un viaje completo de un pasajero con el conductor que está conectado
async function ride(p, ds, promoCode) {
  const rideNew = next(ds, 'ride:new');
  const ack = await emitAck(p.s, 'ride:request', { origin, dest, price: 100, ...(promoCode ? { promoCode } : {}) });
  if (!ack?.ok) throw new Error(`no se pudo pedir: ${ack?.error}`);
  const rn = await rideNew;
  const offer = next(p.s, 'offer:new');
  ds.emit('offer:make', { rideId: rn.id, price: 100 });
  const o = await offer;
  const accepted = next(p.s, 'ride:state', (r) => r.status === 'accepted');
  p.s.emit('offer:accept', { offerId: o.id });
  const r = await accepted;
  for (const st of ['arrived', 'started', 'completed']) {
    const moved = next(p.s, 'ride:state', (x) => x.status === st);
    ds.emit('ride:status', { rideId: r.id, status: st });
    await moved;
  }
  await wait(600); // comisión, descuento y premio se guardan sin esperar
  return r;
}
const refOf = async (userId) => (await pool.query('SELECT * FROM referrals WHERE referred_id = ?', [userId]))[0][0];

try {
  // ---------- Apagado ----------
  const A = await passenger('Ana Invita');
  check('apagado: «Invita y gana» dice que no está disponible', (await http('GET', 'referrals/me', A.token)).enabled === false);
  check('apagado: el menú no lo muestra', (await http('GET', 'me', A.token)).user?.referrals === false);
  const ignored = await passenger('Ignorado', 'CUALQUIERA1');
  check('apagado: un código de invitación al registrarse se ignora', !!ignored.token && !(await refOf(ignored.user.id)));
  check('el personal no tiene «Invita y gana»', (await http('GET', 'referrals/me', SA)).status === 403);

  // ---------- El superadmin lo enciende ----------
  await http('POST', 'admin/bank-accounts', SA, { bank: 'Banco 41', type: 'Ahorros', number: `41-${rnd}`, holder: 'Ktracho GO' });
  const on = await http('PUT', 'admin/settings', SA, {
    commission_enabled: true, commission_percent: 10, welcome_credit: 0, min_balance: -500,
    referral_enabled: true, referral_reward: 30, referral_welcome: 20, referral_driver_rides: 2, referral_monthly_max: 2,
  });
  check('el superadmin enciende los referidos con sus reglas', on.referral_enabled === '1' && on.referral_reward === '30' && on.referral_driver_rides === '2', JSON.stringify(on.error || ''));
  check('un premio fuera de rango no se guarda', (await http('PUT', 'admin/settings', SA, { referral_reward: 0 })).status === 400);
  await wait(200);

  const me = await http('GET', 'referrals/me', A.token);
  check('el pasajero tiene su código (con su nombre) y su enlace', /^ANA[A-Z0-9]{3}$/.test(me.code) && me.link?.endsWith(`?ref=${me.code}`) && me.driver === false, JSON.stringify({ code: me.code, link: me.link }));
  check('le dice las reglas: premio, bienvenida y viajes del conductor', me.reward === 30 && me.welcome === 20 && me.driverRides === 2);
  check('el código no cambia al volver a abrir', (await http('GET', 'referrals/me', A.token)).code === me.code);
  check('el menú ya lo muestra', (await http('GET', 'me', A.token)).user?.referrals === true);

  // ---------- Revisar el código y registrarse ----------
  check('un código que no existe', (await http('GET', 'referrals/check?code=NOEXISTE9', null)).status === 404);
  const chk = await http('GET', `referrals/check?code=${me.code.toLowerCase()}`, null);
  check('un código bueno dice quién invita (solo el primer nombre) y la bienvenida', chk.name === 'Ana' && chk.welcome === 20, JSON.stringify(chk));
  n += 1;
  const bad = await registerUser({ name: 'Malo C41', phone: `8${n}${rnd}6`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger', referral: 'NOEXISTE9' });
  check('registrarse con un código que no existe avisa (y no crea la cuenta)', bad.status === 400 && /invitación no existe/.test(bad.error));

  const B = await passenger('Beto Invitado', me.code.toLowerCase());
  const refB = await refOf(B.user.id);
  check('la invitación queda anotada y pendiente', refB?.referrer_id === A.user.id && refB.status === 'pending' && refB.referred_role === 'passenger');
  const minesB = await http('GET', 'promos/mine', B.token);
  const welcome = minesB.promos?.[0];
  check('el invitado recibe su código de bienvenida para el primer viaje', minesB.promos?.length === 1 && welcome.value === 20 && welcome.firstRideOnly && /Ana/.test(welcome.description), JSON.stringify(minesB));
  check('los códigos personales no salen en Promociones del panel', !(await http('GET', 'admin/promos', SA)).promos.some((p) => p.code === welcome.code));
  check('otro pasajero no puede usar ese código', /no existe/.test((await http('GET', `promos/check?code=${welcome.code}&price=100`, A.token)).error || ''));
  const inv = await http('GET', 'referrals/me', A.token);
  check('quien invitó ve a su invitado como pendiente', inv.invites?.length === 1 && inv.invites[0].name === 'Beto' && inv.invites[0].status === 'pending');

  // ---------- El invitado viaja: Ana gana su código ----------
  const D = await driver('Dani Conductor');
  let ds = await online(D);
  const rB = await ride(B, ds, welcome.code);
  check('el viaje del invitado usa su bienvenida (paga L 80)', Number((await pool.query('SELECT discount FROM rides WHERE id = ?', [rB.id]))[0][0].discount) === 20);
  const refB2 = await refOf(B.user.id);
  check('con su primer viaje, la invitación queda premiada', refB2.status === 'rewarded' && refB2.reward_kind === 'promo' && Number(refB2.reward_amount) === 30, JSON.stringify(refB2));
  const minesA = await http('GET', 'promos/mine', A.token);
  check('Ana recibe su código de descuento de L 30', minesA.promos?.length === 1 && minesA.promos[0].value === 30 && !minesA.promos[0].firstRideOnly && /Beto/.test(minesA.promos[0].description), JSON.stringify(minesA));
  check('a Beto ya no le aparece la bienvenida usada', (await http('GET', 'promos/mine', B.token)).promos.length === 0);
  const bell = await waitForBell(A.token, (x) => /Ganaste tu premio/.test(x.title));
  check('a Ana le llega el aviso del premio', bell.items?.some((x) => /Ganaste tu premio/.test(x.title) && /L 30 de descuento/.test(x.body)));
  const inv2 = await http('GET', 'referrals/me', A.token);
  check('en «Invita y gana» lo ve premiado y lo ganado', inv2.invites[0].status === 'rewarded' && inv2.earned === 30);
  await ride(B, ds);
  check('un segundo viaje del invitado no vuelve a premiar', (await http('GET', 'promos/mine', A.token)).promos.length === 1);
  // Ana usa su premio
  const rA = await ride(A, ds, minesA.promos[0].code);
  check('Ana usa su premio en un viaje', Number((await pool.query('SELECT discount FROM rides WHERE id = ?', [rA.id]))[0][0].discount) === 30);
  check('y es de un solo uso', /Ya usaste/.test((await http('GET', `promos/check?code=${minesA.promos[0].code}&price=100`, A.token)).error || ''));

  // ---------- Un conductor no gana premio llevando él mismo a su invitado ----------
  const dme = await http('GET', 'referrals/me', D.token);
  check('el conductor también tiene código, y su premio es saldo', !!dme.code && dme.driver === true);
  const G = await passenger('Gabi Amiga', dme.code);
  await ride(G, ds);
  check('si el conductor lleva a su propio invitado, no cuenta', (await refOf(G.user.id)).status === 'pending');

  // ---------- Conductor invita a conductor: saldo cuando termina sus primeros 2 viajes ----------
  const E = await driver('Eli Nuevo', dme.code);
  check('la invitación de un conductor queda pendiente (sin bienvenida)', (await refOf(E.user.id))?.referred_role === 'driver' && !(await refOf(E.user.id)).welcome_promo_id);
  ds.close();
  await wait(400);
  const es = await online(E);
  const C = await passenger('Caro Pasajera');
  const walletBefore = Number((await http('GET', 'driver/wallet', D.token)).balance);
  await ride(C, es);
  check('con 1 de 2 viajes todavía no hay premio', (await refOf(E.user.id)).status === 'pending');
  await ride(C, es);
  const refE = await refOf(E.user.id);
  check('con 2 viajes, la invitación queda premiada con saldo', refE.status === 'rewarded' && refE.reward_kind === 'wallet', JSON.stringify(refE));
  const wallet = await http('GET', 'driver/wallet', D.token);
  check('al conductor que invitó le ponen L 30 en su saldo', Number(wallet.balance) === walletBefore + 30, `${walletBefore} → ${wallet.balance}`);
  check('el movimiento dice por qué', wallet.entries?.some((x) => x.kind === 'referral' && Number(x.amount) === 30 && /invitar a Eli/.test(x.note)), JSON.stringify(wallet.entries?.slice(0, 3)));

  // ---------- Tope de premios por mes (2): Dani ya ganó 1; el 2.º sí, el 3.º no ----------
  const H = await passenger('Hugo Tercero', dme.code);
  const I = await passenger('Iris Cuarta', dme.code);
  await ride(H, es);
  await ride(I, es);
  check('el segundo premio del mes sí se paga', (await refOf(H.user.id)).status === 'rewarded');
  const refI = await refOf(I.user.id);
  check('pasado el tope del mes, la invitación queda rechazada con el motivo', refI.status === 'rejected' && /máximo de premios/.test(refI.reason), JSON.stringify(refI));

  // ---------- Panel ----------
  const adm = await http('GET', 'admin/referrals', SA);
  const ours = adm.referrals?.filter((r) => [A.user.id, D.user.id].includes(r.referrer_id));
  check('el panel lista las invitaciones con quién invitó a quién', ours?.length === 5 && ours.some((r) => r.referrer_name === 'Ana Invita C41' && r.referred_name === 'Beto Invitado C41'));
  check('el panel suma lo pagado en saldo y en descuentos', adm.totals.walletPaid >= 30 && adm.totals.discountsPaid >= 50 && adm.enabled === true, JSON.stringify(adm.totals));
  check('un pasajero no ve la lista del panel', (await http('GET', 'admin/referrals', A.token)).status === 403);

  // ---------- Al apagarlo ----------
  await http('PUT', 'admin/settings', SA, { referral_enabled: false });
  await wait(200);
  check('al apagarlo, «Invita y gana» deja de estar disponible', (await http('GET', 'referrals/me', A.token)).enabled === false);
  check('y la revisión del código también', (await http('GET', `referrals/check?code=${me.code}`, null)).enabled === false);
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
  await pool.query("UPDATE rides SET status = 'cancelled', cancelled_by = 'system' WHERE status IN ('requested','accepted','arrived','started') AND passenger_id IN (SELECT id FROM users WHERE name LIKE '% C41')");
  await http('PUT', 'admin/settings', SA, {
    commission_enabled: before.commission_enabled === '1', commission_percent: Number(before.commission_percent), welcome_credit: Number(before.welcome_credit), min_balance: Number(before.min_balance),
    referral_enabled: before.referral_enabled === '1', referral_reward: Number(before.referral_reward), referral_welcome: Number(before.referral_welcome),
    referral_driver_rides: Number(before.referral_driver_rides), referral_monthly_max: Number(before.referral_monthly_max),
  });
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
