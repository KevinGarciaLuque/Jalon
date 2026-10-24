// Tiempo real (Socket.IO): conductor, pasajero, chat del viaje y botón de emergencia
import crypto from 'crypto';
import { pool } from './db.js';
import { distanceKm } from './geo.js';
import { getSettings } from './wallet.js';
import { fareFor, isCategory } from './fares.js';
import { getRoute, reversePlace } from './maps.js';
import { chatOpen, chatAllowed, CHAT_MAX } from './chat.js';
import { reportError, SESSION_COOKIE, trustedOrigin, NEARBY_KM, OFFER_TTL_SECONDS, RAISE_COOLDOWN_MS, MAX_PRICE, SOCKET_WINDOW_MS, SOCKET_LIMIT_DEFAULT, SOCKET_LIMITS } from './config.js';
import { io } from './app.js';
import { drivers, passengers, openRides, declined, room } from './live.js';
import { isPoint, isPrice, serial, clean } from './util.js';
import { push, pushStaff, hasPushSub, unreadCount } from './notify.js';
import { getRide, activeRideFor, ratingsOf, rideView, nearbyDrivers, openRidesNear, closeOpenRide, releaseDriver, sendEta, cancelRide, PIN_TRIES, canTake } from './services/rides.js';
import { walletGate, chargeCommission } from './services/balance.js';
import { shareWithContacts } from './services/accounts.js';
import { notifySos } from './services/sos.js';
import { rentingNow } from './services/rentals.js';
import { openSession, closeSession, recordPoint, forgetTrack } from './services/activity.js';
import { checkSafety, answerSafety, forgetSafety } from './services/safety.js';
import { needsSelfie } from './routes/selfies.js';
import { readCookie, userFromToken } from './access.js';

// «Mi ubicación» es como lo ve el pasajero; al conductor le sirve la dirección aproximada del punto.
// Se busca con un tope de 2,5 s (y la caché de direcciones); si no se encuentra, «Ubicación del pasajero».
const GPS_TEXTS = new Set(['', 'mi ubicación', 'mi ubicacion']);
async function pickupText(origin) {
  const text = clean(origin.text) || '';
  if (!GPS_TEXTS.has(text.toLowerCase())) return text;
  const near = await Promise.race([reversePlace(origin.lat, origin.lng).catch(() => null), new Promise((r) => setTimeout(() => r(null), 2500))]);
  return near ? `Cerca de ${near}`.slice(0, 200) : 'Ubicación del pasajero';
}

// ---------- Sockets ----------
io.use(async (socket, next) => {
  try {
    // El token que manda la app (clientes de antes, pruebas) o la cookie de sesión; con la cookie, solo desde este sitio
    const { headers } = socket.handshake;
    let token = socket.handshake.auth?.token;
    if (!token) {
      if (!trustedOrigin(headers.origin, headers.host)) return next(new Error('No autorizado'));
      token = readCookie(headers.cookie, SESSION_COOKIE);
    }
    const u = await userFromToken(token);
    if (!u) return next(new Error('No autorizado'));
    if (u.status === 'blocked') return next(new Error('Cuenta bloqueada'));
    if (u.must_change_password) return next(new Error('Debes cambiar tu contraseña'));
    socket.user = u;
    next();
  } catch {
    next(new Error('No autorizado'));
  }
});

