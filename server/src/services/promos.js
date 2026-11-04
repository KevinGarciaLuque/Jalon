// Códigos promocionales: el pasajero escribe un código al pedir el viaje y paga menos en efectivo.
// El descuento lo paga Ktracho GO, no el conductor: al terminar el viaje se le pone esa diferencia en su saldo
// (el mismo saldo del que se descuentan las comisiones). Por eso los códigos solo funcionan con la comisión activa.
// Los usos se cuentan con los viajes que llevan el código y no se cancelaron: si el viaje se cancela, el uso se devuelve.
import crypto from 'crypto';
import { pool } from '../db.js';
import { getSettings, postEntry, money } from '../wallet.js';
import { tellWallet } from './balance.js';
import { serial } from '../util.js';

export class PromoError extends Error {}
export const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);

// Cuánto se descuenta de un precio: fijo (sin pasar del precio) o porcentaje (con su tope)
export function discountFor(promo, price) {
  const p = Number(price) || 0;
  const raw = promo.kind === 'percent' ? (p * Number(promo.value)) / 100 : Number(promo.value);
  const capped = promo.kind === 'percent' && promo.max_discount != null ? Math.min(raw, Number(promo.max_discount)) : raw;
  return money(Math.max(0, Math.min(capped, p)));
}

// Lo que se le muestra al pasajero (sin contar los usos de los demás)
export const promoPublic = (p) => ({
  code: p.code, description: p.description, kind: p.kind, value: Number(p.value),
  maxDiscount: p.max_discount == null ? null : Number(p.max_discount), firstRideOnly: !!p.first_ride_only,
});

// ¿Este pasajero puede usar este código ahora? Devuelve el código o lanza PromoError con el motivo.
export async function checkPromo(code, userId, db = pool) {
  const c = normalizeCode(code);
  if (c.length < 3) throw new PromoError('Escribe el código');
  if ((await getSettings(db)).commission_enabled !== '1') throw new PromoError('Los códigos promocionales no están disponibles por ahora');
  const [[p]] = await db.query(
    'SELECT *, (starts_at IS NOT NULL AND starts_at > NOW()) AS not_yet, (expires_at IS NOT NULL AND expires_at <= NOW()) AS expired FROM promo_codes WHERE code = ?', [c]
  );
  // Un código personal (premio de referidos) solo lo puede usar su dueño
  if (!p || !p.active || (p.user_id != null && p.user_id !== userId)) throw new PromoError('Ese código no existe o ya no está activo');
  if (p.not_yet) throw new PromoError('Ese código todavía no se puede usar');
  if (p.expired) throw new PromoError('Ese código ya venció');
  const [[uses]] = await db.query(
    "SELECT COUNT(*) AS total, SUM(passenger_id = ?) AS mine FROM rides WHERE promo_id = ? AND status <> 'cancelled'", [userId, p.id]
  );
  if (Number(uses.mine)) throw new PromoError('Ya usaste este código');
  if (p.max_uses != null && Number(uses.total) >= p.max_uses) throw new PromoError('Este código ya se terminó');
  if (p.first_ride_only) {
    const [[done]] = await db.query("SELECT COUNT(*) AS n FROM rides WHERE passenger_id = ? AND status = 'completed'", [userId]);
    if (done.n) throw new PromoError('Este código es solo para tu primer viaje');
  }
  return p;
}

// Revisa el código y guarda el viaje en un solo paso por código (así dos pasajeros no se llevan el último uso a la vez)
export const withPromo = (code, userId, insert) => {
  const c = normalizeCode(code);
  return serial(`promo:${c}`, async () => insert(await checkPromo(c, userId)));
};

export async function promoOf(ride) {
  if (!ride?.promo_id) return null;
  const [[p]] = await pool.query('SELECT * FROM promo_codes WHERE id = ?', [ride.promo_id]);
  return p || null;
}

// El descuento de este viaje: el guardado al aceptar una oferta, o (mientras busca conductor) el de su precio actual
export async function rideDiscount(ride, promo) {
  if (!ride?.promo_id) return 0;
  if (ride.discount != null && ride.status !== 'requested' && ride.status !== 'scheduled') return Number(ride.discount);
  const p = promo || (await promoOf(ride));
  return p ? discountFor(p, ride.final_price ?? ride.offered_price) : 0;
}

// Al terminar: Ktracho GO le pone al conductor lo que el pasajero no pagó (una sola vez por viaje)
export async function creditPromo(ride) {
  const discount = Number(ride.discount);
  if (!ride.promo_id || !ride.driver_id || !(discount > 0)) return;
  const promo = await promoOf(ride);
  const balance = await postEntry(pool, { userId: ride.driver_id, amount: discount, kind: 'promo', rideId: ride.id, note: `Descuento del código ${promo?.code || ''} en el viaje #${ride.id}: te lo paga Ktracho GO`.replace('  ', ' ') });
  if (balance !== null) tellWallet(ride.driver_id, balance, { change: discount, kind: 'promo', rideId: ride.id });
}

