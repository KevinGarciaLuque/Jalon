// Notificaciones push nativas de la app de Android/iPhone (Firebase Cloud Messaging, API HTTP v1).
// Hace falta la llave de la cuenta de servicio de Firebase (Configuración del proyecto → Cuentas de servicio → Generar nueva clave privada):
// su contenido JSON va en la variable FCM_SERVICE_ACCOUNT (en una sola línea) o la ruta del archivo en FCM_SERVICE_ACCOUNT_FILE.
// Sin ella todo sigue funcionando; solo no llegan las notificaciones a la app nativa (la web sigue con Web Push).
import crypto from 'node:crypto';
import fs from 'node:fs';

function loadAccount() {
  try {
    const raw = process.env.FCM_SERVICE_ACCOUNT || (process.env.FCM_SERVICE_ACCOUNT_FILE && fs.readFileSync(process.env.FCM_SERVICE_ACCOUNT_FILE, 'utf8'));
    if (!raw) return null;
    const a = JSON.parse(raw);
    return a.client_email && a.private_key && a.project_id ? a : null;
  } catch {
    return null;
  }
}
const account = loadAccount();
export const fcmEnabled = Boolean(account);

const b64url = (v) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

let cached = { token: null, exp: 0 };
async function accessToken() {
  if (cached.token && Date.now() < cached.exp - 60_000) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const head = b64url({ alg: 'RS256', typ: 'JWT' });
  const claims = b64url({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.sign('RSA-SHA256', Buffer.from(`${head}.${claims}`), account.private_key).toString('base64url');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claims}.${sig}` }),
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`FCM auth ${res.status}`);
  const j = await res.json();
  cached = { token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return cached.token;
}

// 'ok' | 'gone' (el token ya no sirve: hay que borrarlo) | 'error' | 'disabled'
export async function sendFcm(deviceToken, payload) {
  if (!fcmEnabled) return 'disabled';
  try {
    const url = payload.url || '/';
    const res = await fetch(`https://fcm.googleapis.com/v1/projects/${account.project_id}/messages:send`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${await accessToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: {
          token: deviceToken,
          notification: { title: String(payload.title || 'Ktracho GO'), body: String(payload.body || '') },
          data: { url: String(url), kind: String(payload.kind || ''), tag: String(payload.tag || '') },
          android: {
            priority: 'HIGH',
            ttl: '3600s',
            // El mismo tag reemplaza la notificación anterior (no se acumulan), igual que en la web
            // channel_id: el canal de la app con el sonido propio (si el celular aún no lo tiene, Android usa el normal)
            notification: { channel_id: 'ktracho_avisos', ...(payload.tag ? { tag: String(payload.tag).slice(0, 80) } : {}), sound: 'default' },
          },
          apns: { headers: { 'apns-priority': '10' }, payload: { aps: { sound: 'default' } } },
        },
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (res.ok) return 'ok';
    if (res.status === 404 || res.status === 410) return 'gone'; // UNREGISTERED
    if (res.status === 400) {
      const e = await res.json().catch(() => null);
      if (e?.error?.details?.some((d) => d.errorCode === 'UNREGISTERED')) return 'gone';
    }
    return 'error';
  } catch {
    return 'error';
  }
}
