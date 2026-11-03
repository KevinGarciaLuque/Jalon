import 'dotenv/config';
// Un pasajero pide ser conductor con su misma cuenta: vehículo, documentos, aprobación; y si se le rechaza vuelve a ser pasajero
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { UPLOADS } from '../src/config.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
const got = (s, ev, pred = () => true, ms = 1500) => new Promise((res) => { const h = (d) => { if (pred(d)) { s.off(ev, h); res(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); res(null); }, ms); });
const at = { lat: 14.0723, lng: -87.1921 };
const sockets = [];
const track = (s) => { sockets.push(s); return s; };
const veh = (plate) => ({ category: 'car', make: 'Honda', model: 'Fit', color: 'Gris', year: '2015', plate });

const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

try {
  const P = await registerUser({ name: 'C37 Pasajera', phone: `86${rnd}7`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const D = await registerUser({ name: 'C37 Conductor', phone: `96${rnd}7`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HR3${rnd.slice(0, 4)}` });
  const plate = `HS3${rnd.slice(0, 4)}`;

  // ---------- Pedirlo ----------
  check('la pasajera todavía no puede conducir', (await http('GET', 'me', P.token)).user?.canDrive === false);
  check('el personal no puede pedir ser conductor', (await http('POST', 'me/apply-driver', SA, veh(plate))).status === 403);
  check('un conductor no lo vuelve a pedir', (await http('POST', 'me/apply-driver', D.token, veh(plate))).status === 403);
  check('hay que indicar el vehículo', (await http('POST', 'me/apply-driver', P.token, { category: 'car', plate })).status === 400);
  check('la placa no puede ser de otro conductor', (await http('POST', 'me/apply-driver', P.token, veh(D.user.plate))).status === 409);
  const ap = await http('POST', 'me/apply-driver', P.token, veh(plate));
  check('envía su solicitud y sigue como pasajera', ap.user?.role === 'passenger' && ap.user.canDrive === true && ap.user.passengerMode === true && ap.user.status === 'pending', JSON.stringify(ap.user && { role: ap.user.role, status: ap.user.status }));
  check('no la puede enviar dos veces', (await http('POST', 'me/apply-driver', P.token, veh(plate))).status === 403);
  check('su vehículo quedó guardado', ap.user?.plate === plate && /Honda Fit/.test(ap.user.vehicle || ''));
  check('sigue pudiendo pedir viajes como pasajera', (await http('GET', 'rides/mine', P.token)).status === 200);
  const list = await http('GET', 'admin/users?filter=pending', SA);
  check('le aparece al personal en Solicitudes', list.users?.some((u) => u.id === P.user.id));
  check('el Registro anota la solicitud', (await http('GET', 'admin/audit', SA)).some((a) => a.action === 'driver.apply' && a.target_user_id === P.user.id));

  // ---------- Documentos en «Mi solicitud de conductor» ----------
  const sw = await http('POST', 'me/mode', P.token, { mode: 'driver' });
  check('entra al modo conductor para subir sus documentos', sw.user?.role === 'driver' && sw.user.status === 'pending');
  await uploadDocs(P.token);
  const [[{ n: docs }]] = await pool.query('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?', [P.user.id]);
  check('sube sus tres documentos', docs === 3);
  const ds = track(await connect(P.token));
  const denied = got(ds, 'driver:denied');
  ds.emit('driver:online', at);
  check('sin aprobación no puede ponerse disponible', (await denied)?.status === 'pending');
  ds.close();

  // ---------- Rechazo: vuelve a ser pasajera, no se bloquea ----------
  const [docRows] = await pool.query('SELECT file FROM documents WHERE user_id = ?', [P.user.id]);
  const files = docRows.map((r) => path.join(UPLOADS, r.file));
  check('sus documentos están guardados', files.length === 3 && files.every((f) => fs.existsSync(f)));
  const live = track(await connect(P.token));
  const modeEvent = got(live, 'account:mode');
  const rej = await http('POST', `admin/users/${P.user.id}/reject`, SA, { note: 'La licencia está vencida' });
  check('el superadmin rechaza la solicitud', rej.ok === true && rej.backToPassenger === true);
  const m = await modeEvent;
  check('la app recibe que vuelve a ser pasajera', m?.role === 'passenger' && m.canDrive === false && m.status === 'active', JSON.stringify(m));
  await wait(400);
  const [[u]] = await pool.query('SELECT role, status, passenger_mode, driver_applied_at, plate FROM users WHERE id = ?', [P.user.id]);
  check('su cuenta queda como pasajera activa (no bloqueada)', u.role === 'passenger' && u.status === 'active' && !u.passenger_mode && !u.driver_applied_at && !u.plate);
  check('se borran su vehículo y sus documentos', (await pool.query('SELECT COUNT(*) AS n FROM vehicles WHERE driver_id = ?', [P.user.id]))[0][0].n === 0
    && (await pool.query('SELECT COUNT(*) AS n FROM documents WHERE user_id = ?', [P.user.id]))[0][0].n === 0
    && files.every((f) => !fs.existsSync(f)));
  const me = await http('GET', 'me', P.token);
  check('sigue entrando y usando la app como pasajera', me.user?.role === 'passenger' && me.user.canDrive === false);
  check('el motivo queda en su ficha', (await http('GET', `admin/users/${P.user.id}`, SA)).history?.some((h) => h.action === 'user.reject' && h.details?.note === 'La licencia está vencida'));
  check('ya no está en Solicitudes', !(await http('GET', 'admin/users?filter=pending', SA)).users?.some((x) => x.id === P.user.id));

  // ---------- Lo vuelve a pedir (la placa quedó libre) y la aprueban ----------
  const again = await http('POST', 'me/apply-driver', P.token, veh(plate));
  check('puede volver a pedirlo con la misma placa', again.user?.status === 'pending');
  await http('POST', 'me/mode', P.token, { mode: 'driver' });
  await uploadDocs(P.token);
  check('el personal la aprueba', (await http('POST', `admin/users/${P.user.id}/status`, SA, { status: 'active' })).ok === true);
  const after = await http('GET', 'me', P.token);
  check('ya es conductora aprobada', after.user?.role === 'driver' && after.user.status === 'active');
  const ok = track(await connect(P.token));
  const no = got(ok, 'driver:denied', () => true, 800);
  ok.emit('driver:online', at);
  check('y puede ponerse disponible', (await no) === null);
  check('cambia a pasajera cuando quiera', (await http('POST', 'me/mode', P.token, { mode: 'passenger' })).user?.role === 'passenger');

  // ---------- Quien se registró como conductor sigue quedando bloqueado al rechazarlo ----------
  const rd = await http('POST', `admin/users/${D.user.id}/reject`, SA, { note: 'Datos falsos' });
  const [[d]] = await pool.query('SELECT role, status FROM users WHERE id = ?', [D.user.id]);
  check('rechazar a quien se registró como conductor lo bloquea', rd.ok === true && !rd.backToPassenger && d.role === 'driver' && d.status === 'blocked');
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
