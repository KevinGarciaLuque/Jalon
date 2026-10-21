import 'dotenv/config';
// Etapa 6: indicadores y reporte de dinero por fecha, exportar a CSV y listas del panel por páginas
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';
import { API, http, registerUser, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const start = (await http('GET', 'admin/permissions', SA)).roles;
const csv = async (path, token) => {
  const r = await fetch(`${API}/api/admin/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  const bytes = Buffer.from(await r.arrayBuffer());
  // Se lee como bytes: text() quitaría la marca inicial (BOM) que necesita Excel
  return { status: r.status, type: r.headers.get('content-type') || '', name: r.headers.get('content-disposition') || '', bom: bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])), text: bytes.toString('utf8') };
};

try {
  const [a] = await pool.query("INSERT INTO users (name, phone, password_hash, role, status, totp_enabled, terms_accepted_at) VALUES ('T Admin', ?, ?, 'admin', 'active', 1, NOW())", [`57${rnd}8`.slice(0, 8), await bcrypt.hash('no-se-usa-1', 4)]);
  const ADM = jwt.sign({ id: a.insertId, role: 'admin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const D = await registerUser({ name: 'E1 Conductor', phone: `91${rnd}8`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', model: 'Corolla', plate: `M${rnd}` });
  const P = await registerUser({ name: 'E1 Pasajero', phone: `80${rnd}8`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  await registerUser({ name: 'E1 Pasajero', phone: `79${rnd}8`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' }); // para que haya más de una página

  // Permisos: al principio solo el superadmin
  check('un administrador no ve los indicadores al principio', (await http('GET', 'admin/metrics', ADM)).status === 403);
  check('ni puede exportar', (await csv('export/rides', ADM)).status === 403);

  // Indicadores de hoy, antes y después de agregar viajes
  const before = await http('GET', 'admin/metrics?preset=today', SA);
  check('el período de hoy tiene un solo día y su período anterior', before.range?.days === 1 && before.range.prev.to < before.range.from && before.daily.length === 1 && before.hours.length === 24);
  const ride = (status, price, extra = '') => pool.query(
    `INSERT INTO rides (passenger_id, driver_id, origin_lat, origin_lng, dest_lat, dest_lng, dest_text, distance_km, offered_price, final_price, status, completed_at${extra ? ', cancelled_by' : ''})
     VALUES (?, ?, 14.07, -87.19, 14.1, -87.2, ?, 4, ?, ?, ?, ${status === 'completed' ? 'NOW()' : 'NULL'}${extra ? ', ?' : ''})`,
    [P.user.id, D.user.id, '=HIPERVINCULO("x")', price, status === 'completed' ? price : null, status, ...(extra ? [extra] : [])]
  );
  const [r1] = await ride('completed', 100);
  await ride('completed', 60);
  await ride('cancelled', 80, 'driver');
  await pool.query("INSERT INTO offers (ride_id, driver_id, price, created_at) VALUES (?, ?, 100, NOW() + INTERVAL 30 SECOND)", [r1.insertId, D.user.id]);
  await pool.query("INSERT INTO wallet_entries (user_id, amount, kind, ride_id, note) VALUES (?, -10, 'commission', ?, 'prueba')", [D.user.id, r1.insertId]);
  await pool.query("INSERT INTO wallet_entries (user_id, amount, kind, note) VALUES (?, 200, 'topup', 'prueba')", [D.user.id]);
  const after = await http('GET', 'admin/metrics?preset=today', SA);
  check('cuenta los viajes completados y cancelados del día', after.kpis.completed - before.kpis.completed === 2 && after.kpis.cancelled - before.kpis.cancelled === 1);
  check('el dinero movido y la comisión', after.kpis.gmv - before.kpis.gmv === 160 && after.kpis.commission - before.kpis.commission === 10, `(+${after.kpis.gmv - before.kpis.gmv}, +${after.kpis.commission - before.kpis.commission})`);
  check('quién cancela', (after.cancelledBy.driver || 0) - (before.cancelledBy.driver || 0) === 1);
  check('pasajeros nuevos', after.kpis.newPassengers >= 1 && after.kpis.requested >= 3);
  check('tiempo hasta la primera oferta', after.kpis.firstOfferSeconds != null);
  check('la serie por día suma lo mismo', after.daily[0].completed === after.kpis.completed && after.daily[0].gmv === after.kpis.gmv);
  const week = await http('GET', 'admin/metrics?preset=7d', SA);
  check('los últimos 7 días tienen 7 días y su comparación', week.range.days === 7 && week.daily.length === 7 && !!week.previous);
  const month = await http('GET', 'admin/metrics?preset=prev_month', SA);
  check('el mes pasado empieza el día 1', month.range.from.endsWith('-01') && month.range.days >= 28);

  // Fechas exactas
  const t = after.range.from;
  check('acepta fechas exactas', (await http('GET', `admin/metrics?from=${t}&to=${t}`, SA)).kpis?.completed === after.kpis.completed);
  check('rechaza un fin antes del inicio', (await http('GET', `admin/metrics?from=${t}&to=2020-01-01`, SA)).status === 400);
  check('rechaza más de un año', (await http('GET', 'admin/metrics?from=2020-01-01&to=2022-01-01', SA)).status === 400);
  check('rechaza fechas inválidas', (await http('GET', 'admin/metrics?from=2026-02-30&to=2026-03-01', SA)).status === 400);

  // Reporte de dinero
  const fin = await http('GET', 'admin/finance?preset=today', SA);
  check('el reporte de dinero trae comisiones y recargas del día', fin.totals?.commission >= 10 && fin.totals.topups >= 200 && fin.days.length === 1);
  check('y el saldo total de los conductores', typeof fin.driversBalance?.total === 'number');

  // Exportar
  const rides = await csv('export/rides?preset=today', SA);
  check('exporta los viajes en CSV', rides.status === 200 && rides.type.startsWith('text/csv') && /jalon-viajes-/.test(rides.name));
  check('con la marca para que Excel lea las tildes y sus columnas', rides.bom && rides.text.split('\r\n')[0].includes('precio_final'));
  check('incluye los viajes del período', rides.text.includes(`\r\n${r1.insertId},`));
  check('un texto que parece fórmula no se ejecuta en Excel', rides.text.includes(`'=HIPERVINCULO(""x"")`) && !rides.text.includes(',=HIPERVINCULO'));
  for (const kind of ['ledger', 'topups', 'rentals', 'users']) {
    const r = await csv(`export/${kind}?preset=today`, SA);
    check(`exporta ${kind}`, r.status === 200 && r.text.length > 5);
  }
  check('una exportación que no existe da 404', (await csv('export/claves', SA)).status === 404);
  const log = await http('GET', 'admin/audit', SA);
  check('cada exportación queda en el registro', log.filter((l) => l.action === 'export.csv').length >= 5);

  // Permiso por rol
  await http('PUT', 'admin/permissions/admin', SA, { perms: [...start.admin, 'metrics', 'export'] });
  check('con el permiso, el administrador ve los indicadores', (await http('GET', 'admin/metrics?preset=today', ADM)).status === 200);
  check('y puede exportar', (await csv('export/rides?preset=today', ADM)).status === 200);

  // Listas por páginas, con búsqueda en el servidor
  const p1 = await http('GET', 'admin/users?filter=people&limit=2', SA);
  check('la lista de usuarios viene por páginas', p1.users?.length === 2 && p1.hasMore === true && p1.users.every((u) => ['passenger', 'driver'].includes(u.role)));
  const p2 = await http('GET', 'admin/users?filter=people&limit=2&offset=2', SA);
  check('la página siguiente trae otros', p2.users.length >= 1 && !p2.users.some((u) => p1.users.some((x) => x.id === u.id)));
  const found = await http('GET', `admin/users?filter=people&limit=50&q=${P.user.phone}`, SA);
  check('la búsqueda se hace en el servidor (no solo entre los primeros)', found.users.length === 1 && found.users[0].id === P.user.id);
  check('la búsqueda no se rompe con caracteres especiales', (await http('GET', 'admin/users?limit=5&q=%25_', SA)).status === 200);
  const staff = await http('GET', 'admin/users?filter=staff&limit=50', SA);
  check('el filtro del personal trae solo personal', staff.users.length >= 1 && staff.users.every((u) => ['superadmin', 'admin', 'support'].includes(u.role)));
  const pend = await http('GET', 'admin/users?filter=pending&limit=50', SA);
  check('el filtro de pendientes trae conductores por aprobar', pend.users.some((u) => u.id === D.user.id) && pend.users.every((u) => u.status === 'pending'));
  const rp = await http('GET', 'admin/rides?status=completed&limit=1', SA);
  check('los viajes también, con filtro de estado', rp.length === 1 && rp[0].status === 'completed');
  check('el registro también', (await http('GET', 'admin/audit?limit=3', SA)).length === 3);
  check('sin tamaño de página, todo sigue como antes', Array.isArray(await http('GET', 'admin/rides', SA)));
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
} finally {
  for (const role of ['admin', 'support', 'driver', 'passenger']) await http('PUT', `admin/permissions/${role}`, SA, { perms: start[role] });
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
