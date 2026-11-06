import 'dotenv/config';
// Viajes entre ciudades (etapa 1): publicar, ofertas con tarifa y hora, reservar, soltar, recordatorios,
// paso a viaje normal antes de la salida, comisión propia y vencimientos.
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
const next = (s, ev, pred = () => true, ms = 8000) => new Promise((res, rej) => { const h = (d) => { if (pred(d)) { s.off(ev, h); res(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); rej(new Error(`no llegó ${ev}`)); }, ms); });
const sockets = [];
const tegus = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy, Tegucigalpa' };
const comayagua = { lat: 14.4514, lng: -87.6375, text: 'Comayagua, Comayagua' };
const kennedyNear = { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza' };
const inHours = (h) => new Date(Date.now() + h * 3600e3).toISOString();

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);

async function driver(name, n, category = 'car') {
  const D = await registerUser({ name, phone: `9${rnd}${n}`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `IC${rnd.slice(0, 3)}${n}` });
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  if (category !== 'car') await pool.query('UPDATE vehicles SET category = ? WHERE driver_id = ?', [category, D.user.id]);
  return D;
}

try {
  const P = await registerUser({ name: 'Marta Lagos', phone: `8${rnd}71`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const D1 = await driver('Óscar Ruta', '72');
  const D2 = await driver('Nelson Carretera', '73');
  const DX = await driver('Wendy Amplio', '74', 'xl');

  // ---------- Apagado ----------
  await http('PUT', 'admin/settings', SA, { intercity_enabled: false });
  const off = await http('POST', 'intercity/quote', P.token, { origin: tegus, dest: comayagua });
  check('apagado, no se puede cotizar', off.status === 409, JSON.stringify(off));
  check('y la app sabe que está apagado', (await http('GET', 'intercity/info', P.token)).enabled === false);

  // ---------- Ajustes ----------
  await http('POST', 'admin/bank-accounts', SA, { bank: 'Banco 45', type: 'Ahorros', number: `45-${rnd}`, holder: 'Ktracho GO' }); // la comisión exige una cuenta para recargar
  const bad = await http('PUT', 'admin/settings', SA, { intercity_km: 500 });
  check('el precio por km se valida', /entre ciudades/.test(bad.error || ''), JSON.stringify(bad));
  const set = await http('PUT', 'admin/settings', SA, { intercity_enabled: true, intercity_base: 100, intercity_km: 7, intercity_minimum: 250, intercity_commission_percent: 15, commission_enabled: true, commission_percent: 10, min_balance: -500 });
  check('el superadmin enciende los viajes entre ciudades y pone su comisión', set.intercity_enabled === '1' && set.intercity_commission_percent === '15', JSON.stringify(set.error || ''));

  // ---------- Pasajero: cotizar y publicar ----------
  const near = await http('POST', 'intercity/quote', P.token, { origin: tegus, dest: kennedyNear });
  check('un viaje corto se manda a «En la ciudad»', /En la ciudad/.test(near.error || ''), near.error);
  const q = await http('POST', 'intercity/quote', P.token, { origin: tegus, dest: comayagua });
  check('cotiza con km y precio sugerido (base + por km, mínimo)', q.distanceKm > 50 && q.price === Math.max(250, Math.round((100 + q.distanceKm * 7) / 5) * 5), JSON.stringify({ km: q.distanceKm, price: q.price }));
  const early = await http('POST', 'intercity', P.token, { origin: tegus, dest: comayagua, departAt: inHours(0.2), seats: 2 });
  check('la salida debe ser al menos en 30 minutos', /30 minutos/.test(early.error || ''), early.error);
  const pub = await http('POST', 'intercity', P.token, { origin: tegus, dest: comayagua, departAt: inHours(20), seats: 2, luggage: true, price: 900, note: 'Frente a la gasolinera' });
  check('publica su viaje (2 personas, maletas, L 900)', pub.ok && pub.id > 0, JSON.stringify(pub));
  const big = await http('POST', 'intercity', P.token, { origin: tegus, dest: comayagua, departAt: inHours(30), seats: 5 });
  const mine0 = await http('GET', 'intercity/mine', P.token);
  check('«Mis viajes entre ciudades» los muestra publicados', mine0.trips?.length === 2 && mine0.trips.every((t) => t.status === 'board') && mine0.trips[0].luggage === true, JSON.stringify(mine0.trips?.map((t) => t.status)));
  const [[row]] = await pool.query('SELECT kind, status, seats, luggage, category FROM rides WHERE id = ?', [pub.id]);
  check('en la base: tipo intercity, publicado, asientos y maletas', row.kind === 'intercity' && row.status === 'board' && row.seats === 2 && row.luggage === 1 && row.category === 'car', JSON.stringify(row));
  const [[bigRow]] = await pool.query('SELECT category FROM rides WHERE id = ?', [big.id]);
  check('con 5 personas pide carro amplio', bigRow.category === 'xl');

  // ---------- Conductores: el tablero ----------
  const b1 = await http('GET', `intercity/board?lat=${tegus.lat}&lng=${tegus.lng}`, D1.token);
  const t1 = b1.trips?.find((t) => t.id === pub.id);
  check('el conductor ve el viaje en el tablero', !!t1 && t1.passenger.name === 'Marta' && t1.awayKm === 0 && t1.seats === 2, JSON.stringify(t1));
  check('un carro normal no ve el viaje de 5 personas', !b1.trips.some((t) => t.id === big.id));
  check('el carro amplio sí lo ve', (await http('GET', 'intercity/board', DX.token)).trips?.some((t) => t.id === big.id));

  // ---------- Ofertas ----------
  const o1 = await http('POST', `intercity/${pub.id}/offer`, D1.token, {});
  check('el conductor 1 acepta la tarifa', o1.ok, JSON.stringify(o1));
  const o2 = await http('POST', `intercity/${pub.id}/offer`, D2.token, { price: 800, departAt: inHours(21) });
  check('el conductor 2 ofrece otra tarifa y otra hora', o2.ok, JSON.stringify(o2));
  const o2b = await http('POST', `intercity/${pub.id}/offer`, D2.token, { price: 820, departAt: inHours(21) });
  const mine1 = await http('GET', 'intercity/mine', P.token);
  const offers = mine1.trips.find((t) => t.id === pub.id).offers;
  check('el pasajero ve las 2 ofertas, la más barata primero, sin repetir', o2b.ok && offers.length === 2 && offers[0].price === 820 && offers[1].price === 900 && offers[0].driver.name === 'Nelson Carretera', JSON.stringify(offers.map((o) => o.price)));
  check('la oferta que acepta la tarifa sale a la hora pedida', Math.abs(new Date(offers[1].departAt) - new Date(mine1.trips.find((t) => t.id === pub.id).departAt)) < 5000);
  check('el tablero recuerda la oferta del conductor', (await http('GET', 'intercity/board', D2.token)).trips.find((t) => t.id === pub.id)?.myOffer?.price === 820);

  // ---------- Reservar ----------
  const ps = await connect(P.token);
  sockets.push(ps);
  const upd = next(ps, 'intercity:update');
  const acc = await http('POST', `intercity/${pub.id}/accept`, P.token, { offerId: offers[0].id });
  check('el pasajero elige la oferta del conductor 2', acc.ok, JSON.stringify(acc));
  check('y su app se actualiza sola', await upd.then(() => true, () => false));
  const [[booked]] = await pool.query('SELECT status, driver_id, final_price FROM rides WHERE id = ?', [pub.id]);
  check('queda reservado con ese conductor y ese precio', booked.status === 'booked' && booked.driver_id === D2.user.id && Number(booked.final_price) === 820, JSON.stringify(booked));
  check('el conductor 2 lo ve en sus reservas', (await http('GET', 'intercity/booked', D2.token)).trips?.[0]?.id === pub.id);
  check('ya no está en el tablero', !(await http('GET', 'intercity/board', D1.token)).trips.some((t) => t.id === pub.id));
  const again = await http('POST', `intercity/${pub.id}/accept`, P.token, { offerId: offers[1].id });
  check('no se puede reservar dos veces', again.status === 409);
  const [[o1row]] = await pool.query("SELECT status FROM offers WHERE ride_id = ? AND driver_id = ?", [pub.id, D1.user.id]);
  check('la otra oferta queda rechazada', o1row.status === 'rejected');

  // Un conductor no puede tener dos viajes con salidas muy cercanas
  const pub2 = await http('POST', 'intercity', P.token, { origin: comayagua, dest: tegus, departAt: inHours(22), seats: 1 });
  const clash = await http('POST', `intercity/${pub2.id}/offer`, D2.token, {});
  check('no puede ofrecer otro viaje a menos de 3 horas de su reserva', clash.status === 409 && /3 horas/.test(clash.error || ''), JSON.stringify(clash));
  const tooMany = await http('POST', 'intercity', P.token, { origin: tegus, dest: comayagua, departAt: inHours(40) });
  check('máximo 3 viajes publicados o reservados', tooMany.status === 409, JSON.stringify(tooMany));
  await http('POST', `intercity/${big.id}/cancel`, P.token);
  check('el pasajero cancela un viaje publicado', (await pool.query('SELECT status FROM rides WHERE id = ?', [big.id]))[0][0].status === 'cancelled');
  const block = await http('POST', 'me/mode', D2.token, { mode: 'passenger' });
  check('con un viaje reservado el conductor no cambia de modo', /entre ciudades/.test(block.error || ''), JSON.stringify(block));

  // ---------- El conductor suelta el viaje ----------
  const rel = await http('POST', `intercity/${pub.id}/release`, D2.token);
  const [[back]] = await pool.query('SELECT status, driver_id FROM rides WHERE id = ?', [pub.id]);
  check('si el conductor ya no puede, el viaje vuelve a publicarse', rel.ok && back.status === 'board' && back.driver_id === null, JSON.stringify(back));

  // ---------- Recordatorio, paso a viaje normal y comisión ----------
  await http('POST', `intercity/${pub.id}/offer`, D1.token, { price: 1000 });
  const offer1 = (await http('GET', 'intercity/mine', P.token)).trips.find((t) => t.id === pub.id).offers.find((o) => o.driver.id === D1.user.id);
  await http('POST', `intercity/${pub.id}/accept`, P.token, { offerId: offer1.id });
  // Se adelanta la salida: en 50 minutos (sale el aviso de 1 hora)
  await pool.query('UPDATE rides SET scheduled_for = NOW() + INTERVAL 50 MINUTE WHERE id = ?', [pub.id]);
  await wait(2500);
  const [[rem]] = await pool.query('SELECT reminded, status FROM rides WHERE id = ?', [pub.id]);
  check('una hora antes se avisa a los dos (y sigue reservado)', (rem.reminded & 2) === 2 && rem.status === 'booked', JSON.stringify(rem));
  const [bell] = await pool.query("SELECT title FROM notifications WHERE user_id = ? AND title LIKE 'Tu viaje sale en 1 hora%'", [P.user.id]);
  check('el aviso queda en la campanita del pasajero', bell.length === 1);
  const ds = await connect(D1.token);
  sockets.push(ds);
  const activated = next(ps, 'ride:state', (r) => r.id === pub.id && r.status === 'accepted');
  await pool.query('UPDATE rides SET scheduled_for = NOW() + INTERVAL 20 MINUTE WHERE id = ?', [pub.id]);
  const st = await activated.catch(() => null);
  check('30 minutos antes pasa a ser un viaje normal (conductor en camino)', st?.status === 'accepted' && st.driver?.id === D1.user.id && st.kind === 'intercity', JSON.stringify(st?.status));
  for (const s of ['arrived', 'started', 'completed']) {
    const moved = next(ps, 'ride:state', (x) => x.id === pub.id && x.status === s);
    ds.emit('ride:status', { rideId: pub.id, status: s });
    await moved;
  }
  await wait(800);
  const [[fee]] = await pool.query("SELECT amount, note FROM wallet_entries WHERE ride_id = ? AND kind = 'commission'", [pub.id]);
  check('al terminar se cobra la comisión entre ciudades (15 % de L 1000)', Number(fee?.amount) === -150 && /15%/.test(fee?.note || ''), JSON.stringify(fee));

  // ---------- Vencimientos ----------
  const asap = await http('POST', 'intercity', P.token, { origin: tegus, dest: comayagua, seats: 1 });
  check('se puede publicar «lo antes posible»', asap.ok && (await http('GET', 'intercity/mine', P.token)).trips.some((t) => t.id === asap.id && t.asap));
  await pool.query('UPDATE rides SET created_at = NOW() - INTERVAL 4 HOUR WHERE id = ?', [asap.id]);
  await pool.query('UPDATE rides SET scheduled_for = NOW() - INTERVAL 1 MINUTE WHERE id = ?', [pub2.id]);
  await wait(2500);
  const [late] = await pool.query('SELECT id, status, cancelled_by FROM rides WHERE id IN (?)', [[asap.id, pub2.id]]);
  check('los que nadie tomó a tiempo se cancelan solos', late.every((r) => r.status === 'cancelled' && r.cancelled_by === 'system'), JSON.stringify(late));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
  await http('PUT', 'admin/settings', SA, {
    intercity_enabled: before.intercity_enabled === '1', intercity_commission_percent: Number(before.intercity_commission_percent),
    commission_enabled: before.commission_enabled === '1', commission_percent: Number(before.commission_percent), min_balance: Number(before.min_balance),
  });
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
