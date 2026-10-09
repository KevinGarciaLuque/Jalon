// Un viaje sin conductor debe cancelarse solo (el servidor revisa cada 30 s)
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
console.log('viaje', ride.id, 'envejecido; esperando cancelación (máx 35 s)…');
const t = setTimeout(() => { console.log('FAIL no se canceló'); process.exit(1); }, 35000);
ps.on('ride:state', async (x) => {
  if (x.status === 'cancelled') { clearTimeout(t); console.log('OK   se canceló solo'); ps.close(); await pool.end(); process.exit(0); }
});
