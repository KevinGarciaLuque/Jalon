// Respaldo completo de la base: npm run backup
// Deja un archivo .sql.gz en server/backups (o en BACKUP_DIR) que se puede restaurar con «npm run restore» o con el cliente de MySQL.
// Para respaldar la base de Railway desde tu computadora: define MYSQL_URL con la dirección pública de la base (MYSQL_PUBLIC_URL en Railway).
// Todo se lee dentro de una misma transacción: es una foto consistente aunque la app siga funcionando.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { connect, tablesOf, shapeOf, rowsOf, digest, q, DB_NAME, FORMAT } from './backup-lib.mjs';

const dir = path.resolve(process.env.BACKUP_DIR || path.join(import.meta.dirname, '..', 'backups'));
fs.mkdirSync(dir, { recursive: true });
const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? '-' : '')); // 20261021-1530 (UTC)
const file = path.join(dir, `${DB_NAME}-${stamp}.sql.gz`);
const tmp = `${file}.partial`;

const conn = await connect(DB_NAME);
const gz = zlib.createGzip({ level: 9 });
const out = fs.createWriteStream(tmp, { mode: 0o600 }); // datos personales: solo lo lee quien lo creó
gz.pipe(out);
const write = (s) => (gz.write(s) ? null : new Promise((r) => gz.once('drain', r)));

try {
  await conn.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await conn.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
  const startedAt = new Date().toISOString();
  await write(`-- Respaldo de Jalón · base ${DB_NAME} · ${startedAt} (UTC)\n-- Restaurar: npm run restore -- <este archivo>   (o: gunzip -c archivo | mysql <base vacía>)\n`);
  await write("SET NAMES utf8mb4;\nSET time_zone = '+00:00';\nSET FOREIGN_KEY_CHECKS = 0;\nSET UNIQUE_CHECKS = 0;\n");
  const manifest = { format: FORMAT, database: DB_NAME, at: startedAt, tables: {} };
  for (const t of await tablesOf(conn, DB_NAME)) {
    const [[create]] = await conn.query(`SHOW CREATE TABLE ${q(t)}`);
    // Cada sentencia en una sola línea (así se restaura leyendo línea por línea)
    await write(`DROP TABLE IF EXISTS ${q(t)};\n${create['Create Table'].replace(/\s*\n\s*/g, ' ')};\n`);
    const shape = await shapeOf(conn, DB_NAME, t);
    const d = digest();
    for await (const rows of rowsOf(conn, t, shape)) {
      rows.forEach((r) => d.add(r));
      for (let i = 0; i < rows.length; i += 500) {
        const values = rows.slice(i, i + 500).map((r) => `(${r.map((v) => conn.escape(v)).join(',')})`).join(',');
        await write(`INSERT INTO ${q(t)} (${shape.columns.map(q).join(',')}) VALUES ${values};\n`);
      }
    }
    manifest.tables[t] = d.done();
    console.log(`  ${t.padEnd(22)} ${String(manifest.tables[t].rows).padStart(7)} filas`);
  }
  await conn.query('COMMIT');
  await write(`SET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n-- jalon-manifest ${JSON.stringify(manifest)}\n`);
  gz.end();
  await new Promise((resolve, reject) => out.on('finish', resolve).on('error', reject));
  fs.renameSync(tmp, file); // el archivo solo aparece cuando está completo
  const total = Object.values(manifest.tables).reduce((a, t) => a + t.rows, 0);
  console.log(`\nRespaldo listo: ${file}\n${Object.keys(manifest.tables).length} tablas, ${total} filas, ${(fs.statSync(file).size / 1024).toFixed(0)} kB.`);
  console.log('Lleva datos personales y contraseñas cifradas: guárdalo en un lugar privado (no en el repositorio ni en un correo).');
  console.log(`Para comprobar que se puede restaurar: npm run restore -- "${file}"`);
} catch (e) {
  gz.destroy();
  out.destroy();
  fs.rmSync(tmp, { force: true });
  console.error(`No se pudo hacer el respaldo: ${e.message}`);
  process.exitCode = 1;
} finally {
  await conn.end();
}
