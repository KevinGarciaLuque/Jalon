// Referidos: cada pasajero y conductor tiene un código para invitar. El invitado se registra con él y,
// cuando viaja (el pasajero termina su primer viaje; el conductor, sus primeros N), quien lo invitó gana su premio:
// un código de descuento personal si es pasajero, o saldo si es conductor. El pasajero invitado recibe además
// un código de bienvenida para su primer viaje. Apagado hasta que el superadmin lo active, y solo con la comisión activa
// (los descuentos se le pagan al conductor en su saldo, como los códigos promocionales).
import crypto from 'crypto';
import { pool } from '../db.js';
import { getSettings, postEntry, money } from '../wallet.js';
import { tellWallet } from './balance.js';
import { createPersonalPromo } from './promos.js';
import { push } from '../notify.js';
import { serial } from '../util.js';

const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const normalizeReferral = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
export const firstName = (name) => String(name || '').trim().split(/\s+/)[0] || '';
const amount = (v) => `L ${Number(v).toLocaleString('es-HN', { maximumFractionDigits: 2 })}`;

export async function referralsOn(db = pool) {
  const s = await getSettings(db);
  return s.referral_enabled === '1' && s.commission_enabled === '1';
}

// El código de la persona (se crea la primera vez que abre «Invita y gana»): hasta 5 letras de su nombre y 3 al azar
export async function referralCodeOf(user) {
  const [[row]] = await pool.query('SELECT referral_code, name FROM users WHERE id = ?', [user.id]);
  if (row?.referral_code) return row.referral_code;
  const base = firstName(row?.name).normalize('NFD').replace(/[^A-Za-z]/g, '').toUpperCase().slice(0, 5) || 'KT';
  for (let i = 0; i < 8; i++) {
    const code = base + Array.from(crypto.randomBytes(3), (b) => LETTERS[b % LETTERS.length]).join('');
    try {
      const [r] = await pool.query('UPDATE users SET referral_code = ? WHERE id = ? AND referral_code IS NULL', [code, user.id]);
      if (r.affectedRows) return code;
      const [[again]] = await pool.query('SELECT referral_code FROM users WHERE id = ?', [user.id]); // otro pedido lo creó justo antes
      if (again?.referral_code) return again.referral_code;
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
    }
  }
  throw new Error('No se pudo crear el código de invitación');
}

// Quién tiene este código (solo pasajeros y conductores con la cuenta en orden)
export async function findReferrer(code, db = pool) {
  const c = normalizeReferral(code);
  if (c.length < 4) return null;
  const [[u]] = await db.query("SELECT id, name, role FROM users WHERE referral_code = ? AND role IN ('passenger','driver') AND status <> 'blocked'", [c]);
  return u || null;
}

// Al registrarse con un código: se anota la invitación y el pasajero recibe su código de bienvenida (en la misma transacción)
export async function attachReferral(conn, { referrer, userId, role }) {
  const [r] = await conn.query('INSERT INTO referrals (referrer_id, referred_id, referred_role) VALUES (?,?,?)', [referrer.id, userId, role]);
  const welcome = Number((await getSettings(conn)).referral_welcome);
  if (role === 'passenger' && welcome > 0) {
    const promo = await createPersonalPromo(conn, {
      userId, amount: welcome, firstRideOnly: true,
      description: `Bienvenida de parte de ${firstName(referrer.name)}: ${amount(welcome)} menos en tu primer viaje`,
    });
    await conn.query('UPDATE referrals SET welcome_promo_id = ? WHERE id = ?', [promo.id, r.insertId]);
  }
}

// Al terminar un viaje: ¿con él alguien ganó su premio por invitar?
export async function checkReferrals(ride) {
  if (!ride?.driver_id || !(await referralsOn())) return;
  const s = await getSettings(pool);
  // El pasajero invitado terminó su primer viaje (con un conductor que no es quien lo invitó)
  const [[asPassenger]] = await pool.query("SELECT * FROM referrals WHERE referred_id = ? AND referred_role = 'passenger' AND status = 'pending'", [ride.passenger_id]);
  if (asPassenger && asPassenger.referrer_id !== ride.driver_id) await reward(asPassenger.id);
  // El conductor invitado ya terminó sus primeros N viajes (sin contar los que hizo con quien lo invitó)
  const [[asDriver]] = await pool.query("SELECT * FROM referrals WHERE referred_id = ? AND referred_role = 'driver' AND status = 'pending'", [ride.driver_id]);
  if (asDriver) {
    const [[{ n }]] = await pool.query("SELECT COUNT(*) AS n FROM rides WHERE driver_id = ? AND status = 'completed' AND passenger_id <> ?", [ride.driver_id, asDriver.referrer_id]);
    if (n >= Number(s.referral_driver_rides)) await reward(asDriver.id);
  }
}

