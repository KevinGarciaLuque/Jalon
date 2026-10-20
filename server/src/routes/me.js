// Lo que hace una persona con su sesión: sus datos, lugares, contactos, viajes, reportes, notificaciones y el mapa
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from '../db.js';
import { distanceKm } from '../geo.js';
import { getSettings } from '../wallet.js';
import { faresFor } from '../fares.js';
import { searchPlaces, reversePlace, getRoute } from '../maps.js';
import { normalizePhone } from '../phone.js';
import { validEndpoint, publicKey as vapidPublicKey } from '../push.js';
import { isProd, REPORT_TYPES } from '../config.js';
import { app, io, loginLimiter, mapsLimiter, trackLimiter } from '../app.js';
import { drivers, room } from '../live.js';
import { isPoint, clean, num, parsePoint } from '../util.js';
import { sign, authUser, passengerOnly, isStaff, audit } from '../access.js';
import { pushStaff } from '../notify.js';
import { getRide, activeRideFor, ratingsOf } from '../services/rides.js';
import { anonymizeUser } from '../services/accounts.js';

// ---------- Derechos del usuario sobre sus datos ----------
// Descargar todo lo que la plataforma guarda de la persona (JSON). Las imágenes de los documentos no se incluyen: se piden a soporte.
app.get('/api/me/export', authUser, async (req, res) => {
  const u = req.user;
  const id = u.id;
  const [rides] = await pool.query(
    `SELECT r.id, r.status, r.cancelled_by, r.origin_text, r.dest_text, r.origin_lat, r.origin_lng, r.dest_lat, r.dest_lng,
            r.distance_km, r.duration_min, r.offered_price, r.final_price, r.created_at,
            IF(r.passenger_id = ?, 'pasajero', 'conductor') AS mi_rol, o.name AS otra_persona
     FROM rides r LEFT JOIN users o ON o.id = IF(r.passenger_id = ?, r.driver_id, r.passenger_id)
     WHERE r.passenger_id = ? OR r.driver_id = ? ORDER BY r.id`, [id, id, id, id]
  );
  const [given] = await pool.query('SELECT ride_id, stars, comment, created_at FROM ratings WHERE rater_id = ? ORDER BY id', [id]);
  const [received] = await pool.query('SELECT ride_id, stars, comment, created_at FROM ratings WHERE ratee_id = ? ORDER BY id', [id]);
  const [alerts] = await pool.query('SELECT ride_id, lat, lng, status, created_at FROM alerts WHERE user_id = ? ORDER BY id', [id]);
  const [docs] = await pool.query('SELECT type, status, note, created_at FROM documents WHERE user_id = ?', [id]);
  const [msgs] = await pool.query('SELECT ride_id, text, created_at FROM messages WHERE sender_id = ? ORDER BY id', [id]);
  const [favs] = await pool.query('SELECT label, text, lat, lng FROM favorite_places WHERE user_id = ? ORDER BY id', [id]);
  const [contacts] = await pool.query('SELECT name, phone FROM trusted_contacts WHERE user_id = ? ORDER BY id', [id]);
  const [reps] = await pool.query('SELECT ride_id, type, text, status, resolution, created_at FROM reports WHERE user_id = ? ORDER BY id', [id]);
  const [moves] = await pool.query('SELECT amount, kind, ride_id, note, created_at FROM wallet_entries WHERE user_id = ? ORDER BY id', [id]);
  const [tops] = await pool.query('SELECT amount, bank, reference, status, approved_amount, review_note, created_at FROM topups WHERE driver_id = ? ORDER BY id', [id]);
  const [rentals] = await pool.query("SELECT id, IF(renter_id = ?, 'alquilé', 'alquilaron mi carro') AS rol, DATE_FORMAT(start_date, '%Y-%m-%d') AS desde, DATE_FORMAT(end_date, '%Y-%m-%d') AS hasta, days AS dias, total, payment AS pago, status AS estado, pickup_text AS recogida, created_at AS fecha FROM rental_bookings WHERE renter_id = ? OR owner_driver_id = ? ORDER BY id", [id, id, id]);
  res.set('Content-Disposition', 'attachment; filename="mis-datos-jalon.json"');
  res.json({
    generadoEl: new Date().toISOString(),
    cuenta: { nombre: u.name, telefono: u.phone, correo: u.email, rol: u.role, estado: u.status, vehiculo: u.vehicle, placa: u.plate, registradoEl: u.created_at, aceptoTerminosEl: u.terms_accepted_at, versionTerminos: u.terms_version },
    viajes: rides, calificacionesQueDi: given, calificacionesQueRecibi: received, alertasDeEmergencia: alerts,
    documentos: docs.map((d) => ({ tipo: d.type, estado: d.status, nota: d.note, subidoEl: d.created_at })),
    mensajesQueEnvie: msgs.map((m) => ({ viaje: m.ride_id, texto: m.text, enviadoEl: m.created_at })),
    saldo: Number(u.balance || 0),
    movimientosDeSaldo: moves.map((m) => ({ monto: Number(m.amount), tipo: m.kind, viaje: m.ride_id, nota: m.note, fecha: m.created_at })),
    alquileres: rentals.map((r) => ({ ...r, total: Number(r.total) })),
    recargas: tops.map((t) => ({ monto: Number(t.amount), banco: t.bank, referencia: t.reference, estado: t.status, montoAprobado: t.approved_amount == null ? null : Number(t.approved_amount), nota: t.review_note, fecha: t.created_at })),
    lugaresFavoritos: favs,
    contactosDeConfianza: contacts,
    reportes: reps.map((r) => ({ viaje: r.ride_id, tipo: r.type, texto: r.text, estado: r.status, respuesta: r.resolution, creadoEl: r.created_at })),
  });
});

