// Cifrado de datos sensibles en reposo (documentos de conductores y secretos de la verificación en dos pasos).
// AES-256-GCM: cifra y además detecta cualquier alteración. La llave sale de DATA_KEY (32 bytes en base64).
// Si DATA_KEY no está definida se deriva de JWT_SECRET: funciona, pero rotar JWT_SECRET haría ilegible lo cifrado.
//   Generar una:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
// Cambiar de llave no pierde nada: lo cifrado con una llave anterior se sigue leyendo y, al arrancar, se vuelve a cifrar
// con la actual (rekey.js). Llaves anteriores: la derivada de JWT_SECRET (al poner DATA_KEY por primera vez) y DATA_KEY_OLD
// (al cambiar una DATA_KEY por otra). Nunca quites DATA_KEY una vez puesta: lo cifrado con ella dejaría de leerse.
import crypto from 'crypto';

const MAGIC = Buffer.from('JE1'); // versión del formato, por si algún día cambia

function parseKey(b64, name) {
  const k = Buffer.from(b64, 'base64');
  if (k.length !== 32) throw new Error(`${name} debe ser de 32 bytes en base64`);
  return k;
}
const derivedKey = () => Buffer.from(crypto.hkdfSync('sha256', process.env.JWT_SECRET || 'dev-secret', 'jalon-data-key', 'v1', 32));

const KEY = process.env.DATA_KEY ? parseKey(process.env.DATA_KEY, 'DATA_KEY') : derivedKey();
const OLD_KEYS = [
  ...(process.env.DATA_KEY ? [derivedKey()] : []),
  ...(process.env.DATA_KEY_OLD ? [parseKey(process.env.DATA_KEY_OLD, 'DATA_KEY_OLD')] : []),
].filter((k) => !k.equals(KEY));
export const keyIsDerived = !process.env.DATA_KEY;
export const hasOldKeys = OLD_KEYS.length > 0;

export function encryptBuffer(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

function decryptWith(key, blob) {
  const iv = blob.subarray(3, 15);
  const tag = blob.subarray(15, 31);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(31)), decipher.final()]); // lanza error si fue alterado o es otra llave
}

// Descifra con la llave actual o, si no, con una anterior. `current` dice si ya está con la actual.
export function openBuffer(blob) {
  if (blob.length < MAGIC.length + 28 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Formato cifrado inválido');
  let error;
  for (const [i, key] of [KEY, ...OLD_KEYS].entries()) {
    try {
      return { plain: decryptWith(key, blob), current: i === 0 };
    } catch (e) {
      error = e;
    }
  }
  throw error;
}

export const decryptBuffer = (blob) => openBuffer(blob).plain;

export const isEncrypted = (blob) => blob.length > 3 && blob.subarray(0, 3).equals(MAGIC);
export const encryptText = (text) => encryptBuffer(Buffer.from(text, 'utf8')).toString('base64');
export const decryptText = (b64) => decryptBuffer(Buffer.from(b64, 'base64')).toString('utf8');
