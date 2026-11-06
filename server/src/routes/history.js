// Historial de viajes con filtros, detalle de cada viaje (con su camino real) y ganancias del conductor
import { pool } from '../db.js';
import { app } from '../app.js';
import { authUser, driverOnly } from '../access.js';
import { ratingsOf } from '../services/rides.js';
import { trackOf, trackKm } from '../services/activity.js';
import { earnings, HN } from '../services/earnings.js';
import { money } from '../wallet.js';
import { CATEGORY_LABEL } from '../fares.js';

const PAGE = 20;
const FILTERS = { completed: "r.status = 'completed'", cancelled: "r.status = 'cancelled'" };

// Mis viajes, de 20 en 20 (before = el id del último que ya se mostró). Trae también lo gastado o ganado este mes.
app.get('/api/rides/mine', authUser, async (req, res) => {
  const id = req.user.id;
  const filter = FILTERS[req.query.status] || '1 = 1';
  const before = Number(req.query.before) || 0;
  const [rows] = await pool.query(
    `SELECT r.id, r.status, r.cancelled_by, r.category, r.origin_text, r.dest_text, r.distance_km, r.offered_price, r.final_price, r.discount, r.tip,
            r.created_at, r.completed_at, o.name AS other_name,
            (SELECT stars FROM ratings WHERE ride_id = r.id AND rater_id = ?) AS my_stars,
            (SELECT stars FROM ratings WHERE ride_id = r.id AND ratee_id = ?) AS their_stars
     FROM rides r LEFT JOIN users o ON o.id = IF(r.passenger_id = ?, r.driver_id, r.passenger_id)
     WHERE (r.passenger_id = ? OR r.driver_id = ?) AND ${filter} ${before ? 'AND r.id < ?' : ''}
     ORDER BY r.id DESC LIMIT ${PAGE + 1}`,
    [id, id, id, id, id, ...(before ? [before] : [])]
  );
  const col = req.user.role === 'driver' ? 'driver_id' : 'passenger_id';
  const [[month]] = await pool.query(
    `SELECT COUNT(*) AS n, COALESCE(SUM(final_price${req.user.role === 'driver' ? '' : ' - COALESCE(discount, 0)'} + COALESCE(tip, 0)), 0) AS total FROM rides
     WHERE ${col} = ? AND status = 'completed' AND DATE_FORMAT(${HN('completed_at')}, '%Y-%m') = DATE_FORMAT(${HN('NOW()')}, '%Y-%m')`, [id]
  );
  res.json({
    rides: rows.slice(0, PAGE),
    hasMore: rows.length > PAGE,
    month: { rides: Number(month.n), total: money(month.total) },
    rating: (await ratingsOf([id])).get(id) || { avg: null, count: 0 },
  });
});

// Detalle de un viaje para quienes participaron: datos, calificaciones, la ruta planeada y el camino real
app.get('/api/rides/:id/detail', authUser, async (req, res) => {
  const [[r]] = await pool.query(
    `SELECT r.*, TIMESTAMPDIFF(SECOND, r.started_at, r.completed_at) AS real_seconds, p.name AS passenger_name, d.name AS driver_name, d.vehicle, d.plate
     FROM rides r JOIN users p ON p.id = r.passenger_id LEFT JOIN users d ON d.id = r.driver_id WHERE r.id = ?`, [Number(req.params.id)]
  );
  if (!r || ![r.passenger_id, r.driver_id].includes(req.user.id)) return res.status(404).json({ error: 'Viaje no encontrado' });
  const me = req.user.id;
  const [ratings] = await pool.query('SELECT rater_id, stars, comment FROM ratings WHERE ride_id = ?', [r.id]);
  const track = await trackOf(r.id);
  res.json({
    id: r.id, status: r.status, cancelledBy: r.cancelled_by, category: r.category, categoryLabel: CATEGORY_LABEL[r.category],
    createdAt: r.created_at, startedAt: r.started_at, completedAt: r.completed_at,
    origin: { lat: r.origin_lat, lng: r.origin_lng, text: r.origin_text }, dest: { lat: r.dest_lat, lng: r.dest_lng, text: r.dest_text },
    plannedKm: r.distance_km, plannedMin: r.duration_min,
    route: r.route_json ? JSON.parse(r.route_json) : null,
    track, realKm: track.length > 1 ? trackKm(track) : null, realMin: r.real_seconds != null ? Math.round(r.real_seconds / 60) : null,
    offeredPrice: Number(r.offered_price), finalPrice: r.final_price == null ? null : Number(r.final_price), discount: r.discount == null ? 0 : Number(r.discount),
    tip: r.tip == null ? null : Number(r.tip),
    me: me === r.passenger_id ? 'passenger' : 'driver',
    other: me === r.passenger_id ? (r.driver_name ? { name: r.driver_name, vehicle: r.vehicle, plate: r.plate } : null) : { name: r.passenger_name },
    myRating: ratings.find((x) => x.rater_id === me) || null,
    theirRating: ratings.find((x) => x.rater_id !== me) || null,
  });
});