// Eliminar la propia cuenta (pide la contraseña). No se puede con un viaje en curso. El personal no se elimina solo: lo hace el superadmin.
app.post('/api/me/delete', authUser, loginLimiter, async (req, res) => {
  const u = req.user;
  if (isStaff(u.role)) return res.status(403).json({ error: 'Las cuentas del personal las elimina el superadministrador' });
  if (typeof req.body?.password !== 'string' || !(await bcrypt.compare(req.body.password, u.password_hash)))
    return res.status(403).json({ error: 'La contraseña es incorrecta' });
  if (await activeRideFor(u)) return res.status(409).json({ error: 'Tienes un viaje en curso. Termínalo o cancélalo antes de eliminar tu cuenta.' });
  await anonymizeUser(u);
  await audit(u, 'user.self_delete', { target: u.id, details: { role: u.role } });
  res.json({ ok: true });
});

// ---------- Lugares favoritos (casa, trabajo...) ----------
app.get('/api/favorites', authUser, async (req, res) => {
  const [rows] = await pool.query('SELECT id, label, text, lat, lng FROM favorite_places WHERE user_id = ? ORDER BY id', [req.user.id]);
  res.json(rows);
});

app.post('/api/favorites', authUser, async (req, res) => {
  const label = clean(req.body?.label)?.slice(0, 40);
  const text = clean(req.body?.text);
  const { lat, lng } = req.body || {};
  if (!label || !text || !isPoint({ lat, lng })) return res.status(400).json({ error: 'Falta el nombre o el lugar' });
  const [[mine]] = await pool.query('SELECT COUNT(*) AS n, SUM(label = ?) AS same FROM favorite_places WHERE user_id = ?', [label, req.user.id]);
  if (mine.n >= 10 && !Number(mine.same)) return res.status(409).json({ error: 'Puedes guardar hasta 10 lugares. Borra alguno para agregar otro.' });
  // Con el mismo nombre se actualiza (p. ej. cambiar "Casa" de lugar)
  await pool.query(
    'INSERT INTO favorite_places (user_id, label, text, lat, lng) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE text = VALUES(text), lat = VALUES(lat), lng = VALUES(lng)',
    [req.user.id, label, text, lat, lng]
  );
  res.json({ ok: true });
});

