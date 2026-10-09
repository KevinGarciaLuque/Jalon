import 'dotenv/config';
// Fase 8B: chat del viaje y teléfonos ocultos
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { purgeOldMessages } from '../src/chat.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin, startFakePush } from './helpers.mjs';

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const phone = (p) => `${p}${rnd}9`.slice(0, 8);
const connect = async (token) => { const s = io(API, { auth: { token } }); await new Promise((r) => s.once('connect', r)); return s; };
const next = (s, ev, pred = () => true, ms = 5000) => new Promise((res, rej) => {
  const t = setTimeout(() => { s.off(ev, h); rej(new Error(`timeout esperando ${ev}`)); }, ms);
  const h = (d) => { if (pred(d)) { clearTimeout(t); s.off(ev, h); res(d); } };
  s.on(ev, h);
});
const ask = (s, ev, data) => new Promise((res) => s.emit(ev, data, res));

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const fake = await startFakePush();
const hasPush = !!process.env.VAPID_PUBLIC_KEY;

const P = await registerUser({ name: 'P8B Pasajero', phone: phone('88'), password: 'Cielo-azul-77', role: 'passenger' });
const X = await registerUser({ name: 'P8B Intruso', phone: phone('87'), password: 'Cielo-azul-77', role: 'passenger' });
const D = await registerUser({ name: 'P8B Conductor', phone: phone('86'), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Hilux', plate: 'HLL0001' });
await uploadDocs(D.token);
await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [D.user.id]);

const ps = await connect(P.token);
const ds = await connect(D.token);
const xs = await connect(X.token);
const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.1, lng: -87.2, text: 'Mall Multiplaza' };
ds.emit('driver:online', { lat: 14.073, lng: -87.1925 });
await wait(500);

// ================= Teléfonos ocultos =================
const seenByDriver = next(ds, 'ride:new');
const pRequested = next(ps, 'ride:state', (r) => r.status === 'requested');
ps.emit('ride:request', { origin, dest, price: 80 }, () => {});
const rideNew = await seenByDriver;
const ride = await pRequested;
check('el aviso de viaje nuevo (lo reciben todos los conductores cercanos) no incluye el teléfono del pasajero', rideNew.passenger && !('phone' in rideNew.passenger) && !JSON.stringify(rideNew).includes(P.user.phone));

// Antes de aceptarlo el chat está cerrado
const early = await ask(ps, 'chat:send', { rideId: ride.id, text: 'hola' });
check('sin conductor asignado el chat está cerrado', /cerrado/.test(early.error || ''));

const offerP = next(ps, 'offer:new');
ds.emit('offer:make', { rideId: ride.id, price: 80 });
const offer = await offerP;
const driverState = next(ds, 'ride:state', (r) => r.status === 'accepted');
const passengerState = next(ps, 'ride:state', (r) => r.status === 'accepted');
ps.emit('offer:accept', { offerId: offer.id });
const dView = await driverState;
const pView = await passengerState;
check('el pasajero ve nombre, vehículo y placa del conductor pero no su teléfono', pView.driver.name === 'P8B Conductor' && pView.driver.plate === 'HLL0001' && !('phone' in pView.driver) && !JSON.stringify(pView).includes(D.user.phone));
check('el conductor ve el nombre del pasajero pero no su teléfono', dView.passenger.name === 'P8B Pasajero' && !('phone' in dView.passenger) && !JSON.stringify(dView).includes(P.user.phone));

// ================= Chat =================
const toDriver = next(ds, 'chat:message');
const toPassenger = next(ps, 'chat:message');
const sent = await ask(ps, 'chat:send', { rideId: ride.id, text: '  Hola, ya salgo  ' });
const [mD, mP] = await Promise.all([toDriver, toPassenger]);
check('el pasajero envía un mensaje y llega a los dos', sent.ok === true && mD.text === 'Hola, ya salgo' && mP.id === mD.id && mD.senderId === P.user.id && mD.rideId === ride.id);
const [[stored]] = await pool.query('SELECT text, sender_id FROM messages WHERE id = ?', [mD.id]);
check('el mensaje queda guardado (sin los espacios de los lados)', stored.text === 'Hola, ya salgo' && stored.sender_id === P.user.id);

