// Verificación en dos pasos con códigos de 6 dígitos que cambian cada 30 s (TOTP, RFC 6238): compatible con
// Google Authenticator, Microsoft Authenticator, Authy, 1Password, etc. Sin dependencias externas.
import crypto from 'crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf) {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(str) {
  let bits = 0, value = 0;
  const out = [];
  for (const ch of str.replace(/=+$/, '').toUpperCase()) {
    const i = B32.indexOf(ch);
    if (i < 0) throw new Error('Base32 inválido');
    value = (value << 5) | i;
    bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export const generateSecret = () => base32Encode(crypto.randomBytes(20)); // 160 bits

// Código de un contador (HOTP, RFC 4226)
export function hotp(secret, counter, digits = 6) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secret)).update(msg).digest();
  const o = h[h.length - 1] & 0x0f;
  const bin = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(bin % 10 ** digits).padStart(digits, '0');
}

export const stepOf = (nowMs = Date.now(), period = 30) => Math.floor(nowMs / 1000 / period);

// Devuelve el número de intervalo que coincidió (para no aceptar el mismo código dos veces) o null.
// Se tolera un intervalo de diferencia hacia cada lado por si el reloj del teléfono está ligeramente desajustado.
export function verifyTotp(secret, code, { now = Date.now(), window = 1, lastStep = 0 } = {}) {
  if (typeof code !== 'string' || !/^\d{6}$/.test(code)) return null;
  const current = stepOf(now);
  for (let w = -window; w <= window; w++) {
    const step = current + w;
    if (step <= lastStep) continue; // ese código (o uno anterior) ya se usó
    if (crypto.timingSafeEqual(Buffer.from(hotp(secret, step)), Buffer.from(code))) return step;
  }
  return null;
}

export const otpauthUrl = ({ secret, account, issuer = 'Jalón' }) =>
  `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;

// Códigos de respaldo de un solo uso por si se pierde el teléfono: XXXX-XXXX (sin letras que se confunden)
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateBackupCodes(n = 10) {
  return Array.from({ length: n }, () => {
    const c = Array.from(crypto.randomBytes(8), (b) => ALPHABET[b % ALPHABET.length]).join('');
    return `${c.slice(0, 4)}-${c.slice(4)}`;
  });
}
export const normalizeBackup = (code) => String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
export const hashBackup = (code) => crypto.createHash('sha256').update(normalizeBackup(code)).digest('hex');