app.delete('/api/favorites/:id', authUser, async (req, res) => {
  await pool.query('DELETE FROM favorite_places WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
  res.json({ ok: true });
});

// ---------- Contactos de confianza (reciben el enlace del viaje al empezar) ----------

app.get('/api/contacts', authUser, passengerOnly, async (req, res) => {
  const [rows] = await pool.query('SELECT id, name, phone FROM trusted_contacts WHERE user_id = ? ORDER BY id', [req.user.id]);
  res.json(rows);
});

app.post('/api/contacts', authUser, passengerOnly, async (req, res) => {
  const name = clean(req.body?.name)?.slice(0, 60);
  const phone = normalizePhone(req.body?.phone);
  if (!name || !phone) return res.status(400).json({ error: 'Escribe un nombre y un teléfono válido (8 dígitos)' });
  if (phone === req.user.phone) return res.status(400).json({ error: 'Ese es tu propio teléfono' });
  const [[mine]] = await pool.query('SELECT COUNT(*) AS n FROM trusted_contacts WHERE user_id = ?', [req.user.id]);
  if (mine.n >= 3) return res.status(409).json({ error: 'Puedes tener hasta 3 contactos de confianza' });
  try {
    const [r] = await pool.query('INSERT INTO trusted_contacts (user_id, name, phone) VALUES (?,?,?)', [req.user.id, name, phone]);
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ese contacto ya está en tu lista' });
    throw e;
  }
});

app.delete('/api/contacts/:id', authUser, passengerOnly, async (req, res) => {
  await pool.query('DELETE FROM trusted_contacts WHERE id = ? AND user_id = ?', [Number(req.params.id), req.user.id]);
  res.json({ ok: true });
});

// ---------- Recibo del viaje ----------
app.get('/api/rides/:id/receipt', authUser, async (req, res) => {
  const ride = await getRide(Number(req.params.id));
  if (!ride || ![ride.passenger_id, ride.driver_id].includes(req.user.id)) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (ride.status !== 'completed') return res.status(409).json({ error: 'Solo los viajes completados tienen recibo' });
  const [[p]] = await pool.query('SELECT name FROM users WHERE id = ?', [ride.passenger_id]);
  const [[d]] = await pool.query('SELECT name, vehicle, plate FROM users WHERE id = ?', [ride.driver_id]);
  res.json({
    number: `JAL-${String(ride.id).padStart(6, '0')}`,
    date: ride.created_at, endedAt: ride.updated_at,
    passenger: p.name, driver: d.name, vehicle: d.vehicle, plate: d.plate,
    origin: ride.origin_text, dest: ride.dest_text,
    distanceKm: ride.distance_km, durationMin: ride.duration_min,
    price: Number(ride.final_price), payment: 'Efectivo',
  });
});

// ---------- Reportes: un problema con un viaje, un cobro, un objeto olvidado ----------

app.post('/api/rides/:id/report', authUser, async (req, res) => {
  const ride = await getRide(Number(req.params.id));
  if (!ride || ![ride.passenger_id, ride.driver_id].includes(req.user.id) || !ride.driver_id) return res.status(404).json({ error: 'Viaje no encontrado' });
  const type = req.body?.type;
  const text = typeof req.body?.text === 'string' ? req.body.text.trim().slice(0, 1000) : '';
  if (!REPORT_TYPES[type]) return res.status(400).json({ error: 'Elige el tipo de problema' });
  if (text.length < 5) return res.status(400).json({ error: 'Cuéntanos qué pasó (al menos unas palabras)' });
  const [[recent]] = await pool.query('SELECT COUNT(*) AS n FROM reports WHERE user_id = ? AND created_at > NOW() - INTERVAL 24 HOUR', [req.user.id]);
  if (recent.n >= 5) return res.status(429).json({ error: 'Ya enviaste varios reportes hoy. El equipo los está revisando.' });
  const [r] = await pool.query('INSERT INTO reports (ride_id, user_id, type, text) VALUES (?,?,?,?)', [ride.id, req.user.id, type, text]);
  pushStaff({ title: 'Nuevo reporte', body: `${REPORT_TYPES[type]} · viaje #${ride.id}`, tag: `report-${r.insertId}`, url: '/' }, 'alerts');
  res.json({ ok: true, id: r.insertId });
});

app.get('/api/reports/mine', authUser, async (req, res) => {
  const [rows] = await pool.query('SELECT id, ride_id, type, text, status, resolution, created_at FROM reports WHERE user_id = ? ORDER BY id DESC LIMIT 50', [req.user.id]);
  res.json(rows);
});

// ---------- Suscripción a notificaciones ----------
app.get('/api/push/key', authUser, (_req, res) => res.json({ key: vapidPublicKey })); // null = el servidor no tiene notificaciones configuradas

app.post('/api/push/subscribe', authUser, async (req, res) => {
  const { endpoint, keys } = req.body?.subscription || {};
  const ok = (v) => typeof v === 'string' && /^[A-Za-z0-9_-]{16,200}$/.test(v);
  if (!validEndpoint(endpoint, { allowLocal: !isProd }) || !ok(keys?.p256dh) || !ok(keys?.auth)) return res.status(400).json({ error: 'Suscripción inválida' });
  const hash = crypto.createHash('sha256').update(endpoint).digest('hex');
  await pool.query(
    `INSERT INTO push_subscriptions (user_id, endpoint, endpoint_hash, p256dh, auth, user_agent) VALUES (?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent)`,
    [req.user.id, endpoint, hash, keys.p256dh, keys.auth, String(req.headers['user-agent'] || '').slice(0, 200)]
  );
  // Como máximo 10 dispositivos por persona: se quitan los más antiguos
  await pool.query('DELETE FROM push_subscriptions WHERE user_id = ? AND id NOT IN (SELECT id FROM (SELECT id FROM push_subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 10) t)', [req.user.id, req.user.id]);
  res.json({ ok: true });
});

app.post('/api/push/unsubscribe', authUser, async (req, res) => {
  const endpoint = req.body?.endpoint;
  if (typeof endpoint !== 'string') return res.status(400).json({ error: 'Suscripción inválida' });
  await pool.query('DELETE FROM push_subscriptions WHERE endpoint_hash = ? AND user_id = ?', [crypto.createHash('sha256').update(endpoint).digest('hex'), req.user.id]);
  res.json({ ok: true });
});

// Cerrar la sesión en todos los dispositivos (por si perdiste el celular o la dejaste abierta en otro): invalida todos los tokens y devuelve uno nuevo
app.post('/api/logout-all', authUser, async (req, res) => {
  await pool.query('UPDATE users SET token_version = token_version + 1 WHERE id = ?', [req.user.id]);
  io.in(room(req.user.id)).disconnectSockets(true);
  const [[u]] = await pool.query('SELECT * FROM users WHERE id = ?', [req.user.id]);
  res.json({ ok: true, token: sign(u) });
});

app.get('/api/health', async (_req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ ok: true });
  } catch {
    res.status(503).json({ ok: false });
  }
});

