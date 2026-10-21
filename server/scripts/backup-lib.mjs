// Lo que comparten el respaldo y la restauración: cómo se leen las tablas y su «huella» para comprobar que nada cambió.
import crypto from 'crypto';
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

// Revisión del negocio: el saldo de cada conductor debe ser la suma de sus movimientos
export async function balanceIssues(conn) {
  const [rows] = await conn.query(
    `SELECT u.id, u.balance, COALESCE(SUM(w.amount), 0) AS movimientos FROM users u LEFT JOIN wallet_entries w ON w.user_id = u.id
     WHERE u.role = 'driver' GROUP BY u.id, u.balance HAVING ABS(u.balance - movimientos) > 0.009`
  );
  return rows;
}
