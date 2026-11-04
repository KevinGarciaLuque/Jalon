// Lo que comparten el respaldo y la restauración: cómo se leen las tablas y su «huella» para comprobar que nada cambió.
import crypto from 'crypto';
import fs from 'fs';
import zlib from 'zlib';
import mysql from 'mysql2/promise';
import { dbConfig, DB_NAME } from '../src/db.js';

export { DB_NAME };
export const FORMAT = 1;
const CHUNK = 2000;

// Conexión para respaldar o restaurar: fechas tal cual vienen (sin pasar por JavaScript), JSON como texto
// y la hora en UTC, para que las TIMESTAMP no se corran 6 horas al restaurar en otro servidor.
export async function connect(database) {
  const conn = await mysql.createConnection({
    ...dbConfig,
    database,
    dateStrings: true,
    supportBigNumbers: true,
    bigNumberStrings: true,
    multipleStatements: false,
    typeCast: (field, next) => (field.type === 'JSON' ? field.string() : next()),
  });
  await conn.query("SET time_zone = '+00:00'");
  await conn.query('SET NAMES utf8mb4');
  return conn;
}

export const q = (name) => `\`${String(name).replace(/`/g, '``')}\``;

// Tablas de la base (sin vistas), en orden alfabético
export async function tablesOf(conn, database) {
  const [rows] = await conn.query("SELECT table_name AS t FROM information_schema.tables WHERE table_schema = ? AND table_type = 'BASE TABLE' ORDER BY table_name", [database]);
  return rows.map((r) => r.t);
}

// Columnas que se guardan (las calculadas por MySQL no se pueden insertar) y el orden estable de las filas (llave primaria)
export async function shapeOf(conn, database, table) {
  const [cols] = await conn.query(
    'SELECT column_name AS c, extra AS e, column_key AS k FROM information_schema.columns WHERE table_schema = ? AND table_name = ? ORDER BY ordinal_position',
    [database, table]
  );
  const columns = cols.filter((c) => !/VIRTUAL GENERATED|STORED GENERATED/i.test(c.e)).map((c) => c.c);
  const [pk] = await conn.query(
    "SELECT column_name AS c FROM information_schema.key_column_usage WHERE table_schema = ? AND table_name = ? AND constraint_name = 'PRIMARY' ORDER BY ordinal_position",
    [database, table]
  );
  return { columns, order: (pk.length ? pk.map((p) => p.c) : columns).map(q).join(', ') };
}

// Recorre las filas de una tabla de a poco (para tablas grandes) en un orden estable
export async function* rowsOf(conn, table, { columns, order }) {
  for (let offset = 0; ; offset += CHUNK) {
    const [rows] = await conn.query({ sql: `SELECT ${columns.map(q).join(', ')} FROM ${q(table)} ORDER BY ${order} LIMIT ? OFFSET ?`, rowsAsArray: true }, [CHUNK, offset]);
    if (!rows.length) return;
    yield rows;
    if (rows.length < CHUNK) return;
  }
}

// Huella de una tabla: cambia si cambia cualquier valor de cualquier fila
export function digest() {
  const h = crypto.createHash('sha256');
  let rows = 0;
  return {
    add(row) {
      h.update(JSON.stringify(row.map((v) => (Buffer.isBuffer(v) ? `x:${v.toString('hex')}` : v))));
      h.update('\n');
      rows++;
    },
    done: () => ({ rows, hash: h.digest('hex') }),
  };
}

// La huella de todas las tablas de una base (para comparar la restaurada con el respaldo)
export async function fingerprint(conn, database) {
  const out = {};
  for (const t of await tablesOf(conn, database)) {
    const shape = await shapeOf(conn, database, t);
    const d = digest();
    for await (const rows of rowsOf(conn, t, shape)) rows.forEach((r) => d.add(r));
    out[t] = d.done();
  }
  return out;
}

// Escribe el respaldo completo de la base en «file» (.sql.gz). Lo usan «npm run backup» y el respaldo automático del servidor.
// Todo se lee dentro de una misma transacción: es una foto consistente aunque la app siga funcionando.
// El archivo solo aparece cuando está completo. Devuelve el resumen (tablas, filas y huella de cada una).
export async function dumpDatabase(file, { log = () => {} } = {}) {
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
    await write(`-- Respaldo de Ktracho GO · base ${DB_NAME} · ${startedAt} (UTC)\n-- Restaurar: npm run restore -- <este archivo>   (o: gunzip -c archivo | mysql <base vacía>)\n`);
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
      log(`  ${t.padEnd(22)} ${String(manifest.tables[t].rows).padStart(7)} filas`);
    }
    await conn.query('COMMIT');
    await write(`SET FOREIGN_KEY_CHECKS = 1;\nSET UNIQUE_CHECKS = 1;\n-- jalon-manifest ${JSON.stringify(manifest)}\n`);
    gz.end();
    await new Promise((resolve, reject) => out.on('finish', resolve).on('error', reject));
    fs.renameSync(tmp, file);
    return manifest;
  } catch (e) {
    gz.destroy();
    out.destroy();
    fs.rmSync(tmp, { force: true });
    throw e;
  } finally {
    await conn.end();
  }
}

// Revisión del negocio: el saldo de cada conductor debe ser la suma de sus movimientos
export async function balanceIssues(conn) {
  const [rows] = await conn.query(
    `SELECT u.id, u.balance, COALESCE(SUM(w.amount), 0) AS movimientos FROM users u LEFT JOIN wallet_entries w ON w.user_id = u.id
     WHERE u.role = 'driver' GROUP BY u.id, u.balance HAVING ABS(u.balance - movimientos) > 0.009`
  );
  return rows;
}