// Mis ganancias: hoy, esta semana o este mes
app.get('/api/driver/earnings', authUser, driverOnly, async (req, res) => {
  const period = ['day', 'week', 'month'].includes(req.query.period) ? req.query.period : 'day';
  res.json(await earnings(req.user.id, period));
});

// Mis propinas (conductor): lo de hoy, este mes y en total, y la lista de cada propina (de 20 en 20, lo más nuevo primero).
// range: 'month' (este mes), 'last' (mes pasado) o 'all'. Las fechas son de Honduras.
app.get('/api/driver/tips', authUser, driverOnly, async (req, res) => {
  const id = req.user.id;
  const range = ['month', 'last', 'all'].includes(req.query.range) ? req.query.range : 'month';
  const offset = Math.max(0, Math.min(10000, Number.parseInt(req.query.offset, 10) || 0));
  const day = `DATE(${HN('r.tipped_at')})`;
  const today = `DATE(${HN('NOW()')})`;
  const monthStart = `DATE_FORMAT(${today}, '%Y-%m-01')`;
  const where = {
    month: `${day} >= ${monthStart}`,
    last: `${day} >= ${monthStart} - INTERVAL 1 MONTH AND ${day} < ${monthStart}`,
    all: '1 = 1',
  }[range];
  const [[s]] = await pool.query(
    `SELECT COALESCE(SUM(IF(${day} = ${today}, r.tip, 0)), 0) AS today, COALESCE(SUM(IF(${day} = ${today}, 1, 0)), 0) AS today_n,
            COALESCE(SUM(IF(${day} >= ${monthStart}, r.tip, 0)), 0) AS month, COALESCE(SUM(IF(${day} >= ${monthStart}, 1, 0)), 0) AS month_n,
            COALESCE(SUM(r.tip), 0) AS total, COUNT(*) AS total_n
     FROM rides r WHERE r.driver_id = ? AND r.tip > 0`, [id]
  );
  const [[inRange]] = await pool.query(
    `SELECT COALESCE(SUM(r.tip), 0) AS amount, COUNT(*) AS n, COUNT(DISTINCT r.passenger_id) AS people FROM rides r WHERE r.driver_id = ? AND r.tip > 0 AND ${where}`, [id]
  );
  const [rows] = await pool.query(
    `SELECT r.id, r.tip, r.tipped_at, r.dest_text, r.final_price, u.name AS passenger
     FROM rides r LEFT JOIN users u ON u.id = r.passenger_id
     WHERE r.driver_id = ? AND r.tip > 0 AND ${where}
     ORDER BY r.tipped_at DESC, r.id DESC LIMIT ? OFFSET ?`, [id, PAGE + 1, offset]
  );
  res.json({
    range,
    summary: {
      today: money(s.today), todayCount: Number(s.today_n), month: money(s.month), monthCount: Number(s.month_n), total: money(s.total), totalCount: Number(s.total_n),
    },
    inRange: { amount: money(inRange.amount), count: Number(inRange.n), people: Number(inRange.people) },
    // Del pasajero solo el primer nombre (privacidad)
    tips: rows.slice(0, PAGE).map((r) => ({ rideId: r.id, amount: money(r.tip), at: r.tipped_at, dest: r.dest_text || null, fare: money(r.final_price), passenger: (r.passenger || 'Pasajero').split(/\s+/)[0] })),
    more: rows.length > PAGE,
    nextOffset: offset + PAGE,
  });
});
