// Corre todas las pruebas en orden y siempre limpia los datos de prueba, aunque alguna falle.
// Levanta su propio servidor (puerto TEST_PORT, 4500 por defecto) para no depender de uno ya corriendo ni de su modo de vigilancia de archivos.
// Si defines API_URL, usa ese servidor y no levanta ninguno.
import { spawn, spawnSync } from 'child_process';
import { generateKeys } from '../src/push.js';

const external = !!process.env.API_URL;
const port = process.env.TEST_PORT || '4500';
const apiUrl = process.env.API_URL || `http://localhost:${port}`;
// Llaves de notificaciones solo para estas pruebas (si no hay unas definidas)
const vapid = process.env.VAPID_PUBLIC_KEY ? {} : (({ publicKey, privateKey }) => ({ VAPID_PUBLIC_KEY: publicKey, VAPID_PRIVATE_KEY: privateKey }))(generateKeys());
const env = { RACE_ROUNDS: '10', ...process.env, ...vapid, API_URL: apiUrl, SOS_ALERT_PHONES: process.env.SOS_ALERT_PHONES || '99990001,99990002' };

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
for (const t of ['sw-unit', 'flow', 'phase3', 'phase4', 'phase5b', 'phase6', 'phase7', 'phase7b', 'phase7c', 'phase8a', 'race', 'expiry']) {
  const r = spawnSync(process.execPath, [`test/${t}.mjs`], { stdio: 'inherit', env });
  if (r.status !== 0) failed = true;
}
spawnSync(process.execPath, ['test/cleanup.mjs'], { stdio: 'inherit', env });
server?.kill();
process.exit(failed ? 1 : 0);
