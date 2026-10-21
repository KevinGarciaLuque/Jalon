// Indicadores, reporte de dinero y exportación a CSV del panel (permisos 'metrics' y 'export')
import { pool } from '../db.js';
import { app } from '../app.js';
import { staffOnly, audit } from '../access.js';
import { HN } from '../services/earnings.js';
import { parseRange, metrics, finance, RangeError400 } from '../services/metrics.js';

const handle = (fn) => async (req, res, next) => {
  try {
    await fn(req, res);
  } catch (e) {
    if (e instanceof RangeError400) return res.status(400).json({ error: e.message });
    next(e);
  }
};

app.get('/api/admin/metrics', staffOnly('metrics'), handle(async (req, res) => {
  res.json(await metrics(await parseRange(req.query)));
}));

app.get('/api/admin/finance', staffOnly('metrics'), handle(async (req, res) => {
  res.json(await finance(await parseRange(req.query)));
}));

// ---------- Exportar a CSV ----------
// Cada exportación es del período elegido (por la fecha de creación) y queda anotada en el Registro, porque lleva datos personales.
const inDay = (col) => `DATE(${HN(col)}) BETWEEN ? AND ?`;
const at = (col) => `DATE_FORMAT(${HN(col)}, '%Y-%m-%d %H:%i')`;
const EXPORTS = {
  rides: {
    label: 'viajes',
    sql: `SELECT r.id AS viaje, ${at('r.created_at')} AS pedido, ${at('r.completed_at')} AS terminado, r.status AS estado, r.cancelled_by AS cancelado_por,
                 r.category AS categoria, p.name AS pasajero, d.name AS conductor, r.origin_text AS desde, r.dest_text AS hasta,
                 r.distance_km AS km, r.offered_price AS precio_ofrecido, r.final_price AS precio_final
          FROM rides r JOIN users p ON p.id = r.passenger_id LEFT JOIN users d ON d.id = r.driver_id WHERE ${inDay('r.created_at')} ORDER BY r.id`,
  },
  ledger: {
    label: 'movimientos-de-saldo',
    sql: `SELECT w.id AS movimiento, ${at('w.created_at')} AS fecha, u.name AS conductor, u.phone AS telefono, w.kind AS tipo, w.amount AS monto,
                 w.ride_id AS viaje, w.topup_id AS recarga, w.rental_id AS alquiler, w.note AS nota, s.name AS hecho_por
          FROM wallet_entries w JOIN users u ON u.id = w.user_id LEFT JOIN users s ON s.id = w.created_by WHERE ${inDay('w.created_at')} ORDER BY w.id`,
  },
  topups: {
    label: 'recargas',
    sql: `SELECT t.id AS recarga, ${at('t.created_at')} AS enviada, u.name AS conductor, u.phone AS telefono, t.amount AS monto_declarado, t.bank AS banco,
                 t.reference AS referencia, t.status AS estado, t.approved_amount AS monto_aprobado, ${at('t.reviewed_at')} AS revisada, r.name AS revisada_por, t.review_note AS nota
          FROM topups t JOIN users u ON u.id = t.driver_id LEFT JOIN users r ON r.id = t.reviewed_by WHERE ${inDay('t.created_at')} ORDER BY t.id`,
  },
  rentals: {
    label: 'alquileres',
    sql: `SELECT b.id AS alquiler, ${at('b.created_at')} AS pedido, DATE_FORMAT(b.start_date, '%Y-%m-%d') AS desde, DATE_FORMAT(b.end_date, '%Y-%m-%d') AS hasta,
                 b.days AS dias, b.status AS estado, b.payment AS pago, b.payment_status AS estado_pago, b.total, r.name AS cliente, r.phone AS telefono_cliente,
                 IF(b.owner_driver_id IS NULL, 'Flota de Ktracho GO', d.name) AS dueno, v.plate AS placa
          FROM rental_bookings b JOIN users r ON r.id = b.renter_id LEFT JOIN users d ON d.id = b.owner_driver_id JOIN vehicles v ON v.id = b.vehicle_id
          WHERE ${inDay('b.created_at')} ORDER BY b.id`,
  },
  users: {
    label: 'usuarios',
    sql: `SELECT u.id AS usuario, ${at('u.created_at')} AS registro, u.name AS nombre, u.phone AS telefono, u.email AS correo, u.role AS rol, u.status AS estado,
                 u.vehicle AS vehiculo, u.plate AS placa, IF(u.role = 'driver', u.balance, NULL) AS saldo
          FROM users u WHERE u.deleted_at IS NULL AND ${inDay('u.created_at')} ORDER BY u.id`,
  },
};

// Un valor de CSV: entre comillas si tiene coma, comillas o saltos de línea. Lo que empieza con = + - @ se antepone con ' para que Excel no lo ejecute como fórmula.
const cell = (v) => {
  if (v == null) return '';
  let s = v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s) && !/^-?\d+(\.\d+)?$/.test(s)) s = `'${s}`;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

app.get('/api/admin/export/:kind', staffOnly('export'), handle(async (req, res) => {
  const ex = EXPORTS[req.params.kind];
  if (!ex) return res.status(404).json({ error: 'No existe esa exportación' });
  const range = await parseRange(req.query);
  const [rows, fields] = await pool.query(`${ex.sql} LIMIT 50000`, [range.from, range.to]);
  await audit(req.staff, 'export.csv', { details: { kind: req.params.kind, from: range.from, to: range.to, rows: rows.length } });
  const header = fields.map((f) => f.name);
  const csv = [header.join(','), ...rows.map((r) => header.map((h) => cell(r[h])).join(','))].join('\r\n');
  res.set('Content-Type', 'text/csv; charset=utf-8');
  res.set('Content-Disposition', `attachment; filename="ktracho-go-${ex.label}-${range.from}-a-${range.to}.csv"`);
  res.set('Cache-Control', 'private, no-store');
  res.send(`﻿${csv}\r\n`); // la marca inicial hace que Excel lea bien las tildes
}));