// Códigos personales (premios de referidos): de un solo uso, solo para esa persona y con vencimiento
const PERSONAL_DAYS = 60;
export async function createPersonalPromo(db, { userId, amount, description, firstRideOnly = false }) {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  for (let i = 0; i < 5; i++) {
    const code = `R${Array.from(crypto.randomBytes(7), (b) => letters[b % letters.length]).join('')}`;
    try {
      const [r] = await db.query(
        'INSERT INTO promo_codes (code, description, kind, value, max_uses, first_ride_only, expires_at, user_id) VALUES (?,?,?,?,1,?, NOW() + INTERVAL ? DAY, ?)',
        [code, description, 'fixed', money(amount), firstRideOnly ? 1 : 0, PERSONAL_DAYS, userId]
      );
      return { id: r.insertId, code };
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
    }
  }
  throw new Error('No se pudo crear el código personal');
}

// Los códigos personales que esta persona todavía puede usar (se le muestran al pedir el viaje)
export async function myPromos(userId) {
  if ((await getSettings(pool)).commission_enabled !== '1') return [];
  const [rows] = await pool.query(
    `SELECT p.* FROM promo_codes p
     WHERE p.user_id = ? AND p.active = 1 AND (p.expires_at IS NULL OR p.expires_at > NOW())
       AND NOT EXISTS (SELECT 1 FROM rides r WHERE r.promo_id = p.id AND r.status <> 'cancelled')
     ORDER BY p.id`, [userId]
  );
  return rows.map((p) => ({ ...promoPublic(p), expiresAt: p.expires_at }));
}

// ---------- Para el panel ----------
export function validatePromo(input, current = null) {
  const out = {};
  if (!current || input.code !== undefined) {
    out.code = normalizeCode(input.code);
    if (out.code.length < 3) return { error: 'El código debe tener de 3 a 20 letras o números' };
  }
  if (!current || input.kind !== undefined) {
    if (!['fixed', 'percent'].includes(input.kind)) return { error: 'Elige si descuenta un monto fijo o un porcentaje' };
    out.kind = input.kind;
  }
  const kind = out.kind || current?.kind;
  if (!current || input.value !== undefined) {
    const v = Number(input.value);
    if (!Number.isFinite(v) || v <= 0 || (kind === 'percent' ? v > 100 : v > 1000)) return { error: kind === 'percent' ? 'El porcentaje debe estar entre 1 y 100' : 'El descuento debe estar entre L 1 y L 1,000' };
    out.value = money(v);
  }
  const optNum = (k, label, max) => {
    if (input[k] === undefined) return null;
    if (input[k] === null || input[k] === '') { out[k] = null; return null; }
    const v = Number(input[k]);
    if (!Number.isFinite(v) || v < 1 || v > max) return `${label} debe estar entre 1 y ${max.toLocaleString('es-HN')}`;
    out[k] = k === 'max_uses' ? Math.round(v) : money(v);
    return null;
  };
  const e1 = optNum('max_discount', 'El tope del descuento', 1000) || optNum('max_uses', 'La cantidad de usos', 1000000);
  if (e1) return { error: e1 };
  if (kind === 'percent' && (out.max_discount ?? current?.max_discount) == null) return { error: 'Con porcentaje, pon un tope en lempiras (p. ej. hasta L 50)' };
  if (kind === 'fixed') out.max_discount = null;
  for (const k of ['starts_at', 'expires_at']) {
    if (input[k] === undefined) continue;
    if (input[k] === null || input[k] === '') { out[k] = null; continue; }
    const d = new Date(input[k]);
    if (Number.isNaN(d.getTime())) return { error: 'Fecha inválida' };
    out[k] = d;
  }
  const starts = out.starts_at !== undefined ? out.starts_at : current?.starts_at;
  const expires = out.expires_at !== undefined ? out.expires_at : current?.expires_at;
  if (starts && expires && new Date(expires) <= new Date(starts)) return { error: 'La fecha de vencimiento debe ser después del inicio' };
  if (input.description !== undefined) out.description = typeof input.description === 'string' ? input.description.trim().slice(0, 120) || null : null;
  if (input.first_ride_only !== undefined) out.first_ride_only = input.first_ride_only ? 1 : 0;
  if (input.active !== undefined) out.active = input.active ? 1 : 0;
  return { values: out };
}

export async function listPromos() {
  const [rows] = await pool.query(
    `SELECT p.*,
       (SELECT COUNT(*) FROM rides r WHERE r.promo_id = p.id AND r.status = 'completed') AS used,
       (SELECT COUNT(*) FROM rides r WHERE r.promo_id = p.id AND r.status NOT IN ('completed','cancelled')) AS in_progress,
       (SELECT COALESCE(SUM(r.discount), 0) FROM rides r WHERE r.promo_id = p.id AND r.status = 'completed') AS total_discount,
       (p.expires_at IS NOT NULL AND p.expires_at <= NOW()) AS expired
     FROM promo_codes p WHERE p.user_id IS NULL ORDER BY p.active DESC, p.id DESC`
  );
  return rows.map((p) => ({ ...p, used: Number(p.used), in_progress: Number(p.in_progress), total_discount: money(p.total_discount), expired: !!p.expired }));
}
