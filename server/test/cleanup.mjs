// Borra los usuarios, viajes y ofertas creados por los tests
import fs from 'fs';
import path from 'path';
import { pool } from '../src/db.js';
const names = ['Test Driver', 'Test Pasajero', 'Exp', 'P3 Driver', 'P3 Pasajero', 'E2E Driver', 'E2E Pasajero', 'P4 Pasajero', 'P4 Formato', 'P4 Bloqueo', 'P4 Reset', 'P4 Driver'];
const [u] = await pool.query('SELECT id, phone FROM users WHERE name IN (?) AND role <> "admin"', [names]);
const ids = u.map((x) => x.id);
const phones = u.map((x) => x.phone);
if (ids.length) {
  const [docs] = await pool.query('SELECT file FROM documents WHERE user_id IN (?)', [ids]);
  for (const d of docs) fs.rmSync(path.join(process.cwd(), 'uploads', d.file), { force: true });
  await pool.query('DELETE FROM documents WHERE user_id IN (?)', [ids]);
  const own = 'SELECT id FROM rides WHERE passenger_id IN (?) OR driver_id IN (?)';
  await pool.query(`DELETE FROM alerts WHERE user_id IN (?) OR ride_id IN (${own})`, [ids, ids, ids]);
  await pool.query(`DELETE FROM ratings WHERE rater_id IN (?) OR ratee_id IN (?) OR ride_id IN (${own})`, [ids, ids, ids, ids]);
  await pool.query('DELETE FROM offers WHERE driver_id IN (?) OR ride_id IN (SELECT id FROM rides WHERE passenger_id IN (?) OR driver_id IN (?))', [ids, ids, ids]);
  await pool.query('DELETE FROM rides WHERE passenger_id IN (?) OR driver_id IN (?)', [ids, ids]);
  await pool.query('DELETE FROM users WHERE id IN (?)', [ids]);
}
if (phones.length) await pool.query('DELETE FROM otp_codes WHERE phone IN (?)', [phones]);
console.log(`Borrados ${ids.length} usuarios de prueba`);
await pool.end();
