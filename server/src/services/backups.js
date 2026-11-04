// Respaldo automático: cada noche (BACKUP_HOUR, 3 a. m. de Honduras por defecto) el servidor
//   1. respalda la base completa (lo mismo que «npm run backup»),
//   2. lo cifra con BACKUP_KEY y lo sube al almacenamiento externo (src/s3.js) en db/,
//   3. copia ahí también los documentos, selfies y comprobantes (uploads/) que sean nuevos o hayan cambiado,
//   4. borra los respaldos de la base de más de BACKUP_KEEP_DAYS días (30) y, de los documentos que ya no existen en la app,
//      la copia a los mismos días de haberse borrado (así un documento borrado se puede recuperar un tiempo, pero no para siempre).
// Sin BACKUP_KEY no se descifra nada: guárdala también fuera de Railway (y DATA_KEY, con la que ya van cifrados los documentos).
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pool } from '../db.js';
import { reportError, UPLOADS } from '../config.js';
import { pushStaff } from '../notify.js';
import { dumpDatabase, DB_NAME } from '../../scripts/backup-lib.mjs';
import * as s3 from '../s3.js';
import { backupConfigured, backupMissing, encryptFile, encryptBuffer, decryptBuffer } from '../backupCrypto.js';

export { backupConfigured, backupMissing };

export const KEEP_DAYS = Number(process.env.BACKUP_KEEP_DAYS || 30);
export const BACKUP_HOUR = Number(process.env.BACKUP_HOUR ?? 3); // hora de Honduras
const FILES_INDEX = 'uploads/_indice.json'; // qué documentos hay copiados y cuándo se borraron de la app

// ---------- Documentos: se copian solo los nuevos o cambiados ----------
async function walk(dir, base = dir) {
  const out = [];
  let entries = [];
  try { entries = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...(await walk(full, base)));
    else if (e.isFile() && !e.name.startsWith('.')) out.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return out;
}

export async function syncUploads(now = new Date()) {
  const raw = await s3.getBuffer(FILES_INDEX);
  const index = raw ? JSON.parse(decryptBuffer(raw).toString()) : { files: {}, removed: {} };
  const local = new Set(await walk(UPLOADS));
  let uploaded = 0;
  let deleted = 0;
  for (const name of local) {
    const st = await fs.promises.stat(path.join(UPLOADS, name));
    const mark = `${st.size}:${Math.floor(st.mtimeMs)}`;
    delete index.removed[name];
    if (index.files[name] === mark) continue;
    await s3.putBuffer(`uploads/${name}.enc`, encryptBuffer(await fs.promises.readFile(path.join(UPLOADS, name))));
    index.files[name] = mark;
    uploaded++;
  }
  // Lo que ya no está en la app se guarda KEEP_DAYS días más y luego se borra de la copia
  for (const name of Object.keys(index.files)) {
    if (local.has(name)) continue;
    index.removed[name] ||= now.toISOString();
    if (now - new Date(index.removed[name]) >= KEEP_DAYS * 86400e3) {
      await s3.remove(`uploads/${name}.enc`);
      delete index.files[name];
      delete index.removed[name];
      deleted++;
    }
  }
  await s3.putBuffer(FILES_INDEX, encryptBuffer(Buffer.from(JSON.stringify(index))));
  return { uploaded, deleted, total: local.size };
}

// Respaldos de la base de más de KEEP_DAYS días se borran (siempre quedan al menos los 3 últimos)
async function pruneDatabase(now = new Date()) {
  const all = (await s3.list('db/')).filter((o) => o.key.endsWith('.sql.gz.enc')).sort((a, b) => new Date(b.modified) - new Date(a.modified));
  let n = 0;
  for (const o of all.slice(3)) {
    if (now - new Date(o.modified) >= KEEP_DAYS * 86400e3) { await s3.remove(o.key); n++; }
  }
  return n;
}