// Buscar direcciones por nombre (sesgado hacia la ubicación del usuario)
app.get('/api/places', authUser, mapsLimiter, async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 3) return res.json({ results: [] });
  const near = { lat: num(req.query.lat), lng: num(req.query.lng) };
  try {
    res.json({ results: await searchPlaces(q, isPoint(near) ? near : null) });
  } catch (e) {
    console.warn('places:', e.message);
    res.status(502).json({ error: 'No se pudo buscar la dirección. Toca el mapa para elegir el punto.' });
  }
});

// Nombre de la calle/colonia de un punto del mapa
app.get('/api/reverse', authUser, mapsLimiter, async (req, res) => {
  const p = { lat: num(req.query.lat), lng: num(req.query.lng) };
  if (!isPoint(p)) return res.status(400).json({ error: 'Ubicación inválida' });
  try {
    res.json({ text: await reversePlace(p.lat, p.lng) });
  } catch {
    res.json({ text: null });
  }
});

// Ruta por calles con distancia, tiempo y precio sugerido
app.get('/api/route', authUser, mapsLimiter, async (req, res) => {
  const from = parsePoint(req.query.from);
  const to = parsePoint(req.query.to);
  if (!isPoint(from) || !isPoint(to)) return res.status(400).json({ error: 'Ubicación inválida' });
  if (distanceKm(from.lat, from.lng, to.lat, to.lng) > 100) return res.status(400).json({ error: 'El destino está demasiado lejos' });
  const r = await getRoute(from, to);
  // Precio sugerido de cada categoría; suggestedPrice (carro) se mantiene para versiones anteriores de la app
  const prices = faresFor(await getSettings(pool), r.distanceKm, r.durationMin);
  res.json({ ...r, prices, suggestedPrice: prices.car });
});