check('un mensaje vacío se rechaza', !!(await ask(ps, 'chat:send', { rideId: ride.id, text: '   ' })).error);
check('un mensaje de más de 500 caracteres se rechaza', /500/.test((await ask(ps, 'chat:send', { rideId: ride.id, text: 'a'.repeat(501) })).error || ''));
const script = '<img src=x onerror=alert(1)><script>alert("x")</script>';
const evil = await ask(ds, 'chat:send', { rideId: ride.id, text: script });
check('el texto con código se guarda tal cual como texto (la pantalla lo muestra sin ejecutarlo)', evil.ok === true && evil.message.text === script);
check('el conductor responde', (await ask(ds, 'chat:send', { rideId: ride.id, text: 'Voy en camino' })).ok === true);

check('una persona que no participa no puede escribir', !!(await ask(xs, 'chat:send', { rideId: ride.id, text: 'intruso' })).error);
check('ni leer los mensajes', !!(await ask(xs, 'chat:history', { rideId: ride.id })).error);
const [[intrusos]] = await pool.query('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ?', [X.user.id]);
check('y no quedó nada guardado a su nombre', intrusos.n === 0);

const hist = await ask(ds, 'chat:history', { rideId: ride.id });
check('el historial viene en orden', hist.ok && hist.messages.map((m) => m.text).join('|') === `Hola, ya salgo|${script}|Voy en camino`);
check('cuenta lo que el conductor no ha leído (solo lo que escribió el pasajero)', hist.unread === 1);
const seen = next(ps, 'chat:read');
ds.emit('chat:read', { rideId: ride.id });
check('al leer, el otro se entera', (await seen).by === D.user.id);
check('después de leer no quedan pendientes y el pasajero ve que le leyeron', (await ask(ds, 'chat:history', { rideId: ride.id })).unread === 0 && (await ask(ps, 'chat:history', { rideId: ride.id })).messages.find((m) => m.text === 'Hola, ya salgo').read === true);

// ================= Notificación del mensaje cuando la app está cerrada =================
if (hasPush) {
  const dev = fake.device('pasajero');
  await http('POST', 'push/subscribe', P.token, { subscription: dev.subscription });
  const live = (await ask(ds, 'chat:send', { rideId: ride.id, text: 'estoy llegando' })).ok;
  await wait(700);
  check('con la app abierta no se manda notificación (ya lo ve)', live && dev.messages().length === 0);
  ps.close();
  await wait(500);
  await ask(ds, 'chat:send', { rideId: ride.id, text: 'Ya llegué, estoy afuera' });
  await wait(900);
  const got = dev.messages();
  check('con la app cerrada, el mensaje llega como notificación con el nombre de quien escribe', got.length === 1 && got[0].title === 'P8B Conductor' && got[0].body === 'Ya llegué, estoy afuera' && got[0].tag === `chat-${ride.id}`);
} else {
  console.log('SKIP: notificación de chat (el servidor no tiene VAPID)');
  ps.close();
}
const ps2 = await connect(P.token);

// ================= El personal puede leer el chat de un viaje con emergencia =================
check('sin sesión no se ve el chat', (await http('GET', `admin/rides/${ride.id}/chat`, null)).status === 401);
check('un pasajero no ve el chat del panel', (await http('GET', `admin/rides/${ride.id}/chat`, P.token)).status === 403);
check('sin emergencia, ni el personal ve el chat', (await http('GET', `admin/rides/${ride.id}/chat`, SA)).status === 403);
const sos = await ask(ps2, 'ride:sos', origin);
check('el pasajero pide ayuda', sos.ok === true);
const staffChat = await http('GET', `admin/rides/${ride.id}/chat`, SA);
check('con una emergencia, el personal lee la conversación completa con los nombres', staffChat.messages?.length >= 3 && staffChat.messages.some((m) => m.sender === 'P8B Conductor' && m.text === 'Voy en camino') && staffChat.messages.some((m) => m.sender === 'P8B Pasajero'));
const audit = await http('GET', 'admin/audit', SA);
check('queda anotado quién leyó el chat', audit.some((a) => a.action === 'chat.view' && a.details?.ride === ride.id));
check('un viaje que no existe da 404', (await http('GET', 'admin/rides/99999999/chat', SA)).status === 404);

