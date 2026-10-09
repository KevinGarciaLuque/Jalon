import 'dotenv/config';
// Fase 8C: tiempo de llegada, subir el precio y ofertas que vencen.
// Necesita tiempos cortos en el servidor (los pone `npm test`): OFFER_TTL_SECONDS=3, OFFER_SWEEP_MS=500, RAISE_COOLDOWN_MS=700, ETA_EVERY_MS=2500.
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, registerUser, uploadDocs } from './helpers.mjs';

if (process.env.OFFER_TTL_SECONDS !== '3') { console.log('SKIP: usa `npm test` (arranca el servidor con tiempos cortos)'); process.exit(0); }

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const phone = (p) => `${p}${rnd}9`.slice(0, 8);
const connect = async (token) => { const s = io(API, { auth: { token } }); await new Promise((r) => s.once('connect', r)); return s; };
const next = (s, ev, pred = () => true, ms = 6000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout esperando ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
const collect = (s, ev) => { const got = []; s.on(ev, (d) => got.push(d)); return got; };
const ask = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));

const P = await registerUser({ name: 'P8C Pasajero', phone: phone('88'), password: 'Cielo-azul-77', role: 'passenger' });
const X = await registerUser({ name: 'P8C Otro', phone: phone('87'), password: 'Cielo-azul-77', role: 'passenger' });
const D = await registerUser({ name: 'P8C Conductor', phone: phone('86'), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Hilux', plate: 'HMM0001' });
await uploadDocs(D.token);
await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [D.user.id]);
const ps = await connect(P.token);
const ds = await connect(D.token);
const xs = await connect(X.token);
const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.1, lng: -87.2, text: 'Mall Multiplaza' };
ds.emit('driver:online', { lat: 14.073, lng: -87.1925 });
await wait(500);

// ================= Subir el precio =================
const first = next(ds, 'ride:new');
const requested = next(ps, 'ride:state', (r) => r.status === 'requested');
ps.emit('ride:request', { origin, dest, price: 80 }, () => {});
const seen = await first;
const ride = await requested;
check('el conductor ve la solicitud a L 80', Number(seen.offered_price) === 80);

const rideUpdate = next(ds, 'ride:new', (r) => r.id === ride.id && Number(r.offered_price) === 85);
const myUpdate = next(ps, 'ride:state', (r) => Number(r.offered_price) === 85);
const r1 = await ask(ps, 'ride:raise', { rideId: ride.id, price: 85 });
check('el pasajero sube su oferta a L 85', r1.ok === true);
const upd = await rideUpdate;
check('los conductores cercanos ven el precio nuevo en la misma solicitud', upd.id === ride.id && Number(upd.offered_price) === 85);
check('el pasajero ve su precio actualizado', Number((await myUpdate).offered_price) === 85);
const [[priced]] = await pool.query('SELECT offered_price FROM rides WHERE id = ?', [ride.id]);
check('el precio nuevo queda guardado', Number(priced.offered_price) === 85);

check('no se puede bajar el precio', /mayor/.test((await ask(ps, 'ride:raise', { rideId: ride.id, price: 80 })).error || ''));
check('ni repetir el mismo', /mayor/.test((await ask(ps, 'ride:raise', { rideId: ride.id, price: 85 })).error || ''));
check('ni poner un precio absurdo', /entre/.test((await ask(ps, 'ride:raise', { rideId: ride.id, price: 999999 })).error || ''));
check('subir el precio varias veces seguidas se frena unos segundos', /Espera/.test((await ask(ps, 'ride:raise', { rideId: ride.id, price: 90 })).error || ''));
await wait(800);
check('pasada la espera se puede subir de nuevo', (await ask(ps, 'ride:raise', { rideId: ride.id, price: 90 })).ok === true);
check('otro pasajero no puede cambiar el precio de un viaje ajeno', !!(await ask(xs, 'ride:raise', { rideId: ride.id, price: 500 })).error);
check('un conductor no puede subir el precio de un viaje', await Promise.race([ask(ds, 'ride:raise', { rideId: ride.id, price: 500 }).then(() => false), wait(700).then(() => true)]));
const [[afterTry]] = await pool.query('SELECT offered_price FROM rides WHERE id = ?', [ride.id]);
check('y el precio sigue siendo el del pasajero (L 90)', Number(afterTry.offered_price) === 90);

