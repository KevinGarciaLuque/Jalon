// Ganancias del conductor por día, semana o mes (en hora de Honduras, UTC−6, sin horario de verano).
// Las fechas se calculan dentro de MySQL: así da igual en qué zona horaria esté el servidor de la base (local o Railway).
import { pool } from '../db.js';
import { money } from '../wallet.js';

// Convierte una columna TIMESTAMP a la hora de Honduras
export const HN = (col) => `CONVERT_TZ(${col}, @@session.time_zone, '-06:00')`;
// Inicio de un día de Honduras (AAAA-MM-DD) expresado en la hora de la sesión, para comparar con columnas TIMESTAMP
const dayStart = (param) => `CONVERT_TZ(CONCAT(${param}, ' 00:00:00'), '-06:00', @@session.time_zone)`;

// Fechas del período (texto AAAA-MM-DD): hoy, la semana (de lunes a domingo) o el mes
export async function periodRange(period) {
  const [[d]] = await pool.query(
    `SELECT DATE_FORMAT(t.d, '%Y-%m-%d') AS today,
            DATE_FORMAT(t.d - INTERVAL WEEKDAY(t.d) DAY, '%Y-%m-%d') AS week_start,
            DATE_FORMAT(t.d - INTERVAL WEEKDAY(t.d) DAY + INTERVAL 6 DAY, '%Y-%m-%d') AS week_end,
            DATE_FORMAT(t.d, '%Y-%m-01') AS month_start, DATE_FORMAT(LAST_DAY(t.d), '%Y-%m-%d') AS month_end
     FROM (SELECT DATE(${HN('NOW()')}) AS d) t`
  );
  if (period === 'week') return { from: d.week_start, to: d.week_end, today: d.today };
  if (period === 'month') return { from: d.month_start, to: d.month_end, today: d.today };
  return { from: d.today, to: d.today, today: d.today };
}

const datesBetween = (from, to) => {
  const out = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= Date.parse(`${to}T00:00:00Z`); t += 86400e3) out.push(new Date(t).toISOString().slice(0, 10));
  return out;
};

// Segundos conectado de un conductor entre dos fechas de Honduras (las sesiones abiertas cuentan hasta ahora)
export async function connectedSeconds(driverId, from, to) {
  const [[r]] = await pool.query(
    `SELECT COALESCE(SUM(GREATEST(0, TIMESTAMPDIFF(SECOND, GREATEST(started_at, ${dayStart('?')}),
              LEAST(COALESCE(ended_at, NOW()), ${dayStart('?')} + INTERVAL 1 DAY)))), 0) AS s
     FROM driver_sessions WHERE driver_id = ? AND started_at < ${dayStart('?')} + INTERVAL 1 DAY AND COALESCE(ended_at, NOW()) > ${dayStart('?')}`,
    [from, to, driverId, to, from]
  );
  return Number(r.s);
}

export async function earnings(driverId, period) {
  const { from, to, today } = await periodRange(period);
  const inRange = `DATE(${HN('r.completed_at')}) BETWEEN ? AND ?`;
  const [[t]] = await pool.query(
    `SELECT COUNT(*) AS rides, COALESCE(SUM(r.final_price), 0) AS gross, COALESCE(SUM(r.distance_km), 0) AS km,
            COALESCE((SELECT -SUM(w.amount) FROM wallet_entries w JOIN rides x ON x.id = w.ride_id
                      WHERE w.user_id = ? AND w.kind = 'commission' AND x.driver_id = ? AND DATE(${HN('x.completed_at')}) BETWEEN ? AND ?), 0) AS commission
     FROM rides r WHERE r.driver_id = ? AND r.status = 'completed' AND ${inRange}`,
    [driverId, driverId, from, to, driverId, from, to]
  );
  // Por hora (hoy) o por día (semana y mes), para el gráfico
  const bucket = period === 'day' ? `HOUR(${HN('r.completed_at')})` : `DATE_FORMAT(${HN('r.completed_at')}, '%Y-%m-%d')`;
  const [rows] = await pool.query(
    `SELECT ${bucket} AS k, COUNT(*) AS rides, SUM(r.final_price) AS gross FROM rides r
     WHERE r.driver_id = ? AND r.status = 'completed' AND ${inRange} GROUP BY k`,
    [driverId, from, to]
  );
  const byKey = new Map(rows.map((r) => [String(r.k), r]));
  const keys = period === 'day' ? Array.from({ length: 24 }, (_, h) => String(h)) : datesBetween(from, to);
  const series = keys.map((k) => ({ key: k, rides: Number(byKey.get(k)?.rides || 0), gross: money(byKey.get(k)?.gross || 0) }));
  // Alquileres de su carro terminados en el período (efectivo: él cobró; transferencia: se le acreditó)
  const [[rent]] = await pool.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(b.total), 0) AS gross,
            COALESCE(SUM((SELECT -SUM(w.amount) FROM wallet_entries w WHERE w.rental_id = b.id AND w.kind = 'rental_commission')), 0) AS commission,
            COALESCE(SUM(IF(b.payment = 'transfer', b.total - (SELECT COALESCE(SUM(w.amount), 0) FROM wallet_entries w WHERE w.rental_id = b.id AND w.kind = 'rental_payout'), 0)), 0) AS transfer_commission
     FROM rental_bookings b WHERE b.owner_driver_id = ? AND b.status = 'completed' AND DATE(${HN('b.ended_at')}) BETWEEN ? AND ?`,
    [driverId, from, to]
  );
  const seconds = await connectedSeconds(driverId, from, to);
  const gross = money(t.gross);
  const commission = money(t.commission);
  const rentalCommission = money(Number(rent.commission) + Number(rent.transfer_commission));
  const net = money(gross - commission + Number(rent.gross) - rentalCommission);
  const hours = Math.round((seconds / 3600) * 10) / 10;
  return {
    period, from, to, today,
    rides: Number(t.rides), gross, commission, km: Math.round(Number(t.km) * 10) / 10,
    avgPerRide: t.rides ? money(gross / t.rides) : 0,
    rentals: { count: Number(rent.n), gross: money(rent.gross), commission: rentalCommission },
    net, hours, perHour: seconds >= 600 ? money(net / (seconds / 3600)) : null, // con menos de 10 min conectado no se calcula
    series,
  };
}
