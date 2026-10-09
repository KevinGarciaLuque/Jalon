import 'dotenv/config';
// Prueba de carga: 30 conductores y 500 pasajeros conectados a la vez, con 100 viajes completos en pocos segundos.
// Uso (contra un servidor LOCAL, nunca contra producción):
//   PORT=4200 OSRM_URL=http://127.0.0.1:9 node src/index.js      (OSRM apagado a propósito: no se castiga el servicio público)
//   LOAD_URL=http://localhost:4200 node test/load.mjs
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';

const URL_ = process.env.LOAD_URL || 'http://localhost:4200';
const DRIVERS = Number(process.env.LOAD_DRIVERS || 30);
const PASSENGERS = Number(process.env.LOAD_PASSENGERS || 500);
const RIDES = Number(process.env.LOAD_RIDES || 100);
const SPREAD_MS = Number(process.env.LOAD_SPREAD_MS || 30000); // los viajes se piden repartidos en este tiempo
const rand = (a, b) => a + Math.random() * (b - a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const pct = (arr, p) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor((p / 100) * arr.length))] : NaN);
const ms = (n) => (Number.isFinite(n) ? `${Math.round(n)} ms` : '—');

async function wipe() {
  const [u] = await pool.query("SELECT id FROM users WHERE name LIKE 'Load %'");
  const ids = u.map((x) => x.id);
  if (!ids.length) return;
  const rides = '(SELECT id FROM rides WHERE passenger_id IN (?) OR driver_id IN (?))';
  await pool.query(`DELETE FROM alerts WHERE ride_id IN ${rides}`, [ids, ids]);
  await pool.query(`DELETE FROM ratings WHERE ride_id IN ${rides}`, [ids, ids]);
  await pool.query(`DELETE FROM offers WHERE ride_id IN ${rides} OR driver_id IN (?)`, [ids, ids, ids]);
  await pool.query('DELETE FROM rides WHERE passenger_id IN (?) OR driver_id IN (?)', [ids, ids]);
  await pool.query('DELETE FROM users WHERE id IN (?)', [ids]);
}

await wipe();
// Usuarios de prueba directamente en la base (el registro real pasa por SMS y no es lo que se mide aquí)
const hash = await bcrypt.hash('secreto1', 10);
const rows = [
  ...Array.from({ length: DRIVERS }, (_, i) => [`Load D${i}`, `60${String(i).padStart(6, '0')}`, hash, 'driver', 'active', `Auto ${i}`, `LD${String(i).padStart(4, '0')}`]),
  ...Array.from({ length: PASSENGERS }, (_, i) => [`Load P${i}`, `61${String(i).padStart(6, '0')}`, hash, 'passenger', 'active', null, null]),
];
for (let i = 0; i < rows.length; i += 200) {
  await pool.query('INSERT INTO users (name, phone, password_hash, role, status, vehicle, plate) VALUES ?', [rows.slice(i, i + 200)]);
}
const [users] = await pool.query("SELECT id, name, role FROM users WHERE name LIKE 'Load %'");
const drivers = users.filter((u) => u.role === 'driver');
const passengers = users.filter((u) => u.role === 'passenger');
const tokenOf = (u) => jwt.sign({ id: u.id, role: u.role, tv: 0 }, process.env.JWT_SECRET, { expiresIn: '30m' });

const errors = [];
const sockets = [];
const connect = (u) => new Promise((resolve) => {
  const t0 = performance.now();
  const s = io(URL_, { auth: { token: tokenOf(u) }, transports: ['websocket'], reconnection: false });
  s.user = u;
  s.once('connect', () => resolve({ s, ms: performance.now() - t0 }));
  s.once('connect_error', (e) => { errors.push(`conexión ${u.name}: ${e.message}`); resolve({ s: null }); });
  sockets.push(s);
});

// ---- 1. Conectar a todos (en tandas, como llegarían usuarios reales) ----
console.log(`Conectando ${DRIVERS} conductores y ${PASSENGERS} pasajeros a ${URL_} …`);
const connects = [];
for (let i = 0; i < users.length; i += 50) {
  connects.push(...(await Promise.all(users.slice(i, i + 50).map(connect))));
  await sleep(150);
}
const ok = connects.filter((c) => c.s);
const connMs = ok.map((c) => c.ms);

// ---- 2. Comportamiento de cada conductor y pasajero ----
const rides = new Map(); // passengerId -> medidas
const lat = () => 14.0723 + rand(-0.02, 0.02);
const lng = () => -87.1921 + rand(-0.02, 0.02);
let ridesDone = 0;

for (const c of ok.filter((x) => x.s.user.role === 'driver')) {
  const s = c.s;
  let busy = false;
  let pos = { lat: lat(), lng: lng() };
  s.emit('driver:online', pos);
  setInterval(() => { pos = { lat: pos.lat + rand(-0.0005, 0.0005), lng: pos.lng + rand(-0.0005, 0.0005) }; s.emit('driver:location', pos); }, 3000).unref();
  s.on('ride:new', (r) => {
    if (busy || Math.random() > 0.7) return; // no todos ofertan
    setTimeout(() => !busy && s.emit('offer:make', { rideId: r.id, price: r.offered_price }), rand(300, 1200));
  });
  s.on('ride:state', async (r) => {
    if (r.driver_id !== s.user.id || r.status !== 'accepted' || busy) return;
    busy = true;
    for (const st of ['arrived', 'started', 'completed']) { await sleep(rand(200, 500)); s.emit('ride:status', { rideId: r.id, status: st }); }
    busy = false;
  });
}

