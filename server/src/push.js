// Notificaciones push (Web Push con VAPID). Llegan al celular aunque la app esté cerrada.
// Generar las llaves una vez:  npm run vapid   y poner VAPID_PUBLIC_KEY y VAPID_PRIVATE_KEY en .env / Railway.
// Sin llaves todo sigue funcionando; solo no hay notificaciones.
import webpush from 'web-push';

const PUB = process.env.VAPID_PUBLIC_KEY;
const PRIV = process.env.VAPID_PRIVATE_KEY;
export const pushEnabled = Boolean(PUB && PRIV);
export const publicKey = PUB || null;

if (pushEnabled) {
  const subject = process.env.VAPID_SUBJECT || (/^https:/.test(process.env.PUBLIC_URL || '') ? process.env.PUBLIC_URL : 'https://jalon.up.railway.app');
  webpush.setVapidDetails(subject, PUB, PRIV);
}

// El servidor envía mensajes a la dirección que da cada usuario: sin límite serviría para atacar servicios internos (SSRF).
// En producción solo se aceptan los servicios de notificaciones reales de cada navegador.
const PUSH_HOSTS = [
  /(^|\.)fcm\.googleapis\.com$/, /(^|\.)android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/,
  /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/,
];
export function validEndpoint(endpoint, { allowLocal = false } = {}) {
  if (typeof endpoint !== 'string' || endpoint.length > 600) return false;
  let u;
  try { u = new URL(endpoint); } catch { return false; }
  if (allowLocal && u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)) return true; // solo para pruebas
  return u.protocol === 'https:' && !u.username && !u.password && PUSH_HOSTS.some((re) => re.test(u.hostname));
}

// 'ok' | 'gone' (la suscripción ya no existe: hay que borrarla) | 'error' | 'disabled'
export async function sendPush(sub, payload) {
  if (!pushEnabled) return 'disabled';
  try {
    // web-push se usa solo para cifrar el mensaje y firmarlo (VAPID); el envío es un fetch normal con tiempo límite
    const d = webpush.generateRequestDetails(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 3600, urgency: 'high' }
    );
    const res = await fetch(d.endpoint, { method: d.method, headers: d.headers, body: d.body, signal: AbortSignal.timeout(8000) });
    if (res.status === 404 || res.status === 410) return 'gone';
    return res.ok ? 'ok' : 'error';
  } catch {
    return 'error';
  }
}

export const generateKeys = () => webpush.generateVAPIDKeys();