// ---------- Un respaldo completo ----------
let running = false;
export async function runBackup({ trigger = 'auto', actor = null } = {}) {
  if (!backupConfigured()) throw Object.assign(new Error(`Faltan variables en Railway: ${backupMissing().join(', ')}`), { status: 409 });
  if (running) throw Object.assign(new Error('Ya se está haciendo un respaldo'), { status: 409 });
  // Un solo respaldo a la vez aunque haya varias copias del servidor
  const lock = await pool.getConnection();
  const [[{ got }]] = await lock.query("SELECT GET_LOCK('ktracho_backup', 0) AS got");
  if (!got) { lock.release(); throw Object.assign(new Error('Ya se está haciendo un respaldo'), { status: 409 }); }
  running = true;
  const [r] = await pool.query("INSERT INTO backups (status, `trigger`, created_by) VALUES ('running', ?, ?)", [trigger, actor]);
  const id = r.insertId;
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'ktracho-respaldo-'));
  try {
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, (c) => (c === 'T' ? '-' : ''));
    const plain = path.join(dir, `${DB_NAME}-${stamp}.sql.gz`);
    const manifest = await dumpDatabase(plain);
    await encryptFile(plain, `${plain}.enc`);
    await fs.promises.rm(plain, { force: true }); // sin cifrar no queda en ningún lado
    const key = `db/${path.basename(plain)}.enc`;
    const bytes = await s3.putFile(key, `${plain}.enc`);
    const files = await syncUploads();
    const pruned = await pruneDatabase();
    const rows = Object.values(manifest.tables).reduce((a, t) => a + t.rows, 0);
    await pool.query(
      "UPDATE backups SET status = 'ok', finished_at = NOW(), object_key = ?, bytes = ?, tables_count = ?, rows_count = ?, files_total = ?, files_uploaded = ?, files_deleted = ?, pruned = ? WHERE id = ?",
      [key, bytes, Object.keys(manifest.tables).length, rows, files.total, files.uploaded, files.deleted, pruned, id]
    );
    return { id, key, bytes, rows, files, pruned };
  } catch (e) {
    await pool.query("UPDATE backups SET status = 'failed', finished_at = NOW(), error = ? WHERE id = ?", [String(e.message).slice(0, 500), id]);
    reportError(e);
    pushStaff({ title: 'Falló el respaldo de la base de datos', body: `${String(e.message).slice(0, 120)} · Revisa Panel → Sistema`, tag: 'backup-failed', url: '/' }, 'settings');
    throw e;
  } finally {
    running = false;
    await fs.promises.rm(dir, { recursive: true, force: true });
    await lock.query("SELECT RELEASE_LOCK('ktracho_backup')").catch(() => {});
    lock.release();
  }
}

export async function recentBackups(limit = 10) {
  const [rows] = await pool.query(
    'SELECT id, status, `trigger`, started_at, finished_at, bytes, rows_count, files_total, files_uploaded, error FROM backups ORDER BY id DESC LIMIT ?', [limit]
  );
  return rows;
}

// ---------- Cada noche ----------
// Cada 10 minutos: si ya pasó la hora del respaldo de hoy (hora de Honduras) y no hay uno bueno de hoy, se hace.
// Si falla se reintenta a la hora, hasta 3 veces por día.
const hnDay = (d = new Date()) => new Date(d.getTime() - 6 * 3600e3).toISOString().slice(0, 10);
export async function backupDue(now = new Date()) {
  if (!backupConfigured() || running) return false;
  if (new Date(now.getTime() - 6 * 3600e3).getUTCHours() < BACKUP_HOUR) return false;
  const [rows] = await pool.query("SELECT status, started_at FROM backups WHERE `trigger` = 'auto' AND started_at >= ? - INTERVAL 1 DAY ORDER BY id DESC", [now]);
  const today = rows.filter((b) => hnDay(new Date(b.started_at)) === hnDay(now));
  if (today.some((b) => b.status === 'ok' || b.status === 'running')) return false;
  if (today.length >= 3) return false;
  return !today[0] || now - new Date(today[0].started_at) >= 3600e3;
}

export function scheduleBackups() {
  const tick = async () => {
    // Un respaldo que quedó «haciéndose» porque el servidor se reinició a medias se marca como fallido
    await pool.query("UPDATE backups SET status = 'failed', finished_at = NOW(), error = 'El servidor se reinició mientras se hacía' WHERE status = 'running' AND started_at < NOW() - INTERVAL 2 HOUR");
    if (await backupDue()) await runBackup().catch(() => {}); // el fallo ya quedó anotado y avisado
  };
  setInterval(() => tick().catch(reportError), Number(process.env.BACKUP_SWEEP_MS || 10 * 60 * 1000)).unref();
}