for (const c of ok.filter((x) => x.s.user.role === 'passenger')) {
  const s = c.s;
  s.emit('passenger:location', { lat: lat(), lng: lng() });
  s.on('offer:new', (o) => {
    const m = rides.get(s.user.id);
    if (!m) return;
    m.pending = [...(m.pending || []), o];
    if (!m.firstOffer) { m.firstOffer = performance.now(); s.emit('offer:accept', { offerId: m.pending.shift().id }); }
  });
  // Si el conductor elegido ya aceptó otro viaje, la persona elige otra oferta
  s.on('offer:invalid', () => {
    const m = rides.get(s.user.id);
    if (m?.pending?.length) s.emit('offer:accept', { offerId: m.pending.shift().id });
  });
  s.on('ride:state', (r) => {
    const m = rides.get(s.user.id);
    if (!m) return;
    if (r.status === 'accepted' && !m.accepted) m.accepted = performance.now();
    if (r.status === 'completed' && !m.completed) { m.completed = performance.now(); ridesDone++; }
    if (r.status === 'cancelled' && !m.cancelled) m.cancelled = performance.now();
  });
}

// ---- 3. Latencia del servidor mientras tanto ----
const health = [];
let probing = true;
(async () => {
  while (probing) {
    const t0 = performance.now();
    try { await fetch(`${URL_}/api/health`); health.push(performance.now() - t0); } catch (e) { errors.push(`salud: ${e.message}`); }
    await sleep(500);
  }
})();

// ---- 4. Los viajes se piden repartidos en el tiempo ----
console.log(`Pidiendo ${RIDES} viajes repartidos en ${Math.round(SPREAD_MS / 1000)} s …`);
const chosen = [...passengers].sort(() => Math.random() - 0.5).slice(0, RIDES);
const tStart = performance.now();
for (const p of chosen) {
  const c = ok.find((x) => x.s.user.id === p.id);
  if (!c) continue;
  setTimeout(() => {
    rides.set(p.id, { requested: performance.now() });
    const a = { lat: lat(), lng: lng() };
    c.s.emit('ride:request', { origin: { ...a, text: 'Origen' }, dest: { lat: a.lat + rand(0.01, 0.03), lng: a.lng + rand(0.01, 0.03), text: 'Destino' }, price: 80 }, (res) => {
      if (res?.error) { errors.push(`viaje ${p.name}: ${res.error}`); rides.get(p.id).failed = true; }
    });
  }, rand(0, SPREAD_MS));
}

// Se espera a que terminen (o a que se acabe el tiempo): quien no consigue conductor en 60 s se da por no atendido
const deadline = performance.now() + SPREAD_MS + 60000;
while (performance.now() < deadline) {
  await sleep(1000);
  const settled = [...rides.values()].filter((m) => m.completed || m.failed || m.cancelled).length;
  if (rides.size === chosen.length && settled === chosen.length) break;
}
probing = false;
await sleep(600);

// ---- 5. Resultados ----
const all = [...rides.values()];
const reqToOffer = all.filter((m) => m.firstOffer).map((m) => m.firstOffer - m.requested);
const offerToAccepted = all.filter((m) => m.accepted && m.firstOffer).map((m) => m.accepted - m.firstOffer);
const total = performance.now() - tStart;
const completed = all.filter((m) => m.completed).length;
const noDriver = all.length - completed;

console.log('\n================ RESULTADOS ================');
console.log(`Conexiones:        ${ok.length}/${users.length} correctas · tiempo p95 ${ms(pct(connMs, 95))} · máx ${ms(Math.max(...connMs))}`);
console.log(`Viajes pedidos:    ${all.length} · completados ${completed} (${Math.round((completed / Math.max(1, all.length)) * 100)}%) · sin conductor/fallidos ${noDriver}`);
console.log(`Pedido → 1ª oferta: p50 ${ms(pct(reqToOffer, 50))} · p95 ${ms(pct(reqToOffer, 95))} · máx ${ms(Math.max(...reqToOffer))}`);
console.log(`Oferta → aceptado:  p50 ${ms(pct(offerToAccepted, 50))} · p95 ${ms(pct(offerToAccepted, 95))}`);
console.log(`Salud del servicio durante la carga (${health.length} consultas): p50 ${ms(pct(health, 50))} · p95 ${ms(pct(health, 95))} · máx ${ms(Math.max(...health))}`);
console.log(`Duración total:    ${(total / 1000).toFixed(1)} s · errores: ${errors.length}`);
if (errors.length) console.log([...new Set(errors)].slice(0, 5).map((e) => `  - ${e}`).join('\n'));

const pass = ok.length === users.length && completed / Math.max(1, all.length) >= 0.93 && pct(reqToOffer, 95) < 3000 && pct(health, 95) < 500;
console.log(pass ? '\nOK   la carga de 30 conductores y 500 pasajeros se sostiene' : '\nFAIL no se sostiene: revisa los números de arriba');

sockets.forEach((s) => s.close());
await sleep(500);
await wipe();
await pool.end();
process.exitCode = pass ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 300);