// Historial de viajes del usuario
app.get('/api/rides/mine', authUser, async (req, res) => {
  const id = req.user.id;
  const [rows] = await pool.query(
    `SELECT r.id, r.status, r.cancelled_by, r.origin_text, r.dest_text, r.distance_km, r.offered_price, r.final_price,
            r.created_at, o.name AS other_name,
            (SELECT stars FROM ratings WHERE ride_id = r.id AND rater_id = ?) AS my_stars,
            (SELECT stars FROM ratings WHERE ride_id = r.id AND ratee_id = ?) AS their_stars
     FROM rides r LEFT JOIN users o ON o.id = IF(r.passenger_id = ?, r.driver_id, r.passenger_id)
     WHERE r.passenger_id = ? OR r.driver_id = ?
     ORDER BY r.id DESC LIMIT 50`,
    [id, id, id, id, id]
  );
  res.json({ rides: rows, rating: (await ratingsOf([id])).get(id) || { avg: null, count: 0 } });
});

// Calificar al otro participante de un viaje completado (1 a 5 estrellas)
app.post('/api/rides/:id/rate', authUser, async (req, res) => {
  const stars = Number(req.body?.stars);
  const comment = clean(req.body?.comment);
  if (!Number.isInteger(stars) || stars < 1 || stars > 5) return res.status(400).json({ error: 'Elige de 1 a 5 estrellas' });
  const ride = await getRide(Number(req.params.id));
  const me = req.user.id;
  if (!ride || ![ride.passenger_id, ride.driver_id].includes(me)) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (ride.status !== 'completed') return res.status(409).json({ error: 'Solo se pueden calificar viajes completados' });
  const ratee = me === ride.passenger_id ? ride.driver_id : ride.passenger_id;
  try {
    await pool.query('INSERT INTO ratings (ride_id, rater_id, ratee_id, stars, comment) VALUES (?,?,?,?,?)', [ride.id, me, ratee, stars, comment]);
    res.json({ ok: true });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Ya calificaste este viaje' });
    throw e;
  }
});

// Enlace para que un familiar siga el viaje en vivo (solo mientras el viaje está en curso)
app.post('/api/rides/:id/share', authUser, async (req, res) => {
  const ride = await getRide(Number(req.params.id));
  if (!ride || ![ride.passenger_id, ride.driver_id].includes(req.user.id)) return res.status(404).json({ error: 'Viaje no encontrado' });
  if (!['accepted', 'arrived', 'started'].includes(ride.status)) return res.status(409).json({ error: 'Solo se puede compartir un viaje activo' });
  let token = ride.share_token;
  if (!token) {
    token = crypto.randomBytes(16).toString('base64url');
    await pool.query('UPDATE rides SET share_token = ? WHERE id = ?', [token, ride.id]);
  }
  res.json({ token });
});

// Público: seguimiento del viaje compartido. Solo expone lo necesario (sin teléfonos ni apellidos).
app.get('/api/track/:token', trackLimiter, async (req, res) => {
  const [rows] = await pool.query(
    `SELECT * FROM rides WHERE share_token = ? AND (status IN ('accepted','arrived','started') OR updated_at > NOW() - INTERVAL 1 HOUR)`,
    [String(req.params.token).slice(0, 32)]
  );
  const ride = rows[0];
  if (!ride) return res.status(404).json({ error: 'Este enlace ya no está disponible' });
  const [dr] = ride.driver_id ? await pool.query('SELECT name, vehicle, plate FROM users WHERE id = ?', [ride.driver_id]) : [[]];
  const live = ride.driver_id ? drivers.get(ride.driver_id) : null;
  const active = ['accepted', 'arrived', 'started'].includes(ride.status);
  res.json({
    status: ride.status,
    driver: dr[0] ? { name: dr[0].name.split(' ')[0], vehicle: dr[0].vehicle, plate: dr[0].plate } : null,
    origin: { lat: ride.origin_lat, lng: ride.origin_lng, text: ride.origin_text },
    dest: { lat: ride.dest_lat, lng: ride.dest_lng, text: ride.dest_text },
    route: ride.route_json ? JSON.parse(ride.route_json) : null,
    driverPos: active && live?.lat != null ? { lat: live.lat, lng: live.lng } : null,
  });
});
