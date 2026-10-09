// Cifrado de datos sensibles en reposo (documentos de conductores y secretos de la verificación en dos pasos).
// AES-256-GCM: cifra y además detecta cualquier alteración. La llave sale de DATA_KEY (32 bytes en base64).
// Si DATA_KEY no está definida se deriva de JWT_SECRET: funciona, pero rotar JWT_SECRET haría ilegible lo cifrado.
//   Generar una:  node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
import crypto from 'crypto';

const MAGIC = Buffer.from('JE1'); // versión del formato, por si algún día cambia

function loadKey() {
  if (process.env.DATA_KEY) {
    const k = Buffer.from(process.env.DATA_KEY, 'base64');
    if (k.length !== 32) throw new Error('DATA_KEY debe ser de 32 bytes en base64');
    return { key: k, derived: false };
  }
  const k = Buffer.from(crypto.hkdfSync('sha256', process.env.JWT_SECRET || 'dev-secret', 'jalon-data-key', 'v1', 32));
  return { key: k, derived: true };
}

const { key: KEY, derived: KEY_DERIVED } = loadKey();
export const keyIsDerived = KEY_DERIVED;

export function encryptBuffer(plain) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([MAGIC, iv, cipher.getAuthTag(), body]);
}

export function decryptBuffer(blob) {
  if (blob.length < MAGIC.length + 28 || !blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('Formato cifrado inválido');
  const iv = blob.subarray(3, 15);
  const tag = blob.subarray(15, 31);
  const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(blob.subarray(31)), decipher.final()]); // lanza error si fue alterado
}

export const isEncrypted = (blob) => blob.length > 3 && blob.subarray(0, 3).equals(MAGIC);
export const encryptText = (text) => encryptBuffer(Buffer.from(text, 'utf8')).toString('base64');
export const decryptText = (b64) => decryptBuffer(Buffer.from(b64, 'base64')).toString('utf8');