// Paga el premio una sola vez: código de descuento (pasajero) o saldo (conductor), con el tope de premios por mes
export function reward(referralId) {
  return serial(`referral:${referralId}`, async () => {
    const s = await getSettings(pool);
    const [[ref]] = await pool.query(
      `SELECT f.*, a.role AS referrer_role, a.status AS referrer_status, b.name AS referred_name
       FROM referrals f JOIN users a ON a.id = f.referrer_id JOIN users b ON b.id = f.referred_id WHERE f.id = ?`, [referralId]
    );
    if (!ref || ref.status !== 'pending') return;
    const reject = (reason) => pool.query("UPDATE referrals SET status = 'rejected', reason = ? WHERE id = ? AND status = 'pending'", [reason, ref.id]);
    if (ref.referrer_status === 'blocked') return reject('La cuenta de quien invitó está bloqueada');
    const [[{ n }]] = await pool.query(
      "SELECT COUNT(*) AS n FROM referrals WHERE referrer_id = ? AND status = 'rewarded' AND rewarded_at >= DATE_FORMAT(NOW(), '%Y-%m-01')", [ref.referrer_id]
    );
    if (n >= Number(s.referral_monthly_max)) return reject('Ya ganó el máximo de premios de este mes');
    const value = money(s.referral_reward);
    const who = firstName(ref.referred_name);
    if (ref.referrer_role === 'driver') {
      const [moved] = await pool.query("UPDATE referrals SET status = 'rewarded', reward_kind = 'wallet', reward_amount = ?, rewarded_at = NOW() WHERE id = ? AND status = 'pending'", [value, ref.id]);
      if (!moved.affectedRows) return;
      try {
        const balance = await postEntry(pool, { userId: ref.referrer_id, amount: value, kind: 'referral', note: `Premio por invitar a ${who} a Ktracho GO` });
        if (balance !== null) tellWallet(ref.referrer_id, balance, { change: value, kind: 'referral' });
      } catch (e) {
        await pool.query("UPDATE referrals SET status = 'pending', reward_kind = NULL, reward_amount = NULL, rewarded_at = NULL WHERE id = ?", [ref.id]);
        throw e;
      }
      push(ref.referrer_id, { title: '🎁 ¡Ganaste tu premio por invitar!', body: `${who} ya viaja con Ktracho GO: te pusimos ${amount(value)} en tu saldo.`, tag: `referral-${ref.id}`, url: '/' });
    } else {
      const conn = await pool.getConnection();
      try {
        await conn.beginTransaction();
        const [moved] = await conn.query("UPDATE referrals SET status = 'rewarded', reward_kind = 'promo', reward_amount = ?, rewarded_at = NOW() WHERE id = ? AND status = 'pending'", [value, ref.id]);
        if (!moved.affectedRows) { await conn.rollback(); return; }
        const promo = await createPersonalPromo(conn, { userId: ref.referrer_id, amount: value, description: `Premio por invitar a ${who}: ${amount(value)} menos en tu viaje` });
        await conn.query('UPDATE referrals SET reward_promo_id = ? WHERE id = ?', [promo.id, ref.id]);
        await conn.commit();
      } catch (e) {
        await conn.rollback().catch(() => {});
        throw e;
      } finally {
        conn.release();
      }
      push(ref.referrer_id, { title: '🎁 ¡Ganaste tu premio por invitar!', body: `${who} ya viajó con Ktracho GO: tienes ${amount(value)} de descuento en tu próximo viaje.`, tag: `referral-${ref.id}`, url: '/' });
    }
  });
}

// Lo que ve cada persona en «Invita y gana»
export async function myReferrals(userId) {
  const [rows] = await pool.query(
    `SELECT f.id, f.referred_role, f.status, f.reason, f.reward_kind, f.reward_amount, f.created_at, f.rewarded_at, u.name
     FROM referrals f JOIN users u ON u.id = f.referred_id WHERE f.referrer_id = ? ORDER BY f.id DESC LIMIT 100`, [userId]
  );
  return rows.map((r) => ({
    id: r.id, name: firstName(r.name), role: r.referred_role, status: r.status, reason: r.reason,
    rewardKind: r.reward_kind, reward: r.reward_amount == null ? null : Number(r.reward_amount), createdAt: r.created_at, rewardedAt: r.rewarded_at,
  }));
}

// Para el panel: todas las invitaciones y lo pagado
export async function listReferrals({ limit = 200, offset = 0 } = {}) {
  const [rows] = await pool.query(
    `SELECT f.*, a.name AS referrer_name, a.phone AS referrer_phone, b.name AS referred_name, b.phone AS referred_phone
     FROM referrals f JOIN users a ON a.id = f.referrer_id JOIN users b ON b.id = f.referred_id
     ORDER BY f.id DESC LIMIT ? OFFSET ?`, [limit, offset]
  );
  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS total, SUM(status = 'pending') AS pending, SUM(status = 'rewarded') AS rewarded,
       COALESCE(SUM(IF(status = 'rewarded' AND reward_kind = 'wallet', reward_amount, 0)), 0) AS wallet_paid,
       (SELECT COALESCE(SUM(r.discount), 0) FROM rides r JOIN promo_codes p ON p.id = r.promo_id
        WHERE r.status = 'completed' AND p.id IN (SELECT reward_promo_id FROM referrals UNION SELECT welcome_promo_id FROM referrals)) AS discounts_paid
     FROM referrals`
  );
  return {
    referrals: rows.map((r) => ({ ...r, reward_amount: r.reward_amount == null ? null : Number(r.reward_amount) })),
    totals: { total: Number(t.total), pending: Number(t.pending) || 0, rewarded: Number(t.rewarded) || 0, walletPaid: money(t.wallet_paid), discountsPaid: money(t.discounts_paid) },
  };
}
