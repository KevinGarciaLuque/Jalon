// Vehículo de cada conductor: categoría, marca, modelo, color, año y placa (única).
// users.vehicle y users.plate guardan el texto que muestran las pantallas y se mantienen al día desde aquí.
import { isCategory, normalizePlate } from '../fares.js';

const text = (v, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : null);

// Valida lo que llega del formulario. Acepta el formato anterior (`vehicle` como texto libre) de las apps sin actualizar.
export function readVehicle(body = {}) {
  const category = body.category == null || body.category === '' ? 'car' : body.category;
  if (!isCategory(category)) return { error: 'Elige si es moto, carro o carro amplio' };
  const model = text(body.model, 100) || text(body.vehicle, 100);
  if (!model) return { error: 'Escribe el modelo del vehículo' };
  const plate = normalizePlate(body.plate);
  if (plate.length < 3 || plate.length > 10) return { error: 'La placa debe tener entre 3 y 10 letras o números' };
  const year = body.year == null || body.year === '' ? null : Number(body.year);
  if (year != null && (!Number.isInteger(year) || year < 1980 || year > new Date().getFullYear() + 1)) return { error: 'El año del vehículo no es válido' };
  return { vehicle: { category, make: text(body.make, 40), model, color: text(body.color, 30), year, plate } };
}

export const vehicleLabel = (v) => [v.make, v.model, v.color, v.year].filter(Boolean).join(' ');
export const isPlateDup = (e) => e?.code === 'ER_DUP_ENTRY' && /uniq_plate/.test(e.message);

// ¿La placa ya es de otro vehículo?
export async function plateTaken(db, plate, driverId = 0) {
  const [rows] = await db.query('SELECT 1 FROM vehicles WHERE plate = ? AND (driver_id IS NULL OR driver_id <> ?) LIMIT 1', [plate, driverId]);
  return rows.length > 0;
}

// Crea o reemplaza el vehículo del conductor. Si la placa ya es de otro, MySQL lo rechaza (ER_DUP_ENTRY con uniq_plate).
export async function saveVehicle(db, driverId, v) {
  const fields = [v.category, v.make, v.model, v.color, v.year, v.plate];
  const [r] = await db.query('UPDATE vehicles SET category = ?, make = ?, model = ?, color = ?, year = ?, plate = ? WHERE driver_id = ?', [...fields, driverId]);
  if (!r.affectedRows) await db.query('INSERT INTO vehicles (category, make, model, color, year, plate, driver_id) VALUES (?,?,?,?,?,?,?)', [...fields, driverId]);
  await db.query('UPDATE users SET vehicle = ?, plate = ? WHERE id = ?', [vehicleLabel(v), v.plate, driverId]);
}

export async function vehicleOf(db, driverId) {
  const [[v]] = await db.query('SELECT category, make, model, color, year, plate FROM vehicles WHERE driver_id = ?', [driverId]);
  return v || null;
}
