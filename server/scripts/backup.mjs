// Respaldo completo de la base: npm run backup
// Deja un archivo .sql.gz en server/backups (o en BACKUP_DIR) que se puede restaurar con «npm run restore» o con el cliente de MySQL.
// Para respaldar la base de Railway desde tu computadora: define MYSQL_URL con la dirección pública de la base (MYSQL_PUBLIC_URL en Railway).
// (El servidor además hace uno cada noche y lo sube cifrado fuera de Railway: src/services/backups.js)
import fs from 'fs';
import path from 'path';
import { dumpDatabase, DB_NAME } from './backup-lib.mjs';

const dir = path.resolve(process.env.BACKUP_DIR || path.join(import.meta.dirname, '..', 'backups'));
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? '-' : '')); // 20261021-1530 (UTC)
const file = path.join(dir, `${DB_NAME}-${stamp}.sql.gz`);

try {
  const manifest = await dumpDatabase(file, { log: console.log });
  const total = Object.values(manifest.tables).reduce((a, t) => a + t.rows, 0);
  console.log(`\nRespaldo listo: ${file}\n${Object.keys(manifest.tables).length} tablas, ${total} filas, ${(fs.statSync(file).size / 1024).toFixed(0)} kB.`);
  console.log('Lleva datos personales y contraseñas cifradas: guárdalo en un lugar privado (no en el repositorio ni en un correo).');
  console.log(`Para comprobar que se puede restaurar: npm run restore -- "${file}"`);
} catch (e) {
  console.error(`No se pudo hacer el respaldo: ${e.message}`);
  process.exitCode = 1;
}
