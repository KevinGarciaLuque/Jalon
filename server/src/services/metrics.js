// Indicadores del negocio y reporte de dinero por fecha (hora de Honduras), con comparación contra el período anterior
import { pool } from '../db.js';
import { money } from '../wallet.js';
import { HN, periodRange } from './earnings.js';

export class RangeError400 extends Error {}

const isDate = (d) => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && new Date(`${d}T00:00:00Z`).toISOString().slice(0, 10) === d;
const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const daysBetween = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400e3);
export const datesBetween = (from, to) => Array.from({ length: daysBetween(from, to) + 1 }, (_, i) => addDays(from, i));

// Período pedido: un atajo (hoy, 7 días, 30 días, este mes, mes pasado) o fechas exactas. Máximo un año.
export async function parseRange({ preset, from, to }) {
  const { today } = await periodRange('day');
  let range;
  if (from || to) {
    if (!isDate(from) || !isDate(to) || from > to) throw new RangeError400('Elige una fecha de inicio y una de fin válidas');
    if (daysBetween(from, to) > 366) throw new RangeError400('El período puede ser de hasta un año');
    range = { from, to };
  } else if (preset === 'today') range = { from: today, to: today };
  else if (preset === '30d') range = { from: addDays(today, -29), to: today };
  else if (preset === 'month') range = { from: `${today.slice(0, 7)}-01`, to: today };
  else if (preset === 'prev_month') {
    const first = `${today.slice(0, 7)}-01`;
    const last = addDays(first, -1);
    range = { from: `${last.slice(0, 7)}-01`, to: last };
  } else range = { from: addDays(today, -6), to: today }; // 7 días
  const len = daysBetween(range.from, range.to) + 1;
  return { ...range, days: len, prev: { from: addDays(range.from, -len), to: addDays(range.from, -1) }, today };
}

const inDay = (col) => `DATE(${HN(col)}) BETWEEN ? AND ?`;

// Los números de un período
async function kpis(from, to) {
  const [[r]] = await pool.query(
    `SELECT
       (SELECT COUNT(*) FROM rides WHERE ${inDay('created_at')}) AS requested,
       (SELECT COUNT(*) FROM rides WHERE status = 'completed' AND ${inDay('completed_at')}) AS completed,
       (SELECT COALESCE(SUM(final_price), 0) FROM rides WHERE status = 'completed' AND ${inDay('completed_at')}) AS gmv,
       (SELECT COUNT(*) FROM rides WHERE status = 'cancelled' AND ${inDay('updated_at')}) AS cancelled,
       (SELECT COUNT(DISTINCT driver_id) FROM rides WHERE status = 'completed' AND ${inDay('completed_at')}) AS active_drivers,
       (SELECT COUNT(*) FROM users WHERE role = 'passenger' AND ${inDay('created_at')}) AS new_passengers,
       (SELECT COUNT(*) FROM users WHERE role = 'driver' AND ${inDay('created_at')}) AS new_drivers,
       (SELECT COUNT(*) FROM audit_log WHERE action = 'user.approve' AND ${inDay('created_at')}) AS approved_drivers,
       (SELECT COALESCE(-SUM(amount), 0) FROM wallet_entries WHERE kind IN ('commission','rental_commission') AND ${inDay('created_at')}) AS commission_cash,
       (SELECT COALESCE(SUM(b.total - COALESCE((SELECT SUM(w.amount) FROM wallet_entries w WHERE w.rental_id = b.id AND w.kind = 'rental_payout'), 0)), 0)
          FROM rental_bookings b WHERE b.status = 'completed' AND b.payment = 'transfer' AND b.owner_driver_id IS NOT NULL AND ${inDay('b.ended_at')}) AS commission_transfer,
       (SELECT AVG(TIMESTAMPDIFF(SECOND, r.created_at, (SELECT MIN(o.created_at) FROM offers o WHERE o.ride_id = r.id)))
          FROM rides r WHERE ${inDay('r.created_at')} AND EXISTS (SELECT 1 FROM offers o WHERE o.ride_id = r.id)) AS first_offer_seconds`,
    [from, to, from, to, from, to, from, to, from, to, from, to, from, to, from, to, from, to, from, to, from, to]
  );
  const done = Number(r.completed) + Number(r.cancelled);
  return {
    requested: Number(r.requested), completed: Number(r.completed), cancelled: Number(r.cancelled),
    cancelRate: done ? Math.round((Number(r.cancelled) / done) * 100) : null,
    gmv: money(r.gmv), commission: money(Number(r.commission_cash) + Number(r.commission_transfer)),
    activeDrivers: Number(r.active_drivers), newPassengers: Number(r.new_passengers), newDrivers: Number(r.new_drivers), approvedDrivers: Number(r.approved_drivers),
    firstOfferSeconds: r.first_offer_seconds == null ? null : Math.round(Number(r.first_offer_seconds)),
  };
}

