import fs from 'fs';
import bcrypt from 'bcryptjs';
import { encryptText } from '../src/secure.js';
import { generateSecret, hotp, stepOf } from '../src/totp.js';

export const API = process.env.API_URL || 'http://localhost:4000';
export const FIXTURE = fs.readFileSync(new URL('./fixtures/doc.jpg', import.meta.url));
export const JPG = `data:image/jpeg;base64,${FIXTURE.toString('base64')}`;

// Llama a la API y devuelve { status, ...json } (si la respuesta es una lista, el arreglo con .status)
export async function http(method, path, token, body) {
  const r = await fetch(`${API}/api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j) ? Object.assign(j, { status: r.status }) : { status: r.status, ...j };
}

// Registro con verificación por SMS: en desarrollo el servidor devuelve el código en la respuesta
export async function registerUser(data) {
  const o = await http('POST', 'otp/send', null, { phone: data.phone });
  if (!o.devCode) throw new Error(`No se pudo obtener el código de prueba (${o.status} ${o.error || ''})`);
  return http('POST', 'register', null, { acceptTerms: true, ...data, code: o.devCode });
}

// Sube los 3 documentos que exige la aprobación de un conductor
export async function uploadDocs(token) {
  for (const type of ['photo', 'license', 'registration']) {
    const r = await http('PUT', `driver/documents/${type}`, token, { image: JPG });
    if (!r.ok) throw new Error(`No se pudo subir ${type}: ${r.error}`);
  }
}

// ---- Personal con verificación en dos pasos ----
// Cada suite crea su propio superadmin de prueba (con 2FA ya activo) en lugar de tocar el superadmin real; cleanup.mjs lo borra.
export const TEST_SECRET = generateSecret();
export async function createTestSuperadmin(pool) {
  const phone = `5${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
  const [r] = await pool.query(
    "INSERT INTO users (name, phone, password_hash, role, status, totp_enabled, totp_secret, terms_accepted_at) VALUES ('T Superadmin', ?, ?, 'superadmin', 'active', 1, ?, NOW())",
    [phone, await bcrypt.hash('no-se-usa-en-pruebas-1', 4), encryptText(TEST_SECRET)]
  );
  return { id: r.insertId, name: 'T Superadmin', phone };
}

// Código actual de una app autenticadora. `ahead` toma el siguiente intervalo (un mismo código no sirve dos veces).
export const totpNow = (secret, ahead = 0) => hotp(secret, stepOf() + ahead);

// Activa la verificación de una cuenta del personal por la API, como lo haría la persona
export async function enroll2fa(token) {
  const setup = await http('POST', '2fa/setup', token, {});
  const done = await http('POST', '2fa/enable', token, { code: totpNow(setup.secret) });
  return { secret: setup.secret, backupCodes: done.backupCodes, status: done.status };
}
