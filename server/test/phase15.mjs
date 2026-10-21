import 'dotenv/config';
// Etapa 4B: alquiler de carros por días con conductor (carros de conductores y de la flota), pago en efectivo o por transferencia
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, FIXTURE, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const until = (s, ev, pred = () => true, ms = 4000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout esperando ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const todayHN = () => new Date(Date.now() - 6 * 3600e3).toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const today = todayHN();
// Comprobante distinto a los de las otras pruebas (otro byte dentro de los datos de la imagen)
const receipt = (() => { const b = Buffer.from(FIXTURE); const i = b.length - 30; b[i] = (b[i] + 77) % 200; return `data:image/jpeg;base64,${b.toString('base64')}`; })();

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);
const rolesBefore = (await http('GET', 'admin/permissions', SA)).roles;
const keep = Object.fromEntries(['rental_enabled', 'commission_enabled', 'commission_percent', 'bank_name', 'bank_account', 'bank_holder', 'bank_account_type', 'rental_max_days'].map((k) => [k, before[k]]));
let ds;

try {
  const D = await registerUser({ name: 'E1 Conductor', phone: `97${rnd}5`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', category: 'car', make: 'Toyota', model: 'Corolla', color: 'Gris', year: 2020, plate: `R${rnd}` });
  await uploadDocs(D.token);
  await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [D.user.id]);
  const P = await registerUser({ name: 'E1 Pasajero', phone: `87${rnd}5`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const P2 = await registerUser({ name: 'E1 Pasajero', phone: `86${rnd}5`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });

  // Sin el permiso, ni el pasajero ni el conductor ven el alquiler (al principio solo lo ve el superadmin)
  check('sin permiso, el pasajero no puede buscar carros', (await http('GET', `rentals/search?start=${today}&days=1`, P.token)).status === 403);
  check('sin permiso, el conductor no puede ofrecer su carro', (await http('GET', 'driver/rental', D.token)).status === 403);
  await http('PUT', 'admin/permissions/passenger', SA, { perms: ['rent'] });
  await http('PUT', 'admin/permissions/driver', SA, { perms: ['rent.offer'] });

  // Apagado: no se ofrece
  await http('PUT', 'admin/settings', SA, { rental_enabled: false });
  check('apagado, el conductor no puede ofrecer su carro', (await http('PUT', 'driver/rental', D.token, { price: 800 })).status === 409);
  const off = await http('GET', `rentals/search?start=${addDays(today, 1)}&days=2`, P.token);
  check('apagado, el pasajero no ve carros', off.enabled === false && off.results.length === 0);

  // Encendido, con comisión del 10% y cuenta para transferencias
  const on = await http('PUT', 'admin/settings', SA, { rental_enabled: true, commission_enabled: true, commission_percent: 10, bank_name: 'BAC', bank_account: '123456', bank_holder: 'Ktracho GO', rental_max_days: 7 });
  check('el superadmin activa el alquiler', on.rental_enabled === '1', on.error || '');
  check('el precio por día debe estar en el rango', (await http('PUT', 'driver/rental', D.token, { price: 50 })).status === 400);
  check('el conductor ofrece su carro a L 800 por día', (await http('PUT', 'driver/rental', D.token, { price: 800 })).ok === true);

  // Búsqueda
  const found = await http('GET', `rentals/search?start=${addDays(today, 1)}&days=2`, P.token);
  const mine = found.results?.find((r) => r.driverName === 'E1');
  check('el pasajero encuentra el carro libre con su total', mine?.priceDay === 800 && mine.total === 1600 && mine.vehicle.model === 'Corolla', JSON.stringify(mine));
  check('no deja alquilar más días de los permitidos', (await http('GET', `rentals/search?start=${addDays(today, 1)}&days=9`, P.token)).status === 400);
  check('no deja reservar en el pasado', (await http('GET', `rentals/search?start=${addDays(today, -1)}&days=1`, P.token)).status === 400);
  check('un conductor no usa la pantalla de alquilar', (await http('GET', `rentals/search?start=${today}&days=1`, D.token)).status === 403);

  // Dos personas piden las mismas fechas a la vez: solo una se lo lleva
  const req = (tok) => http('POST', 'rentals', tok, { listingId: mine.listingId, start: addDays(today, 1), days: 2, payment: 'cash', pickup: 'Colonia Kennedy' });
  const [a, b] = await Promise.all([req(P.token), req(P2.token)]);
  check('dos reservas a la vez de las mismas fechas: solo una queda', [a, b].filter((x) => x.ok).length === 1 && [a, b].some((x) => x.status === 409), `${a.status}/${b.status}`);
  const first = (a.ok ? a : b).booking;
  const firstToken = a.ok ? P.token : P2.token;
  check('la reserva queda pedida, con su total', first.status === 'requested' && first.total === 1600 && first.days === 2);
  check('mientras no confirma, el pasajero no ve el teléfono del conductor', first.driver_phone === null);
  const hidden = await http('GET', `rentals/search?start=${addDays(today, 2)}&days=1`, P.token);
  check('ese carro ya no aparece en esas fechas', !hidden.results.some((r) => r.listingId === mine.listingId));

  // El conductor confirma
  const conf = await http('POST', `driver/rentals/${first.id}/decide`, D.token, { accept: true });
  check('el conductor confirma', conf.booking?.status === 'confirmed', conf.error || '');
  const mineList = await http('GET', 'rentals/mine', firstToken);
  check('confirmada, el pasajero ve el teléfono y la placa', mineList.bookings[0]?.driver_phone === D.user.phone && mineList.bookings[0]?.vehicle.plate === `R${rnd}`);
  check('no se puede iniciar antes de la fecha', (await http('POST', `driver/rentals/${first.id}/start`, D.token)).status === 409);
  check('el pasajero cancela antes de que empiece', (await http('POST', `rentals/${first.id}/cancel`, firstToken)).booking?.status === 'cancelled');

  // Por transferencia, para hoy: no empieza hasta que el equipo aprueba el comprobante
  const t = await http('POST', 'rentals', P2.token, { listingId: mine.listingId, start: today, days: 1, payment: 'transfer' });
  check('reserva para hoy pagando por transferencia', t.booking?.payment === 'transfer', t.error || '');
  await http('POST', `driver/rentals/${t.booking.id}/decide`, D.token, { accept: true });
  check('sin el pago aprobado no se puede iniciar', (await http('POST', `driver/rentals/${t.booking.id}/start`, D.token)).status === 409);
  check('el comprobante pide banco y referencia', (await http('POST', `rentals/${t.booking.id}/receipt`, P2.token, { image: receipt })).status === 400);
  const up = await http('POST', `rentals/${t.booking.id}/receipt`, P2.token, { bank: 'BAC', reference: `ALQ-${rnd}`, image: receipt });
  check('el pasajero sube el comprobante', up.ok === true, up.error || '');
  const pend = await http('GET', 'admin/rentals?payment=pending', SA);
  check('el personal ve el pago por revisar', pend.some((x) => x.id === t.booking.id));
  const img = await fetch(`${API}/api/admin/rentals/${t.booking.id}/receipt`, { headers: { Authorization: `Bearer ${SA}` } });
  check('el personal abre el comprobante', img.status === 200 && img.headers.get('content-type')?.startsWith('image/jpeg'));
  check('aprueba el pago', (await http('POST', `admin/rentals/${t.booking.id}/payment`, SA, { approve: true })).ok === true);
  check('el pago no se aprueba dos veces', (await http('POST', `admin/rentals/${t.booking.id}/payment`, SA, { approve: true })).status === 409);
  const started = await http('POST', `driver/rentals/${t.booking.id}/start`, D.token);
  check('ya pagado, el conductor lo inicia', started.booking?.status === 'active', started.error || '');

  // Mientras dura, el conductor no recibe viajes
  ds = io(API, { auth: { token: D.token }, forceNew: true });
  await until(ds, 'connect');
  const denied = until(ds, 'driver:denied');
  ds.emit('driver:online', { lat: 14.073, lng: -87.1925 });
  check('con el alquiler en curso no puede ponerse disponible', (await denied.catch(() => ({}))).status === 'rental');

  const [[w0]] = await pool.query('SELECT balance FROM users WHERE id = ?', [D.user.id]);
  check('el conductor termina el alquiler', (await http('POST', `driver/rentals/${t.booking.id}/finish`, D.token)).booking?.status === 'completed');
  const [[w1]] = await pool.query('SELECT balance FROM users WHERE id = ?', [D.user.id]);
  check('por transferencia se le acredita el total menos la comisión (800 − 80)', Number(w1.balance) - Number(w0.balance) === 720, `(${w0.balance} → ${w1.balance})`);

  // En efectivo: se le descuenta la comisión del saldo
  const c = await http('POST', 'rentals', P.token, { listingId: mine.listingId, start: today, days: 1, payment: 'cash' });
  await http('POST', `driver/rentals/${c.booking.id}/decide`, D.token, { accept: true });
  check('el pasajero no puede cancelar el mismo día ya confirmado', (await http('POST', `rentals/${c.booking.id}/cancel`, P.token)).status === 409);
  await http('POST', `driver/rentals/${c.booking.id}/start`, D.token);
  await http('POST', `driver/rentals/${c.booking.id}/finish`, D.token);
  const [[w2]] = await pool.query('SELECT balance FROM users WHERE id = ?', [D.user.id]);
  check('en efectivo se le descuenta la comisión (80)', Number(w1.balance) - Number(w2.balance) === 80, `(${w1.balance} → ${w2.balance})`);
  const [[ledger]] = await pool.query('SELECT COALESCE(SUM(amount),0) AS s FROM wallet_entries WHERE user_id = ?', [D.user.id]);
  check('el saldo cuadra con el libro de cuentas', Number(ledger.s) === Number(w2.balance));

  // Rechazo
  const r = await http('POST', 'rentals', P.token, { listingId: mine.listingId, start: addDays(today, 5), days: 1, payment: 'cash' });
  check('el conductor rechaza una solicitud', (await http('POST', `driver/rentals/${r.booking.id}/decide`, D.token, { accept: false, note: 'Ese día no puedo' })).booking?.status === 'rejected');
  check('el personal no responde por el carro de un conductor', (await http('POST', `admin/rentals/${r.booking.id}/decide`, SA, { accept: true })).status === 409);

  // Flota de Ktracho GO
  const fleet = await http('POST', 'admin/fleet', SA, { category: 'xl', make: 'Toyota', model: 'Hiace', color: 'Blanca', year: 2021, plate: `F${rnd}`, price: 1500 });
  check('el superadmin agrega un carro de la flota', fleet.ok === true, fleet.error || '');
  const ff = await http('GET', `rentals/search?start=${addDays(today, 3)}&days=1`, P.token);
  const fl = ff.results.find((x) => x.owner === 'fleet' && x.vehicle.model === 'Hiace');
  check('el pasajero ve el carro de la flota', fl?.priceDay === 1500 && fl.vehicle.categoryLabel === 'Carro amplio');
  const fb = await http('POST', 'rentals', P.token, { listingId: fl.listingId, start: addDays(today, 3), days: 1, payment: 'cash' });
  check('para confirmar la flota hay que indicar quién maneja', (await http('POST', `admin/rentals/${fb.booking.id}/decide`, SA, { accept: true })).status === 400);
  const fc = await http('POST', `admin/rentals/${fb.booking.id}/decide`, SA, { accept: true, assignedDriver: 'Juan Pérez 9999-0000' });
  check('el personal confirma con el conductor asignado', fc.booking?.status === 'confirmed' && fc.booking.assigned_driver === 'Juan Pérez 9999-0000');
  check('el personal puede cancelar una reserva', (await http('POST', `admin/rentals/${fb.booking.id}/cancel`, SA)).booking?.status === 'cancelled');
  const dupPlate = await http('POST', 'admin/fleet', SA, { model: 'Otro', plate: `R${rnd}`, price: 900 });
  check('la flota tampoco repite placas', dupPlate.status === 409);
  const sup = await registerUser({ name: 'E1 Pasajero', phone: `85${rnd}5`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  check('un pasajero no entra a las reservas del panel', (await http('GET', 'admin/rentals', sup.token)).status === 403);

  // Eliminar la cuenta de un conductor que ya tuvo alquileres: se conserva el historial y la placa queda libre
  const pendingOne = await http('POST', 'rentals', P.token, { listingId: mine.listingId, start: addDays(today, 6), days: 1, payment: 'cash' });
  check('se puede eliminar la cuenta de un conductor con alquileres', (await http('POST', `admin/users/${D.user.id}/delete`, SA)).ok === true);
  const [[pb]] = await pool.query('SELECT status FROM rental_bookings WHERE id = ?', [pendingOne.booking.id]);
  check('su reserva pendiente queda cancelada', pb.status === 'cancelled');
  const again = await registerUser({ name: 'E1 Conductor', phone: `98${rnd}5`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', model: 'Corolla', plate: `R${rnd}` });
  check('su placa queda libre para otro conductor', !!again.token, again.error || '');
  const gone = await http('GET', `rentals/search?start=${addDays(today, 6)}&days=1`, P.token);
  check('su carro ya no aparece para alquilar', !gone.results.some((x) => x.listingId === mine.listingId));
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
} finally {
  ds?.close();
  await http('PUT', 'admin/settings', SA, keep);
  for (const role of ['passenger', 'driver']) await http('PUT', `admin/permissions/${role}`, SA, { perms: rolesBefore?.[role] || [] });
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