export async function metrics(range) {
  const [now, before] = await Promise.all([kpis(range.from, range.to), kpis(range.prev.from, range.prev.to)]);
  // Quién cancela
  const [cancelBy] = await pool.query(
    `SELECT COALESCE(cancelled_by, 'system') AS who, COUNT(*) AS n FROM rides WHERE status = 'cancelled' AND ${inDay('updated_at')} GROUP BY who`, [range.from, range.to]
  );
  // Por día: completados, cancelados y dinero movido
  const [daily] = await pool.query(
    `SELECT d, SUM(completed) AS completed, SUM(cancelled) AS cancelled, SUM(gmv) AS gmv FROM (
       SELECT DATE_FORMAT(${HN('completed_at')}, '%Y-%m-%d') AS d, 1 AS completed, 0 AS cancelled, final_price AS gmv FROM rides WHERE status = 'completed' AND ${inDay('completed_at')}
       UNION ALL
       SELECT DATE_FORMAT(${HN('updated_at')}, '%Y-%m-%d'), 0, 1, 0 FROM rides WHERE status = 'cancelled' AND ${inDay('updated_at')}
     ) t GROUP BY d`, [range.from, range.to, range.from, range.to]
  );
  const byDay = new Map(daily.map((x) => [x.d, x]));
  // Horas pico: a qué hora se piden los viajes
  const [hours] = await pool.query(`SELECT HOUR(${HN('created_at')}) AS h, COUNT(*) AS n FROM rides WHERE ${inDay('created_at')} GROUP BY h`, [range.from, range.to]);
  const byHour = new Map(hours.map((x) => [Number(x.h), Number(x.n)]));
  return {
    range, kpis: now, previous: before,
    cancelledBy: Object.fromEntries(cancelBy.map((c) => [c.who, Number(c.n)])),
    daily: datesBetween(range.from, range.to).map((d) => ({ date: d, completed: Number(byDay.get(d)?.completed || 0), cancelled: Number(byDay.get(d)?.cancelled || 0), gmv: money(byDay.get(d)?.gmv || 0) })),
    hours: Array.from({ length: 24 }, (_, h) => ({ hour: h, requested: byHour.get(h) || 0 })),
  };
}

// Reporte de dinero: lo que entró a Jalón y lo que se movió en los saldos de los conductores, por día
export async function finance(range) {
  const { from, to } = range;
  const [ledger] = await pool.query(
    `SELECT DATE_FORMAT(${HN('created_at')}, '%Y-%m-%d') AS d, kind, SUM(amount) AS total, COUNT(*) AS n
     FROM wallet_entries WHERE ${inDay('created_at')} GROUP BY d, kind`, [from, to]
  );
  const [rentals] = await pool.query(
    `SELECT DATE_FORMAT(${HN('ended_at')}, '%Y-%m-%d') AS d, payment, owner_driver_id IS NULL AS fleet, SUM(total) AS total, COUNT(*) AS n
     FROM rental_bookings WHERE status = 'completed' AND ${inDay('ended_at')} GROUP BY d, payment, fleet`, [from, to]
  );
  const [[bal]] = await pool.query("SELECT COALESCE(SUM(balance), 0) AS total, COUNT(*) AS n FROM users WHERE role = 'driver' AND deleted_at IS NULL");
  const empty = () => ({ commission: 0, rentalCommission: 0, topups: 0, bonuses: 0, adjustments: 0, rentalPayouts: 0, rentalsCash: 0, rentalsTransfer: 0, fleetRentals: 0 });
  const rows = new Map(datesBetween(from, to).map((d) => [d, { date: d, ...empty() }]));
  const add = (d, k, v) => { const row = rows.get(d); if (row) row[k] = money(row[k] + Number(v)); };
  for (const l of ledger) {
    const key = { commission: 'commission', rental_commission: 'rentalCommission', topup: 'topups', bonus: 'bonuses', adjustment: 'adjustments', rental_payout: 'rentalPayouts' }[l.kind];
    // Las comisiones se guardan en negativo (salen del saldo del conductor): aquí se muestran como lo que entra a Jalón
    if (key) add(l.d, key, ['commission', 'rental_commission'].includes(l.kind) ? -l.total : l.total);
  }
  for (const r of rentals) {
    if (Number(r.fleet)) add(r.d, 'fleetRentals', r.total);
    else add(r.d, r.payment === 'cash' ? 'rentalsCash' : 'rentalsTransfer', r.total);
  }
  const days = [...rows.values()];
  const totals = days.reduce((acc, d) => { for (const k of Object.keys(acc)) acc[k] = money(acc[k] + d[k]); return acc; }, empty());
  return { range, days, totals, driversBalance: { total: money(bal.total), drivers: Number(bal.n) } };
}