io.on('connection', async (socket) => {
  const user = socket.user;
  // Un error dentro de un manejador no debe tumbar el servidor
  // Y ningún evento se acepta sin tope: una app modificada podría inundar el servidor (los excedentes se descartan)
  const counts = new Map(); // evento -> { n, since }
  const allowed = (ev) => {
    const c = counts.get(ev);
    if (!c || Date.now() - c.since > SOCKET_WINDOW_MS) return counts.set(ev, { n: 1, since: Date.now() }) && true;
    return ++c.n <= (SOCKET_LIMITS[ev] || SOCKET_LIMIT_DEFAULT);
  };
  const on = (ev, fn) => socket.on(ev, (...args) => {
    if (!allowed(ev)) {
      const ack = args[args.length - 1];
      return typeof ack === 'function' && ack({ error: 'Demasiadas acciones seguidas. Espera un momento.' });
    }
    return Promise.resolve(fn(...args)).catch((e) => reportError(Object.assign(e, { event: ev })));
  });
  socket.join(room(user.id));
  // La app avisa cuando pasa a segundo plano o vuelve: con la app minimizada igual se manda la notificación al celular
  socket.data.visible = true;
  on('app:visible', (visible) => { socket.data.visible = visible !== false; });
  if (user.role === 'driver') socket.join('drivers');
  socket.emit('account:status', { status: user.status });
  console.log(`+ ${user.role} ${user.name}`);

  // ----- Conductor -----
  if (user.role === 'driver') {
    on('driver:online', async (pos) => {
      if (!isPoint(pos)) return;
      const [[u]] = await pool.query('SELECT status FROM users WHERE id = ?', [user.id]);
      if (u?.status !== 'active') return socket.emit('driver:denied', { status: u?.status });
      const { lat, lng } = pos;
      const busy = await activeRideFor(user); // si se reconecta en pleno viaje, sigue ocupado
      if (!busy) {
        const gate = await walletGate(user.id);
        if (gate.blocked) return socket.emit('driver:denied', { status: 'balance', balance: gate.balance, min: gate.min });
        // Con un alquiler en curso (su carro está alquilado con él) no recibe viajes
        if (await rentingNow(user.id)) return socket.emit('driver:denied', { status: 'rental' });
        // Cada cierto tiempo se toma una selfie para confirmar que es la persona aprobada (no alguien usando su cuenta)
        if (await needsSelfie(user.id)) return socket.emit('driver:denied', { status: 'selfie' });
      }
      // Solo recibe solicitudes de la categoría de su vehículo (sin vehículo registrado cuenta como carro)
      const [[veh]] = await pool.query('SELECT category FROM vehicles WHERE driver_id = ?', [user.id]);
      const category = veh?.category || 'car';
      const [[g]] = await pool.query('SELECT gender, gender_verified FROM users WHERE id = ?', [user.id]);
      const woman = g?.gender === 'f' && !!g.gender_verified; // conductora confirmada: también recibe los viajes «solo conductoras»
      drivers.set(user.id, {
        id: user.id, name: user.name, vehicle: user.vehicle, plate: user.plate, category, woman,
        lat, lng, available: !busy, since: Date.now(), seenAt: Date.now(),
      });
      socket.emit('rides:open', openRidesNear(lat, lng, user.id, category, woman));
      openSession(user.id).catch(reportError); // empiezan a contar sus horas conectado
    });

    on('driver:offline', () => {
      drivers.delete(user.id);
      closeSession(user.id).catch(reportError);
    });

    // El conductor rechaza una solicitud: deja de verla (en todas sus pestañas) y, si había ofertado, su oferta se retira.
    // Si el pasajero sube el precio, se le vuelve a mostrar.
    on('ride:decline', async (data) => {
      const rideId = Number(data?.rideId);
      const ride = openRides.get(rideId);
      if (!ride) return;
      if (!declined.has(rideId)) declined.set(rideId, new Set());
      declined.get(rideId).add(user.id);
      io.to(room(user.id)).emit('ride:closed', { rideId });
      const [mine] = await pool.query('SELECT id FROM offers WHERE ride_id = ? AND driver_id = ? AND status = "pending"', [rideId, user.id]);
      if (!mine[0]) return;
      await pool.query('UPDATE offers SET status = "rejected" WHERE id = ? AND status = "pending"', [mine[0].id]);
      io.to(room(ride.passenger_id)).emit('offer:expired', { offerId: mine[0].id, rideId });
    });

    on('driver:location', async (pos) => {
      if (!isPoint(pos)) return;
      const { lat, lng } = pos;
      const d = drivers.get(user.id);
      if (d) { d.lat = lat; d.lng = lng; d.seenAt = Date.now(); }
      const ride = await activeRideFor(user);
      if (!ride) return;
      io.to(room(ride.passenger_id)).emit('ride:driver_location', { lat, lng });
      sendEta(ride, { lat, lng }).catch(reportError); // sin esperar: el aviso de ubicación no depende de la ruta
      // Con el viaje en curso se guarda el camino real (para el historial, el recibo y los reclamos)
      if (ride.status === 'started') {
        recordPoint(ride.id, { lat, lng }).catch(reportError);
        checkSafety(ride, { lat, lng }).catch(reportError); // ¿se desvió o lleva mucho detenido?
      }
    });

    on('offer:make', async ({ rideId, price }) => {
      const d = drivers.get(user.id);
      const ride = openRides.get(rideId);
      price = Number(price);
      if (!d || !d.available || !ride || !isPrice(price) || !canTake(d, ride)) return;
      await serial(`offer:${user.id}:${rideId}`, async () => {
      // Si el conductor ya ofertó en este viaje, se actualiza su oferta en lugar de duplicarla
      const [prev] = await pool.query('SELECT id FROM offers WHERE ride_id = ? AND driver_id = ? AND status = "pending"', [rideId, user.id]);
      let offerId;
      if (prev[0]) {
        offerId = prev[0].id;
        await pool.query('UPDATE offers SET price = ?, expires_at = NOW() + INTERVAL ? SECOND WHERE id = ?', [price, OFFER_TTL_SECONDS, offerId]);
      } else {
        const [r] = await pool.query('INSERT INTO offers (ride_id, driver_id, price, expires_at) VALUES (?,?,?, NOW() + INTERVAL ? SECOND)', [rideId, user.id, price, OFFER_TTL_SECONDS]);
        offerId = r.insertId;
      }
      io.to(room(ride.passenger_id)).emit('offer:new', {
        id: offerId, rideId, price, ttl: OFFER_TTL_SECONDS, // segundos que vale la oferta
        driver: { id: user.id, name: user.name, vehicle: user.vehicle, plate: user.plate, rating: (await ratingsOf([user.id])).get(user.id) || { avg: null, count: 0 } },
        distanceToPickupKm: d.lat != null ? distanceKm(d.lat, d.lng, ride.origin_lat, ride.origin_lng) : null,
      });
      socket.emit('offer:sent', { rideId, price, ttl: OFFER_TTL_SECONDS });
      push(ride.passenger_id, { title: 'Nueva oferta para tu viaje', body: `${user.name} ofrece L ${Math.round(price)}`, tag: `offer-${rideId}`, url: '/' });
      });
    });

    // El conductor puede cancelar antes de iniciar el viaje
    on('ride:driver_cancel', async ({ rideId }) => {
      const ride = await getRide(rideId);
      if (!ride || ride.driver_id !== user.id || !['accepted', 'arrived'].includes(ride.status)) return;
      await cancelRide(rideId, 'driver', ['accepted', 'arrived']);
    });

    on('ride:status', async ({ rideId, status, pin }, ack) => {
      const order = { arrived: 'accepted', started: 'arrived', completed: 'started' };
      const ride = await getRide(rideId);
      if (!ride || ride.driver_id !== user.id || order[status] !== ride.status) return;
      // Para iniciar el viaje el conductor escribe el PIN que le dice el pasajero
      if (status === 'started' && ride.start_pin) {
        if (Number(ride.pin_attempts) >= PIN_TRIES) return ack?.({ error: 'Se equivocaron demasiadas veces con el PIN: este viaje no se puede iniciar. Cancélalo o escribe a soporte.', locked: true });
        if (String(pin || '').trim() !== ride.start_pin) {
          await pool.query('UPDATE rides SET pin_attempts = pin_attempts + 1 WHERE id = ?', [rideId]);
          const left = PIN_TRIES - Number(ride.pin_attempts) - 1;
          if (left <= 0) {
            push(ride.passenger_id, { title: 'No se pudo confirmar tu PIN', body: 'El conductor no escribió tu PIN correcto. Si no es tu conductor, no te subas y cancela el viaje.', tag: `ride-${rideId}`, url: '/' }, { always: true });
            io.to(room(ride.passenger_id)).to(room(user.id)).emit('ride:state', await rideView(await getRide(rideId)));
          }
          return ack?.({ error: left > 0 ? `PIN incorrecto. Te quedan ${left} intento${left === 1 ? '' : 's'}.` : 'PIN incorrecto. Ya no se puede iniciar este viaje.', locked: left <= 0 });
        }
      }
      // Solo avanza desde el estado anterior: si justo lo cancelaron (o llegó un doble toque), no se pisa
      // También se anota cuándo empezó y cuándo terminó (para las ganancias por día y la duración real)
      const [moved] = await pool.query(
        `UPDATE rides SET status = ?, started_at = IF(? = 'started', NOW(), started_at), completed_at = IF(? = 'completed', NOW(), completed_at)
         WHERE id = ? AND driver_id = ? AND status = ?`,
        [status, status, status, rideId, user.id, order[status]]
      );
      if (moved.affectedRows !== 1) return socket.emit('ride:state', await rideView(await getRide(rideId)));
      if (status === 'completed') {
        releaseDriver(user.id);
        chargeCommission(ride).catch(reportError); // se descuenta del saldo del conductor; sin await para no retrasar la respuesta
      }
      const view = await rideView(await getRide(rideId));
      io.to(room(ride.passenger_id)).to(room(user.id)).emit('ride:state', view);
      if (status === 'started') {
        shareWithContacts(ride).catch(reportError);
        const d = drivers.get(user.id);
        if (d?.lat != null) recordPoint(ride.id, { lat: d.lat, lng: d.lng }).catch(reportError); // primer punto del recorrido
      }
      if (status === 'completed') { forgetTrack(ride.id); forgetSafety(ride.id); }
      ack?.({ ok: true });
      if (status === 'arrived') push(ride.passenger_id, { title: 'Tu conductor llegó', body: `${user.name} te espera · ${user.vehicle || ''} ${user.plate || ''}`.trim(), tag: `ride-${rideId}`, url: '/' });
      if (status === 'started') push(ride.passenger_id, { title: 'Tu viaje empezó', body: `Vas con ${user.name}${ride.dest_text ? ` a ${ride.dest_text}` : ''}. Puedes compartir tu viaje desde la app.`, tag: `ride-${rideId}`, url: '/' });
      if (status === 'completed') push(ride.passenger_id, { title: 'Llegaste a tu destino', body: `Total a pagar: L ${Math.round(ride.final_price ?? ride.offered_price)}. Califica a ${user.name} y mira el recibo en tu historial.`, tag: `ride-${rideId}`, target: 'history', url: '/' });
    });
  }

  // ----- Pasajero -----
  if (user.role === 'passenger') {
    on('passenger:location', (pos) => {
      if (!isPoint(pos)) return;
      const { lat, lng } = pos;
      passengers.set(user.id, { id: user.id, lat, lng, socketId: socket.id });
      socket.emit('drivers:nearby', nearbyDrivers(lat, lng));
    });

    on('ride:request', async ({ origin, dest, price, category: cat, womenOnly }, ack) => {
      try {
        if (!isPoint(origin) || !isPoint(dest)) return ack?.({ error: 'Ubicación inválida' });
        // Si ya hay uno (p. ej. pedido desde otro celular), se le muestra para que lo vea o lo cancele
        const current = await activeRideFor(user);
        if (current) {
          socket.emit('ride:state', await rideView(current));
          return ack?.({ error: 'Ya tienes un viaje activo: te lo mostramos' });
        }
        const straight = distanceKm(origin.lat, origin.lng, dest.lat, dest.lng);
        if (straight < 0.1) return ack?.({ error: 'El destino está demasiado cerca' });
        if (straight > 100) return ack?.({ error: 'El destino está demasiado lejos' });
        // La distancia y la ruta las calcula el servidor, no la app (no se pueden falsear)
        const route = await getRoute(origin, dest);
        const km = route.distanceKm;
        const category = isCategory(cat) ? cat : 'car';
        // «Solo conductoras»: para pasajeras (lo indican en Mi cuenta)
        let women = 0;
        if (womenOnly) {
          const [[me]] = await pool.query('SELECT gender FROM users WHERE id = ?', [user.id]);
          if (me?.gender !== 'f') return ack?.({ error: '«Solo conductoras» es para pasajeras: indícalo en Mi cuenta' });
          women = 1;
        }
        const offered = price == null || price === '' ? fareFor(await getSettings(pool), category, km, route.durationMin) : Number(price);
        if (!isPrice(offered)) return ack?.({ error: `El precio debe estar entre L 1 y L ${MAX_PRICE}` });
        const [r] = await pool.query(
          `INSERT INTO rides (passenger_id, origin_lat, origin_lng, origin_text, dest_lat, dest_lng, dest_text, distance_km, duration_min, route_json, offered_price, category, women_only)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
          [user.id, origin.lat, origin.lng, await pickupText(origin), dest.lat, dest.lng, clean(dest.text), km, route.durationMin, JSON.stringify(route.coords), offered, category, women]
        );
        const ride = await rideView(await getRide(r.insertId));
        openRides.set(ride.id, ride);
        // Avisar a conductores libres cercanos de la misma categoría
        for (const d of drivers.values()) {
          if (!d.available || (d.category || 'car') !== category || !canTake(d, ride) || distanceKm(d.lat, d.lng, origin.lat, origin.lng) > NEARBY_KM) continue;
          if (!d.disconnected) io.to(room(d.id)).emit('ride:new', ride);
          else push(d.id, { bell: false, title: 'Nuevo viaje cerca de ti', body: `${ride.dest_text ? `A ${ride.dest_text}` : 'Viaje disponible'} · L ${Math.round(ride.offered_price)}`, tag: `ride-${ride.id}`, url: '/' });
        }
        io.to(room(user.id)).emit('ride:state', ride); // a todos sus dispositivos (si tiene la app abierta en otro celular, también lo ve)
        ack?.({ ok: true });
      } catch (e) {
        console.error(e);
        ack?.({ error: 'No se pudo crear el viaje' });
      }
    });

    on('offer:accept', async ({ offerId }) => {
      const [rows] = await pool.query('SELECT *, (expires_at IS NOT NULL AND expires_at < NOW()) AS expired FROM offers WHERE id = ? AND status = "pending"', [offerId]);
      const offer = rows[0];
      if (!offer) return socket.emit('offer:invalid', { offerId }); // ya venció, la retiraron o no existe: la pantalla debe quitarla
      if (offer.expired) return socket.emit('offer:invalid', { offerId: offer.id }); // venció antes de que la aceptaran
      const ride = await getRide(offer.ride_id);
      const d = drivers.get(offer.driver_id);
      if (!ride || ride.passenger_id !== user.id || ride.status !== 'requested') return;
      if (!d?.available || d.disconnected) {
        await pool.query('UPDATE offers SET status = "rejected" WHERE id = ?', [offer.id]);
        return socket.emit('offer:invalid', { offerId: offer.id });
      }
      // El conductor se reserva antes de cualquier espera: si dos pasajeros aceptan a la vez ofertas suyas, solo uno se lo lleva
      d.available = false;

      // El viaje solo se asigna si sigue buscando conductor (doble toque, o dos ofertas aceptadas a la vez)
      // PIN de 4 dígitos para iniciar el viaje: confirma que el pasajero se sube al carro correcto.
      // Va si el superadmin lo pide para todos, si el pasajero lo activó en Mi cuenta, o si el viaje es «Solo conductoras»
      const [[pref]] = await pool.query('SELECT ride_pin FROM users WHERE id = ?', [ride.passenger_id]);
      const wantsPin = (await getSettings(pool)).ride_pin_required === '1' || !!pref?.ride_pin || !!Number(ride.women_only);
      const pin = wantsPin ? String(crypto.randomInt(0, 10000)).padStart(4, '0') : null;
      const [assigned] = await pool.query('UPDATE rides SET driver_id = ?, final_price = ?, status = "accepted", start_pin = ? WHERE id = ? AND status = "requested"', [offer.driver_id, offer.price, pin, ride.id]);
      if (assigned.affectedRows !== 1) {
        releaseDriver(offer.driver_id);
        return socket.emit('offer:invalid', { offerId: offer.id });
      }
      await pool.query('UPDATE offers SET status = IF(id = ?, "accepted", "rejected") WHERE ride_id = ?', [offer.id, ride.id]);
      closeOpenRide(ride.id);

      const view = await rideView(await getRide(ride.id));
      io.to(room(user.id)).to(room(offer.driver_id)).emit('ride:state', view);
      push(offer.driver_id, { title: '¡Te aceptaron el viaje!', body: `${user.name} · L ${Math.round(offer.price)}`, tag: `ride-${ride.id}`, url: '/' });
    });

    // Mientras nadie acepta, el pasajero puede subir su oferta: los conductores cercanos ven el precio nuevo
    const lastRaise = new Map();
    on('ride:raise', async (data, ack) => {
      const price = Number(data?.price);
      const ride = await getRide(Number(data?.rideId));
      if (!ride || ride.passenger_id !== user.id || ride.status !== 'requested') return ack?.({ error: 'Ese viaje ya no está buscando conductor' });
      if (!isPrice(price)) return ack?.({ error: `El precio debe estar entre L 1 y L ${MAX_PRICE}` });
      if (price <= Number(ride.offered_price)) return ack?.({ error: 'El precio nuevo debe ser mayor al actual' });
      if (Date.now() - (lastRaise.get(ride.id) || 0) < RAISE_COOLDOWN_MS) return ack?.({ error: 'Espera unos segundos antes de volver a subir el precio' });
      lastRaise.set(ride.id, Date.now());
      await pool.query('UPDATE rides SET offered_price = ? WHERE id = ? AND status = "requested"', [price, ride.id]);
      const view = await rideView(await getRide(ride.id));
      openRides.set(ride.id, view);
      declined.delete(ride.id); // con el precio nuevo, quienes la rechazaron la vuelven a ver
      for (const d of drivers.values()) {
        if (!d.available || (d.category || 'car') !== ride.category || !canTake(d, ride) || distanceKm(d.lat, d.lng, ride.origin_lat, ride.origin_lng) > NEARBY_KM) continue;
        if (!d.disconnected) io.to(room(d.id)).emit('ride:new', view); // el cliente reemplaza la solicitud por la del precio nuevo
        else push(d.id, { bell: false, title: 'El pasajero subió su oferta', body: `${ride.dest_text ? `A ${ride.dest_text}` : 'Viaje cercano'} · L ${Math.round(price)}`, tag: `ride-${ride.id}`, url: '/' });
      }
      io.to(room(user.id)).emit('ride:state', view);
      ack?.({ ok: true, price });
    });

    on('ride:cancel', async ({ rideId }) => {
      const ride = await getRide(rideId);
      if (!ride || ride.passenger_id !== user.id || !['requested', 'accepted', 'arrived'].includes(ride.status)) return;
      await cancelRide(rideId, 'passenger', ['requested', 'accepted', 'arrived']);
    });
  }

  // ----- Chat del viaje -----
  const rideForChat = async (rideId) => {
    const [rows] = await pool.query('SELECT *, (updated_at > NOW() - INTERVAL 30 MINUTE) AS recent FROM rides WHERE id = ?', [Number(rideId)]);
    const ride = rows[0];
    return ride && [ride.passenger_id, ride.driver_id].includes(user.id) ? ride : null; // solo quienes participan
  };

  on('chat:send', async (data, ack) => {
    const ride = await rideForChat(data?.rideId);
    if (!ride) return ack?.({ error: 'Viaje no encontrado' });
    if (!chatOpen(ride)) return ack?.({ error: 'El chat de este viaje ya está cerrado' });
    const text = typeof data.text === 'string' ? data.text.trim() : '';
    if (!text) return ack?.({ error: 'Escribe un mensaje' });
    if (text.length > CHAT_MAX) return ack?.({ error: `Máximo ${CHAT_MAX} caracteres` });
    if (!chatAllowed(user.id)) return ack?.({ error: 'Estás enviando demasiados mensajes. Espera un momento.' });
    const [r] = await pool.query('INSERT INTO messages (ride_id, sender_id, text) VALUES (?,?,?)', [ride.id, user.id, text]);
    const message = { id: r.insertId, rideId: ride.id, senderId: user.id, text, at: new Date().toISOString() };
    const other = user.id === ride.passenger_id ? ride.driver_id : ride.passenger_id;
    io.to(room(user.id)).to(room(other)).emit('chat:message', message);
    push(other, { title: user.name, body: text.length > 100 ? `${text.slice(0, 97)}…` : text, tag: `chat-${ride.id}`, url: '/' });
    ack?.({ ok: true, message });
  });

  // Mensajes anteriores del viaje (al abrir el chat o reconectarse) y cuántos no ha leído esta persona
  on('chat:history', async (data, ack) => {
    const ride = await rideForChat(data?.rideId);
    if (!ride) return ack?.({ error: 'Viaje no encontrado' });
    const [rows] = await pool.query(
      'SELECT id, sender_id AS senderId, text, created_at AS at, (read_at IS NOT NULL) AS isRead FROM messages WHERE ride_id = ? ORDER BY id DESC LIMIT 200', [ride.id]
    );
    const messages = rows.reverse().map((m) => ({ id: m.id, rideId: ride.id, senderId: m.senderId, text: m.text, at: m.at, read: !!m.isRead }));
    ack?.({ ok: true, messages, unread: messages.filter((m) => m.senderId !== user.id && !m.read).length, open: chatOpen(ride) });
  });

  on('chat:read', async (data) => {
    const ride = await rideForChat(data?.rideId);
    if (!ride) return;
    await pool.query('UPDATE messages SET read_at = NOW() WHERE ride_id = ? AND sender_id <> ? AND read_at IS NULL', [ride.id, user.id]);
    const other = user.id === ride.passenger_id ? ride.driver_id : ride.passenger_id;
    if (other) io.to(room(other)).emit('chat:read', { rideId: ride.id, by: user.id });
    // Quien abrió el chat ya vio los mensajes: el aviso de la campanita de ese chat queda leído
    const [seen] = await pool.query('UPDATE notifications SET read_at = NOW(), updated_at = updated_at WHERE user_id = ? AND tag = ? AND read_at IS NULL', [user.id, `chat-${ride.id}`]);
    if (seen.affectedRows) io.to(room(user.id)).emit('notify:read', { unread: await unreadCount(user.id) });
  });

  // Botón de emergencia: registra la alerta para el administrador junto con la ubicación
  // Respuesta al «¿Todo bien?» durante el viaje
  on('safety:answer', async ({ eventId, answer } = {}, ack) => ack?.(await answerSafety(user, eventId, answer)));

  on('ride:sos', async (pos, ack) => {
    const ride = await activeRideFor(user);
    if (!ride || ride.status === 'requested') return ack?.({ error: 'Solo disponible durante un viaje' });
    const live = user.role === 'driver' ? drivers.get(user.id) : passengers.get(user.id);
    const at = isPoint(pos) ? pos : live?.lat != null ? live : null;
    const [r] = await pool.query('INSERT INTO alerts (ride_id, user_id, lat, lng) VALUES (?,?,?,?)', [ride.id, user.id, at?.lat ?? null, at?.lng ?? null]);
    console.warn(`🆘 SOS de ${user.name} (viaje ${ride.id})`);
    ack?.({ ok: true });
    notifySos(r.insertId, false).catch((e) => console.error('SOS:', e)); // el SMS no debe retrasar la respuesta al usuario
    pushStaff({ title: '🆘 EMERGENCIA', body: `${user.name} pidió ayuda (viaje ${ride.id})`, tag: `sos-${r.insertId}`, url: '/', requireInteraction: true }, 'alerts');
  });

  socket.on('disconnect', async () => {
    // Si el usuario sigue conectado desde otra pestaña, no se toca nada
    if ((await io.in(room(user.id)).fetchSockets()).length) return;
    if (user.role === 'driver') {
      const d = drivers.get(user.id);
      if (d?.available) {
        // Con notificaciones activadas se le sigue avisando de viajes cercanos aunque cierre la app (hasta 30 min sin volver)
        if (await hasPushSub(user.id)) { d.disconnected = true; d.lastSeen = Date.now(); } else drivers.delete(user.id);
      } else if (d) d.disconnected = true; // con viaje activo: se quita del mapa cuando termine
      closeSession(user.id).catch(reportError); // cerró la app: dejan de contar sus horas conectado
    }
    if (user.role === 'passenger') passengers.delete(user.id);
  });

  // Restaurar el viaje activo si la persona recarga la página o se reconecta.
  // Va AL FINAL a propósito: todos los eventos ya están registrados antes de cualquier consulta a la base de datos. Si fuera al inicio,
  // un mensaje que el celular manda justo al reconectarse (p. ej. "estoy disponible") llegaría antes de que el servidor lo escuche y se perdería.
  const active = await activeRideFor(user);
  if (active) socket.emit('ride:state', await rideView(active));
});
