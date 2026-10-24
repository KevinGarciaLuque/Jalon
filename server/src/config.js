// Configuración que sale de las variables de entorno, y el reporte de errores (Sentry)
import 'dotenv/config';
import path from 'path';
import { fileURLToPath } from 'url';
import { normalizePhone } from './phone.js';
import { smsConfigured } from './sms.js';
import { mailConfigured } from './mail.js';

// Monitoreo de errores (opcional): con SENTRY_DSN los errores inesperados del servidor se reportan a Sentry (sin datos personales)
export const Sentry = process.env.SENTRY_DSN ? await import('@sentry/node') : null;
Sentry?.init({
  dsn: process.env.SENTRY_DSN,
  environment: process.env.NODE_ENV || 'development',
  release: process.env.RAILWAY_GIT_COMMIT_SHA,
  tracesSampleRate: 0,
  sendDefaultPii: false,
});
export const reportError = (e) => { console.error(e); Sentry?.captureException(e); };

export const PORT = Number(process.env.PORT || 4000);
const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
export const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret';
if (JWT_SECRET === 'dev-secret' || JWT_SECRET.startsWith('cambia-esto')) {
  if (process.env.NODE_ENV === 'production') throw new Error('Define un JWT_SECRET real en .env');
  console.warn('⚠ JWT_SECRET de desarrollo: cámbialo antes de publicar la app');
}
export const NEARBY_KM = 5;
// Una oferta de un conductor vale este tiempo: así el pasajero no acepta una oferta vieja de alguien que ya se fue
export const OFFER_TTL_SECONDS = Number(process.env.OFFER_TTL_SECONDS || 90);
export const RAISE_COOLDOWN_MS = Number(process.env.RAISE_COOLDOWN_MS || 8000); // entre una subida de precio y la siguiente
export const ETA_EVERY_MS = Number(process.env.ETA_EVERY_MS || 20000); // cada cuánto se recalcula el tiempo de llegada
export const SHOW_PARTNER_PHONES = process.env.SHOW_PARTNER_PHONES === 'true';
export const CHAT_RETENTION_DAYS = Number(process.env.CHAT_RETENTION_DAYS || 90);
export const isProd = process.env.NODE_ENV === 'production';
// Sin Twilio y fuera de producción, el código se devuelve en la respuesta para poder probar sin SMS reales
// SMS_DEV_ECHO=true lo habilita también en producción mientras no haya Twilio (solo para pruebas del equipo: cualquiera vería su código)
// Los códigos se envían por los canales de OTP_CHANNELS (por defecto solo correo; 'email,sms' usa los dos)
export const OTP_CHANNELS = (process.env.OTP_CHANNELS || 'email').split(',').map((c) => c.trim()).filter((c) => c === 'email' || c === 'sms');
const channelReady = (OTP_CHANNELS.includes('email') && mailConfigured) || (OTP_CHANNELS.includes('sms') && smsConfigured);
export const echoCode = !channelReady && (!isProd || process.env.SMS_DEV_ECHO === 'true');
if (isProd && echoCode) console.warn('⚠ SMS_DEV_ECHO activo: los códigos de verificación se muestran en pantalla (cualquiera podría registrarse). Quítalo al configurar el correo (SMTP_*).');
if (isProd && !channelReady && !echoCode) console.warn(`⚠ Ningún canal de verificación está configurado (OTP_CHANNELS=${OTP_CHANNELS.join(',')}): nadie podrá registrarse. Define SMTP_* o TWILIO_*.`);
// Baldosas del mapa: OpenStreetMap por defecto. Para producción conviene un proveedor propio o de pago (VITE_TILE_URL), porque
// los servidores públicos de OSM no están pensados para apps con muchos usuarios y bloquean a quien no cumple su política.
export const TILE_URL = process.env.VITE_TILE_URL || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export function tileOrigin(url) {
  try {
    const u = new URL(url.replace('{s}', 'a').replace(/\{[^}]+\}/g, '0'));
    return url.includes('{s}') ? `https://*.${u.hostname.split('.').slice(1).join('.')}` : `https://${u.hostname}`;
  } catch {
    return 'https://*.tile.openstreetmap.org';
  }
}
export const HERE = path.dirname(fileURLToPath(import.meta.url));
// En Railway el disco se borra en cada despliegue: monta un Volume y apunta UPLOADS_DIR a él (ej. /data/uploads)
export const UPLOADS = process.env.UPLOADS_DIR || path.join(HERE, '..', 'uploads');
export const DOC_TYPES = ['photo', 'license', 'registration'];

// Teléfonos del equipo que reciben un SMS cuando alguien pulsa el botón de emergencia (separados por coma)
export const SOS_PHONES = (process.env.SOS_ALERT_PHONES || '').split(',').map((p) => normalizePhone(p)).filter(Boolean);
export const SOS_REMINDER_MIN = Number(process.env.SOS_REMINDER_MINUTES || 3); // mientras nadie la atienda, se repite el aviso
export const SOS_MAX_NOTICES = 4; // el aviso inicial y hasta 3 recordatorios
export const PUBLIC_URL = process.env.PUBLIC_URL || process.env.CLIENT_ORIGIN || '';

// En desarrollo se acepta cualquier puerto de localhost (Vite cambia de puerto si el 5173 está ocupado)
export const allowOrigin = (origin, cb) => cb(null, !origin || origin === ORIGIN || /^http:\/\/localhost:\d+$/.test(origin));
// Una conexión que viene de otro sitio no puede usar la cookie de sesión (el mismo servidor, CLIENT_ORIGIN o localhost en desarrollo)
export const trustedOrigin = (origin, host) => !origin || origin === ORIGIN || /^http:\/\/localhost:\d+$/.test(origin) || origin === `https://${host}` || (!isProd && origin === `http://${host}`);

// Sesión de la app web: una cookie que JavaScript no puede leer (HttpOnly), solo para este sitio (SameSite=Strict)
// y en producción solo por HTTPS. El prefijo __Host- obliga al navegador a no compartirla con subdominios.
export const SESSION_COOKIE = isProd ? '__Host-jalon' : 'jalon_session';
// La app web manda esta cabecera: pide la sesión en cookie y, como otro sitio no puede ponerla, protege contra CSRF
export const SESSION_HEADER = 'x-jalon-session';

export const MAX_PRICE = 5000; // L
export const REQUEST_TTL_MIN = 10; // un viaje sin conductor se cancela solo
// Viajes programados: de 30 minutos a 7 días; salen a buscar conductor 20 minutos antes de la hora
export const SCHEDULE_MIN_AHEAD = Number(process.env.SCHEDULE_MIN_AHEAD || 30);
export const SCHEDULE_MAX_DAYS = 7;
export const SCHEDULE_LEAD_MIN = Number(process.env.SCHEDULE_LEAD_MIN || 20);
// Máximo de mensajes por evento y por conexión cada 10 s. Una persona real queda muy por debajo (el GPS manda ~1 por segundo).
export const SOCKET_WINDOW_MS = 10000;
export const SOCKET_LIMIT_DEFAULT = 30;
export const SOCKET_LIMITS = { 'driver:location': 60, 'passenger:location': 60 };

export const REPORT_TYPES = { lost_item: 'Objeto olvidado', overcharge: 'Cobro indebido', behavior: 'Trato o conducta', safety: 'Seguridad', other: 'Otro problema' };