// ================= Terminar el viaje: el chat sigue abierto un rato =================
for (const st of ['arrived', 'started', 'completed']) { const u = next(ps2, 'ride:state', (r) => r.status === st); ds.emit('ride:status', { rideId: ride.id, status: st }); await u; }
check('al terminar el viaje el chat sigue abierto un rato (para avisar de un objeto olvidado)', (await ask(ps2, 'chat:send', { rideId: ride.id, text: 'Creo que dejé mi celular en el carro' })).ok === true);
await pool.query('UPDATE rides SET updated_at = NOW() - INTERVAL 31 MINUTE WHERE id = ?', [ride.id]);
check('pasados 30 minutos el chat se cierra', /cerrado/.test((await ask(ps2, 'chat:send', { rideId: ride.id, text: 'hola otra vez' })).error || ''));
const closedHist = await ask(ps2, 'chat:history', { rideId: ride.id });
check('pero el historial sigue disponible para los dos', closedHist.ok && closedHist.open === false && closedHist.messages.length >= 4);

// Un viaje cancelado no tiene chat
const pReq2 = next(ps2, 'ride:state', (r) => r.status === 'requested');
ps2.emit('ride:request', { origin, dest, price: 70 }, () => {});
const ride2 = await pReq2;
const cancelled = next(ps2, 'ride:state', (r) => r.status === 'cancelled');
ps2.emit('ride:cancel', { rideId: ride2.id });
await cancelled;
check('un viaje cancelado no tiene chat', /cerrado/.test((await ask(ps2, 'chat:send', { rideId: ride2.id, text: 'hola' })).error || ''));

// ================= Tus datos =================
const exp = await http('GET', 'me/export', P.token);
check('descargar mis datos incluye los mensajes que envié', exp.mensajesQueEnvie.some((m) => m.texto === 'Hola, ya salgo') && !exp.mensajesQueEnvie.some((m) => m.texto === 'Voy en camino'));

// ================= Límite de mensajes =================
// el viaje está cerrado (31 min): se reabre solo para esta comprobación
await pool.query('UPDATE rides SET updated_at = NOW() WHERE id = ?', [ride.id]);
const burst = [];
for (let i = 0; i < 25; i++) burst.push(await ask(ps2, 'chat:send', { rideId: ride.id, text: `ráfaga ${i}` }));
check('más de 20 mensajes por minuto se frenan', burst.some((r) => /demasiados/.test(r.error || '')) && burst.filter((r) => r.ok).length <= 20);

// ================= Eliminar la cuenta borra lo escrito; la retención borra lo antiguo =================
check('el pasajero elimina su cuenta', (await http('POST', 'me/delete', P.token, { password: 'Cielo-azul-77' })).ok === true);
const [[afterDel]] = await pool.query("SELECT SUM(text = '[mensaje eliminado]') AS borrados, SUM(text = 'Voy en camino') AS delOtro FROM messages WHERE ride_id = ?", [ride.id]);
check('sus mensajes quedan borrados y los del conductor se conservan', Number(afterDel.borrados) >= 3 && Number(afterDel.delOtro) === 1);

await pool.query("INSERT INTO messages (ride_id, sender_id, text, created_at) VALUES (?,?,'mensaje muy viejo', NOW() - INTERVAL 100 DAY)", [ride.id, D.user.id]);
const purged = await purgeOldMessages(pool, 90);
const [[old]] = await pool.query("SELECT COUNT(*) AS n FROM messages WHERE text = 'mensaje muy viejo'");
const [[recent]] = await pool.query("SELECT COUNT(*) AS n FROM messages WHERE text = 'Voy en camino'");
check('la retención borra los mensajes de más de 90 días y conserva los recientes', purged >= 1 && old.n === 0 && recent.n === 1);

[ps2, ds, xs].forEach((s) => s.close());
fake.stop();
await pool.end();
console.log(fails ? `\n${fails} fallos` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 200);
