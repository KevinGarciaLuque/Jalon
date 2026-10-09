// Migración de documentos guardados antes del cifrado: se limpian y se cifran una sola vez
import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import { pool } from './db.js';
import { sanitizeJpeg } from './jpeg.js';
import { encryptBuffer } from './secure.js';

export async function encryptLegacyDocuments(uploadsDir) {
  const [rows] = await pool.query("SELECT id, user_id, type, file FROM documents WHERE file NOT LIKE '%.enc'");
  let done = 0;
  for (const d of rows) {
    const old = path.join(uploadsDir, d.file);
    let plain;
    try {
      plain = await fs.readFile(old);
    } catch {
      console.warn(`Documento ${d.id}: no se encontró el archivo ${d.file}`);
      continue;
    }
    let content = plain;
    try { content = sanitizeJpeg(plain).buf; } catch { /* si no se puede limpiar, se cifra tal cual */ }
    const file = `${d.user_id}-${d.type}-${crypto.randomBytes(8).toString('hex')}.enc`;
    await fs.writeFile(path.join(uploadsDir, file), encryptBuffer(content));
    await pool.query('UPDATE documents SET file = ? WHERE id = ?', [file, d.id]);
    await fs.rm(old, { force: true });
    done++;
  }
  return done;
}
