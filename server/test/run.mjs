// Corre las pruebas en orden y siempre limpia los datos de prueba, aunque alguna falle
import { spawnSync } from 'child_process';

let failed = false;
for (const t of ['flow', 'phase3', 'phase4', 'expiry']) {
  const r = spawnSync(process.execPath, [`test/${t}.mjs`], { stdio: 'inherit' });
  if (r.status !== 0) failed = true;
}
spawnSync(process.execPath, ['test/cleanup.mjs'], { stdio: 'inherit' });
process.exit(failed ? 1 : 0);
