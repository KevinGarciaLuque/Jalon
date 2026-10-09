// Corre todas las pruebas en orden y siempre limpia los datos de prueba, aunque alguna falle.
// Levanta su propio servidor (puerto TEST_PORT, 4500 por defecto) para no depender de uno ya corriendo ni de su modo de vigilancia de archivos.
// Si defines API_URL, usa ese servidor y no levanta ninguno.
import { spawn, spawnSync } from 'child_process';
import { generateKeys } from '../src/push.js';

// Las pruebas usan SU PROPIA base de datos (<nombre>_test), creada desde cero en cada ejecución: así no se mezclan con tus datos
// de desarrollo ni con otro servidor que comparta la base y haga tareas de fondo (cancelar viajes vencidos, reenviar avisos).
// Si defines MYSQL_URL (p. ej. en el CI, donde la base es desechable) se usa esa tal cual.
let testDb = null;
if (!process.env.MYSQL_URL) {
  const { dbConfig, DB_NAME } = await import('../src/db.js');
  const mysql = (await import('mysql2/promise')).default;
  testDb = `${DB_NAME}_test`;
  const conn = await mysql.createConnection(dbConfig);
  await conn.query(`DROP DATABASE IF EXISTS \`${testDb}\``);
  await conn.query(`CREATE DATABASE \`${testDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.end();
  process.env.DB_NAME = testDb;
  const setup = spawnSync(process.execPath, ['src/setup.js'], { env: process.env, encoding: 'utf8' });
  if (setup.status !== 0) { console.error(setup.stderr || setup.stdout); process.exit(1); }
  console.log(`Base de datos de pruebas: ${testDb} (nueva)`);
}

const external = !!process.env.API_URL;
const port = process.env.TEST_PORT || '4500';
const apiUrl = process.env.API_URL || `http://localhost:${port}`;
// Llaves de notificaciones solo para estas pruebas (si no hay unas definidas)
const vapid = process.env.VAPID_PUBLIC_KEY ? {} : (({ publicKey, privateKey }) => ({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey }))(generateKeys());
// Tiempos cortos solo para las pruebas (en producción valen los de verdad)
const env = { RACE_ROUNDS: '10', OFFER_TTL_SECONDS: '3', OFFER_SWEEP_MS: '500', RAISE_COOLDOWN_MS: '700', ETA_EVERY_MS: '2500', ...process.env, ...vapid, API_URL: apiUrl, SOS_ALERT_PHONES: process.env.SOS_ALERT_PHONES || '99990001,99990002' };

let server = null;
if (!external) {
  server = spawn(process.execPath, ['src/index.js'], { env: { ...env, PORT: port }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => (log += d));
  server.stderr.on('data', (d) => (log += d));
  server.on('exit', (code) => code && console.error(`El servidor de pruebas terminó con código ${code}\n${log.slice(-1500)}`));
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    up = await fetch(`${apiUrl}/api/health`).then((r) => r.ok, () => false);
    if (!up) await new Promise((r) => setTimeout(r, 500));
  }
  if (!up) {
    console.error(`No arrancó el servidor de pruebas en ${apiUrl}\n${log.slice(-1500)}`);
    server.kill();
    process.exit(1);
  }
  console.log(`Servidor de pruebas en ${apiUrl}`);
}

let failed = false;
for (const t of (process.env.ONLY || 'sw-unit,flow,phase3,phase4,phase5b,phase6,phase7,phase7b,phase7c,phase8a,phase8b,phase8c,race,expiry').split(',')) {
  const r = spawnSync(process.execPath, [`test/${t}.mjs`], { stdio: 'inherit', env });
  if (r.status !== 0) failed = true;
}
spawnSync(process.execPath, ['test/cleanup.mjs'], { stdio: 'inherit', env });
server?.kill();
process.exit(failed ? 1 : 0);
