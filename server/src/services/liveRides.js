// Viajes en curso para el mapa en vivo del personal: etapa, cuánto del recorrido lleva, tiempo estimado y alertas.
// No guarda nada nuevo: usa lo que ya hay (estado del viaje, ruta, ubicación en vivo del conductor, emergencias y «¿Todo bien?»).
import { pool } from '../db.js';
import { distanceKm } from '../geo.js';
import { drivers } from '../live.js';

const KMH = 22; // velocidad promedio en la ciudad para estimar llegadas sin pedir rutas
const STAGES = ['accepted', 'arrived', 'started'];
const ALERT = { sos: 'Botón de emergencia', help: 'Pidió ayuda en «¿Todo bien?»', deviation: 'Se desvió de la ruta', stopped: 'Detenido mucho tiempo' };

// Distancia acumulada a lo largo de la ruta, y qué parte lleva el punto más cercano a `at`
function along(coords, at) {
  if (!Array.isArray(coords) || coords.length < 2) return null;
  const cum = [0];
  for (let i = 1; i < coords.length; i++) cum.push(cum[i - 1] + distanceKm(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
  const total = cum[cum.length - 1];
  if (!(total > 0)) return null;
  // Se proyecta el punto sobre cada tramo (en un plano local: en distancias de ciudad el error es mínimo) y se toma el más cercano
  const k = Math.cos((at.lat * Math.PI) / 180);
  let bestKm = 0;
  let bestD = Infinity;
  for (let i = 1; i < coords.length; i++) {
    const [ay, ax] = coords[i - 1];
    const [by, bx] = coords[i];
    const dx = (bx - ax) * k;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, (((at.lng - ax) * k) * dx + (at.lat - ay) * dy) / len2)) : 0;
    const px = ay + t * (by - ay);
    const py = ax + t * (bx - ax);
    const d = distanceKm(at.lat, at.lng, px, py);
    if (d < bestD) { bestD = d; bestKm = cum[i - 1] + t * (cum[i] - cum[i - 1]); }
  }
  return { fraction: bestKm / total, offRouteKm: bestD, totalKm: total };
}

// Ruta liviana para dibujarla en el mapa del panel (como mucho ~60 puntos)
const thin = (coords) => {
  if (!Array.isArray(coords)) return null;
  const step = Math.max(1, Math.ceil(coords.length / 60));
  const out = coords.filter((_, i) => i % step === 0);
  if (out[out.length - 1] !== coords[coords.length - 1]) out.push(coords[coords.length - 1]);
  return out;
};