// ================= Ofertas que vencen =================
const offerP = next(ps, 'offer:new');
ds.emit('offer:make', { rideId: ride.id, price: 90 });
const offer = await offerP;
check('la oferta indica cuántos segundos vale', offer.ttl === 3);
const expiredP = next(ps, 'offer:expired', (e) => e.offerId === offer.id);
const expiredD = next(ds, 'offer:expired', (e) => e.offerId === offer.id);
const [expP, expD] = await Promise.all([expiredP, expiredD]);
check('al vencer, el pasajero y el conductor se enteran', expP.rideId === ride.id && expD.rideId === ride.id);
const [[st]] = await pool.query('SELECT status FROM offers WHERE id = ?', [offer.id]);
check('la oferta queda como vencida', st.status === 'expired');
const invalid = next(ps, 'offer:invalid', (e) => e.offerId === offer.id);
ps.emit('offer:accept', { offerId: offer.id });
check('aceptar una oferta vencida no hace nada', (await invalid).offerId === offer.id && (await pool.query('SELECT status FROM rides WHERE id = ?', [ride.id]))[0][0].status === 'requested');

// El conductor vuelve a ofertar; renovar su oferta antes de que venza la mantiene viva
const again = next(ps, 'offer:new');
ds.emit('offer:make', { rideId: ride.id, price: 90 });
const offer2 = await again;
check('el conductor puede volver a ofertar tras el vencimiento (oferta nueva)', offer2.id !== offer.id);
await wait(2000);
const renewed = next(ps, 'offer:new', (o) => o.id === offer2.id);
ds.emit('offer:make', { rideId: ride.id, price: 91 }); // misma oferta, precio nuevo: reinicia el reloj
check('renovar actualiza la misma oferta con el precio nuevo', (await renewed).price === 91);
await wait(2000); // habrían pasado 4 s: sin renovar ya estaría vencida (vale 3)
const [[alive]] = await pool.query('SELECT status FROM offers WHERE id = ?', [offer2.id]);
check('al renovarla, sigue vigente más allá de su plazo original', alive.status === 'pending');

const accepted = next(ps, 'ride:state', (r) => r.status === 'accepted');
ps.emit('offer:accept', { offerId: offer2.id });
const acc = await accepted;
check('se acepta a tiempo al precio renovado', Number(acc.final_price) === 91);
check('una vez aceptado ya no se puede subir el precio', !!(await ask(ps, 'ride:raise', { rideId: ride.id, price: 200 })).error);

// ================= Tiempo de llegada =================
const etaP = collect(ps, 'ride:eta');
const etaD = collect(ds, 'ride:eta');
ds.emit('driver:location', { lat: 14.0735, lng: -87.1930 });
await wait(1300); // el cálculo de la ruta puede tardar un poco
check('al ir hacia el pasajero, ambos reciben el tiempo estimado de llegada', etaP.length === 1 && etaD.length === 1 && etaP[0].phase === 'pickup' && etaP[0].minutes >= 1 && etaP[0].km > 0);
check('el conductor además recibe el camino para verlo en el mapa', Array.isArray(etaD[0].coords) && etaD[0].coords.length >= 2 && !etaP[0].coords);
ds.emit('driver:location', { lat: 14.0734, lng: -87.1929 }); // pocos segundos después: todavía no toca recalcular (se recalcula cada 2.5 s en la prueba)
await wait(800);
check('no se recalcula en cada movimiento (solo cada pocos segundos)', etaP.length === 1);
await wait(1000);
ds.emit('driver:location', { lat: 14.0733, lng: -87.1928 });
await wait(1300);
check('pasado el tiempo, se actualiza', etaP.length === 2 && etaP[1].rideId === ride.id);

for (const s of ['arrived', 'started']) { const u = next(ps, 'ride:state', (r) => r.status === s); ds.emit('ride:status', { rideId: ride.id, status: s }); await u; }
etaP.length = 0;
ds.emit('driver:location', { lat: 14.0725, lng: -87.1922 });
await wait(1500);
check('con el viaje en curso, el tiempo es hasta el destino', etaP.length === 1 && etaP[0].phase === 'dropoff' && etaP[0].minutes >= 1);

[ps, ds, xs].forEach((s) => s.close());
await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
