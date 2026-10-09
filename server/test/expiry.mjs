// Un viaje sin conductor debe cancelarse solo (el servidor revisa cada 30 s).
// Se comprueba en la base de datos: no importa cuál de los servidores que comparten la base lo cancele primero.
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { registerUser } from './helpers.mjs';

const API = process.env.API_URL || 'http://localhost:4000';
const phone = '7' + String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
const { token } = await registerUser({ name: 'Exp', phone, password: 'secreto1', role: 'passenger' });
const ps = io(API, { auth: { token } });
await new Promise((r) => ps.once('connect', r));
const p = { lat: 14.0723, lng: -87.1921 };
const created = new Promise((r) => ps.on('ride:state', (x) => x.status === 'requested' && r(x)));
ps.emit('ride:request', { origin: p, dest: { lat: 14.1, lng: -87.2 }, price: 80 }, () => {});
const ride = await created;
await pool.query('UPDATE rides SET created_at = NOW() - INTERVAL 11 MINUTE WHERE id = ?', [ride.id]);
console.log('viaje', ride.id, 'envejecido; esperando cancelación (máx 45 s)…');

let row;
for (let i = 0; i < 45; i++) {
  [[row]] = await pool.query('SELECT status, cancelled_by FROM rides WHERE id = ?', [ride.id]);
  if (row.status === 'cancelled') break;
  await new Promise((r) => setTimeout(r, 1000));
}
const ok = row.status === 'cancelled' && row.cancelled_by === 'system';
console.log(ok ? 'OK   se canceló solo (por el sistema)' : `FAIL no se canceló (estado: ${row.status})`);
ps.close();
await pool.end();
process.exit(ok ? 0 : 1);