export async function liveRides() {
  const [rows] = await pool.query(
    `SELECT r.id, r.kind, r.status, r.driver_id, r.passenger_id, r.origin_lat, r.origin_lng, r.origin_text, r.dest_lat, r.dest_lng, r.dest_text,
            r.distance_km, r.duration_min, r.route_json, r.offered_price, r.final_price, r.scheduled_for,
            TIMESTAMPDIFF(SECOND, IF(r.kind = 'intercity', r.updated_at, COALESCE(o.created_at, r.updated_at)), NOW()) AS sinceAccept, -- entre ciudades: desde que pasó a viaje normal
            TIMESTAMPDIFF(SECOND, r.updated_at, NOW()) AS sinceUpdate,
            TIMESTAMPDIFF(SECOND, r.started_at, NOW()) AS sinceStart,
            p.name AS passenger, d.name AS driver, d.plate, d.vehicle
       FROM rides r
       JOIN users p ON p.id = r.passenger_id
       LEFT JOIN users d ON d.id = r.driver_id
       LEFT JOIN offers o ON o.ride_id = r.id AND o.status = 'accepted'
      WHERE r.status IN ('accepted','arrived','started')
      ORDER BY r.id DESC LIMIT 100`
  );
  // Viajes entre ciudades reservados que salen en las próximas 24 horas
  const [soon] = await pool.query(
    `SELECT r.id, r.origin_text, r.dest_text, r.final_price, r.scheduled_for, TIMESTAMPDIFF(MINUTE, NOW(), r.scheduled_for) AS inMinutes,
            p.name AS passenger, d.name AS driver, d.plate
       FROM rides r JOIN users p ON p.id = r.passenger_id JOIN users d ON d.id = r.driver_id
      WHERE r.kind = 'intercity' AND r.status = 'booked' AND r.scheduled_for < NOW() + INTERVAL 1 DAY ORDER BY r.scheduled_for LIMIT 30`
  );
  const ids = rows.map((r) => r.id);
  const alerts = new Map();
  if (ids.length) {
    const [sos] = await pool.query("SELECT ride_id, reason FROM alerts WHERE status = 'open' AND ride_id IN (?)", [ids]);
    for (const a of sos) alerts.set(a.ride_id, a.reason || ALERT.sos);
    const [checks] = await pool.query(
      "SELECT ride_id, kind, answer FROM ride_safety_events WHERE ride_id IN (?) AND (answer IS NULL OR answer = 'help') ORDER BY id DESC", [ids]
    );
    for (const c of checks) if (!alerts.has(c.ride_id)) alerts.set(c.ride_id, c.answer === 'help' ? ALERT.help : ALERT[c.kind]);
  }

  const list = rows.map((r) => {
    const live = drivers.get(r.driver_id);
    const at = live?.lat != null ? { lat: live.lat, lng: live.lng } : null;
    const route = r.route_json ? JSON.parse(r.route_json) : null;
    const tripMin = Number(r.duration_min) || (Number(r.distance_km) / KMH) * 60;
    let progress = 0; // 0 a 100 del recorrido (solo en viaje)
    let etaMin = null; // minutos para llegar al origen (aceptado) o al destino (en viaje)
    let warn = null;
    if (r.status === 'accepted') {
      if (at) etaMin = Math.max(1, Math.round((distanceKm(at.lat, at.lng, r.origin_lat, r.origin_lng) / KMH) * 60));
      const waited = Math.round(r.sinceAccept / 60);
      if (waited >= Math.max(10, (etaMin || 0) * 2)) warn = `Lleva ${waited} min sin llegar a recoger`;
    } else if (r.status === 'arrived') {
      const waited = Math.round(r.sinceUpdate / 60);
      if (waited >= 10) warn = `El conductor espera hace ${waited} min`;
    } else {
      const pos = at && route ? along(route, at) : null;
      const byTime = r.sinceStart != null ? Math.min(0.99, r.sinceStart / 60 / Math.max(1, tripMin)) : 0;
      const fraction = pos ? pos.fraction : byTime; // sin señal del conductor, se estima por el tiempo
      progress = Math.round(Math.min(99, Math.max(1, fraction * 100)));
      etaMin = Math.max(1, Math.round(tripMin * (1 - fraction)));
      const took = Math.round((r.sinceStart || 0) / 60);
      if (took > tripMin * 1.8 + 5) warn = `Va lento: ${took} min de unos ${Math.round(tripMin)}`;
    }
    const alert = alerts.get(r.id) || null;
    return {
      id: r.id, kind: r.kind, status: r.status, stage: STAGES.indexOf(r.status), progress, etaMin,
      level: alert ? 'danger' : warn ? 'warn' : 'ok', alert, warn,
      passenger: r.passenger, driverId: r.driver_id, driver: r.driver, plate: r.plate, vehicle: r.vehicle,
      price: Number(r.final_price ?? r.offered_price), km: Math.round(Number(r.distance_km) * 10) / 10,
      origin: { lat: r.origin_lat, lng: r.origin_lng, text: r.origin_text }, dest: { lat: r.dest_lat, lng: r.dest_lng, text: r.dest_text },
      driverAt: at, signal: !!at && !live.disconnected, route: thin(route),
    };
  });
  // Primero las emergencias, luego los que van con retraso; dentro de cada grupo, los más avanzados al final
  const rank = { danger: 0, warn: 1, ok: 2 };
  list.sort((a, b) => rank[a.level] - rank[b.level] || a.stage - b.stage || b.id - a.id);
  return {
    rides: list,
    upcoming: soon.map((s) => ({ id: s.id, origin: s.origin_text, dest: s.dest_text, price: Number(s.final_price), departAt: s.scheduled_for, inMinutes: s.inMinutes, passenger: s.passenger, driver: s.driver, plate: s.plate })),
  };
}
