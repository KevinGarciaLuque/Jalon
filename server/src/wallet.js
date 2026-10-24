// Saldo de los conductores y comisión por viaje (estilo inDrive, sin pasarela de pago).
// El conductor recarga transfiriendo a la cuenta de Ktracho GO y subiendo el comprobante; el personal lo autoriza y se acredita el saldo.
// De ese saldo se descuenta la comisión de cada viaje cobrado en efectivo. Todo movimiento queda en un libro de cuentas que nunca se edita.
import { CATEGORIES, CATEGORY_LABEL, FARE_DEFAULTS } from './fares.js';

export const SETTING_DEFAULTS = {
  commission_enabled: '0', // apagado hasta que el superadmin lo active
  commission_percent: '10',
  welcome_credit: '0', // crédito que recibe un conductor al ser aprobado
  min_balance: '0', // con menos saldo que esto no puede ponerse disponible (puede ser negativo para permitir un pequeño crédito)
  topup_min: '100',
  topup_max: '5000',
  bank_name: '',
  bank_account_type: '',
  bank_account: '',
  bank_holder: '',
  bank_note: '',
  staff_2fa_required: '1', // el personal debe usar la verificación en dos pasos; el superadmin puede apagarla
  driver_selfie_hours: '12', // cada cuántas horas el conductor se toma una selfie para conectarse (0 = no se pide)
  ride_safety_checks: '1', // durante el viaje se pregunta «¿Todo bien?» si el carro se desvía o se detiene mucho
  ride_pin_required: '0', // '1' = PIN en todos los viajes; si no, solo quien lo activó en Mi cuenta y los «Solo conductoras»
  map_rotation: '1', // el mapa puede girar según hacia dónde vas (como Waze); se apaga si da problemas en algún celular
  ...FARE_DEFAULTS, // tarifas por categoría (fares.js)
  // Alquiler de carros por días (apagado hasta que el superadmin lo active)
  rental_enabled: '0',
  rental_price_min: '300', // precio por día que puede poner un conductor
  rental_price_max: '5000',
  rental_max_days: '7',
  rental_advance_days: '30', // con cuántos días de anticipación se puede reservar
};

export const money = (n) => Math.round(Number(n) * 100) / 100;
export const commissionFor = (price, percent) => money((Number(price) * Number(percent)) / 100);

let cache = null;
let cacheAt = 0;
export const clearSettingsCache = () => { cache = null; };

export async function getSettings(pool) {
  if (cache && Date.now() - cacheAt < 10000) return cache;
  const [rows] = await pool.query('SELECT name, value FROM settings');
  cache = { ...SETTING_DEFAULTS, ...Object.fromEntries(rows.map((r) => [r.name, r.value])) };
  cacheAt = Date.now();
  return cache;
}

