// Cifrado de los respaldos con BACKUP_KEY (32 bytes en base64), aparte de DATA_KEY: quien tenga la copia sin la llave no puede leerla.
// Formato: KTB1 + 12 bytes al azar + contenido cifrado (AES-256-GCM) + 16 bytes de control (detecta cualquier alteración).
import crypto from 'crypto';
import fs from 'fs';
import { pipeline } from 'stream/promises';
import { s3Missing } from './s3.js';

const MAGIC = Buffer.from('KTB1'); // versión del formato del archivo cifrado

export function backupKey() {
  const k = Buffer.from(process.env.BACKUP_KEY || '', 'base64');
  return k.length === 32 ? k : null;
}
export const backupMissing = () => [...s3Missing(), ...(backupKey() ? [] : [process.env.BACKUP_KEY ? 'BACKUP_KEY (debe ser de 32 bytes en base64)' : 'BACKUP_KEY'])];
export const backupConfigured = () => backupMissing().length === 0;

export async function encryptFile(src, dest, key = backupKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const out = fs.createWriteStream(dest, { mode: 0o600 });
  out.write(Buffer.concat([MAGIC, iv]));
  await pipeline(fs.createReadStream(src), cipher, out, { end: false });
  await new Promise((r, j) => out.end(cipher.getAuthTag(), (e) => (e ? j(e) : r())));
}
export async function decryptFile(src, dest, key = backupKey()) {
  if (!key) throw new Error('Falta BACKUP_KEY (la llave con la que se cifraron los respaldos)');
  const { size } = await fs.promises.stat(src);
  const fd = await fs.promises.open(src, 'r');
  const head = Buffer.alloc(16);
  const tag = Buffer.alloc(16);
  await fd.read(head, 0, 16, 0);
  await fd.read(tag, 0, 16, size - 16);
  await fd.close();
  if (size < 32 || !head.subarray(0, 4).equals(MAGIC)) throw new Error('El archivo no es un respaldo cifrado de Ktracho GO');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, head.subarray(4, 16)).setAuthTag(tag);
  try {
    await pipeline(fs.createReadStream(src, { start: 16, end: size - 17 }), decipher, fs.createWriteStream(dest, { mode: 0o600 }));
  } catch (e) {
    await fs.promises.rm(dest, { force: true });
    throw /auth|unable to authenticate/i.test(e.message) ? new Error('No se pudo descifrar: la BACKUP_KEY no es la correcta o el archivo está dañado') : e;
  }
}
export function encryptBuffer(buf, key = backupKey()) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  return Buffer.concat([MAGIC, iv, cipher.update(buf), cipher.final(), cipher.getAuthTag()]);
}
export function decryptBuffer(buf, key = backupKey()) {
  if (buf.length < 32 || !buf.subarray(0, 4).equals(MAGIC)) throw new Error('No es un archivo cifrado de Ktracho GO');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, buf.subarray(4, 16)).setAuthTag(buf.subarray(-16));
  return Buffer.concat([decipher.update(buf.subarray(16, -16)), decipher.final()]);
}
