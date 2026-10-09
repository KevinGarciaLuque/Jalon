import 'dotenv/config';
// Un celular manda mensajes en cuanto se conecta (p. ej. "estoy disponible" al recuperar la señal): ninguno debe perderse.
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, registerUser, uploadDocs } from './helpers.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
// Nada de esperar para siempre: si algo no llega en 5 s se cuenta como mensaje perdido
const within = (promise, label) => Promise.race([promise, wait(5000).then(() => { throw new Error(label); })]);
const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const ROUNDS = Number(process.env.RACE_ROUNDS || 25);

const D = await registerUser({ name: 'P8 Conductor', phone: `9${rnd}9`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Hilux', plate: 'HKK0001' });
const P = await registerUser({ name: 'P8 Pasajero', phone: `8${rnd}9`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
await uploadDocs(D.token);
await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [D.user.id]);

const ps = io(API, { auth: { token: P.token } });
await new Promise((r) => ps.once('connect', r));
const origin = { lat: 14.0723, lng: -87.1921 };

let lost = 0;
for (let i = 0; i < ROUNDS; i++) {
  const ds = io(API, { auth: { token: D.token }, forceNew: true });
  // Igual que la app real: apenas se conecta, anuncia que está disponible
  ds.on('connect', () => ds.emit('driver:online', { lat: 14.073, lng: -87.1925 }));
  try {
    await within(new Promise((r) => ds.once('connect', r)), 'el conductor no logró conectarse');
    await wait(350);
    const list = await within(new Promise((r) => { ps.once('drivers:nearby', r); ps.emit('passenger:location', origin); }), 'el servidor no respondió con los conductores cercanos');
    if (!list.some((d) => d.id === D.user.id)) lost++;
  } catch (e) {
    lost++;
    console.log(`  ronda ${i + 1}: ${e.message}`);
  }
  ds.close();
  await wait(150);
}
ps.close();
await pool.query("DELETE FROM users WHERE name IN ('P8 Conductor','P8 Pasajero')").catch(() => {});
await pool.end();
console.log(lost === 0 ? `OK   ${ROUNDS} reconexiones y ningún mensaje de "estoy disponible" se perdió` : `FAIL se perdieron ${lost} de ${ROUNDS} mensajes enviados al conectarse`);
process.exitCode = lost === 0 ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 200);