// Valida lo que envía el superadmin. Devuelve { values, error }.
export function validateSettings(input, current) {
  const values = {};
  const num = (k, min, max, label) => {
    const v = Number(input[k]);
    if (!Number.isFinite(v) || v < min || v > max) return `${label} debe estar entre ${min} y ${max}`;
    values[k] = String(money(v));
    return null;
  };
  const text = (k, max) => {
    if (typeof input[k] !== 'string') return `Dato inválido: ${k}`;
    const v = input[k].trim();
    if (v.length > max) return `Máximo ${max} caracteres en ${k}`;
    values[k] = v;
    return null;
  };
  const checks = {
    commission_enabled: () => { values.commission_enabled = input.commission_enabled === true || input.commission_enabled === '1' || input.commission_enabled === 1 ? '1' : '0'; return null; },
    commission_percent: () => num('commission_percent', 0, 50, 'La comisión'),
    welcome_credit: () => num('welcome_credit', 0, 5000, 'El crédito de bienvenida'),
    min_balance: () => num('min_balance', -1000, 5000, 'El saldo mínimo'),
    topup_min: () => num('topup_min', 10, 10000, 'La recarga mínima'),
    topup_max: () => num('topup_max', 10, 50000, 'La recarga máxima'),
    bank_name: () => text('bank_name', 60),
    bank_account_type: () => text('bank_account_type', 40),
    bank_account: () => text('bank_account', 60),
    bank_holder: () => text('bank_holder', 100),
    bank_note: () => text('bank_note', 400),
    staff_2fa_required: () => { values.staff_2fa_required = [false, '0', 0].includes(input.staff_2fa_required) ? '0' : '1'; return null; },
    driver_selfie_hours: () => num('driver_selfie_hours', 0, 168, 'Las horas entre selfies'),
    ride_safety_checks: () => { values.ride_safety_checks = [false, '0', 0].includes(input.ride_safety_checks) ? '0' : '1'; return null; },
    ride_pin_required: () => { values.ride_pin_required = [false, '0', 0].includes(input.ride_pin_required) ? '0' : '1'; return null; },
    map_rotation: () => { values.map_rotation = [false, '0', 0].includes(input.map_rotation) ? '0' : '1'; return null; },
    rental_enabled: () => { values.rental_enabled = [true, '1', 1].includes(input.rental_enabled) ? '1' : '0'; return null; },
    rental_price_min: () => num('rental_price_min', 1, 50000, 'El precio mínimo por día'),
    rental_price_max: () => num('rental_price_max', 1, 50000, 'El precio máximo por día'),
    rental_max_days: () => num('rental_max_days', 1, 30, 'Los días máximos de un alquiler'),
    rental_advance_days: () => num('rental_advance_days', 0, 180, 'Los días de anticipación'),
    // Tarifas: base, por km, por minuto y mínima de cada categoría
    ...Object.fromEntries(CATEGORIES.flatMap((c) => [
      [`fare_${c}_base`, () => num(`fare_${c}_base`, 0, 1000, `La tarifa base de ${CATEGORY_LABEL[c]}`)],
      [`fare_${c}_km`, () => num(`fare_${c}_km`, 0, 200, `El precio por km de ${CATEGORY_LABEL[c]}`)],
      [`fare_${c}_min`, () => num(`fare_${c}_min`, 0, 100, `El precio por minuto de ${CATEGORY_LABEL[c]}`)],
      [`fare_${c}_minimum`, () => num(`fare_${c}_minimum`, 0, 2000, `La tarifa mínima de ${CATEGORY_LABEL[c]}`)],
    ])),
  };
  for (const key of Object.keys(input)) {
    if (!checks[key]) return { error: `Ajuste desconocido: ${key}` };
    const error = checks[key]();
    if (error) return { error };
  }
  const next = { ...current, ...values };
  if (Number(next.topup_max) < Number(next.topup_min)) return { error: 'La recarga máxima no puede ser menor que la mínima' };
  if (Number(next.rental_price_max) < Number(next.rental_price_min)) return { error: 'El precio máximo por día no puede ser menor que el mínimo' };
  return { values };
}

// Mueve el saldo de un conductor dentro de una transacción: escribe el movimiento y actualiza el saldo juntos o ninguno.
// Devuelve el saldo nuevo, o null si ese movimiento ya existía (la comisión de un viaje o la recarga de una solicitud no se cobran dos veces).
export async function postEntry(pool, { userId, amount, kind, rideId = null, topupId = null, rentalId = null, note = null, by = null }) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    try {
      await conn.query('INSERT INTO wallet_entries (user_id, amount, kind, ride_id, topup_id, rental_id, note, created_by) VALUES (?,?,?,?,?,?,?,?)', [userId, money(amount), kind, rideId, topupId, rentalId, note, by]);
    } catch (e) {
      await conn.rollback();
      if (e.code === 'ER_DUP_ENTRY') return null;
      throw e;
    }
    await conn.query('UPDATE users SET balance = balance + ? WHERE id = ?', [money(amount), userId]);
    const [[row]] = await conn.query('SELECT balance FROM users WHERE id = ?', [userId]);
    await conn.commit();
    return Number(row.balance);
  } catch (e) {
    await conn.rollback().catch(() => {});
    throw e;
  } finally {
    conn.release();
  }
}
