// Validaciones y utilidades pequeñas que usan varias partes del servidor
import crypto from 'crypto';
import { MAX_PRICE } from './config.js';

export const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
export const isPoint = (p) => p && isNum(p.lat) && isNum(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
export const isPrice = (n) => isNum(n) && n >= 1 && n <= MAX_PRICE;
// Ejecuta tareas con la misma clave una tras otra (evita carreras por doble clic)
const locks = new Map();
export function serial(key, fn) {
  const run = (locks.get(key) || Promise.resolve()).catch(() => {}).then(fn);
  locks.set(key, run);
  run.finally(() => locks.get(key) === run && locks.delete(key)).catch(() => {});
  return run;
}
export const clean = (t) => (typeof t === 'string' ? t.trim().slice(0, 200) : null) || null;

export const num = (v) => (v === undefined || v === '' ? NaN : Number(v));
export const parsePoint = (str) => {
  const [lat, lng] = String(str || '').split(',').map(Number);
  return { lat, lng };
};

// Contraseña temporal legible (sin letras que se confunden: 0/O, 1/l/I)
export function tempPassword() {
  const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  return Array.from(crypto.randomBytes(10), (b) => alphabet[b % alphabet.length]).join('');
}
