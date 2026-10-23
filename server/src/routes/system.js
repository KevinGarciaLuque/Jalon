// Estado del sistema (solo el superadmin): qué falta configurar antes de abrir al público y qué versión está publicada.
// Nunca devuelve claves ni direcciones privadas: solo si cada cosa está lista.
import fs from 'fs/promises';
import path from 'path';
import { pool } from '../db.js';
import { app } from '../app.js';
import { staffOnly } from '../access.js';
import { getSettings } from '../wallet.js';
import { keyIsDerived } from '../secure.js';
import { lastRekey } from '../rekey.js';
import { mapsProvider } from '../maps.js';
import { pushEnabled } from '../push.js';
import { smsConfigured } from '../sms.js';
import { mailConfigured } from '../mail.js';
import { TERMS_VERSION } from '../legal.js';
import { isProd, echoCode, OTP_CHANNELS, SOS_PHONES, UPLOADS, TILE_URL, PUBLIC_URL, Sentry } from '../config.js';

const STARTED_AT = new Date().toISOString();

// ok = listo · warn = conviene revisarlo · bad = falta antes de abrir al público · info = dato
const item = (group, label, status, detail) => ({ group, label, status, detail });

async function uploadsCheck() {
  const persistent = !!process.env.UPLOADS_DIR;
  try {
    await fs.mkdir(UPLOADS, { recursive: true });
    const probe = path.join(UPLOADS, `.prueba-${process.pid}`);
    await fs.writeFile(probe, 'ok');
    await fs.rm(probe, { force: true });
  } catch {
    return item('datos', 'Carpeta de documentos', 'bad', 'El servidor no puede guardar archivos: revisa el Volume y UPLOADS_DIR.');
  }
  if (!persistent && isProd) return item('datos', 'Carpeta de documentos', 'bad', 'Sin UPLOADS_DIR: los documentos y comprobantes se borran en cada despliegue. Monta un Volume en /data y pon UPLOADS_DIR=/data/uploads.');
  return item('datos', 'Carpeta de documentos', persistent ? 'ok' : 'info', persistent ? 'Guardando en el Volume (UPLOADS_DIR).' : 'Carpeta local (desarrollo).');
}

export async function systemStatus() {
  const s = await getSettings(pool);
  const sha = process.env.RAILWAY_GIT_COMMIT_SHA;
  const [[terms]] = await pool.query(
    "SELECT COUNT(*) AS n FROM users WHERE deleted_at IS NULL AND role IN ('passenger','driver') AND (terms_version IS NULL OR terms_version <> ?)", [TERMS_VERSION]
  );
  const codeChannel = (OTP_CHANNELS.includes('email') && mailConfigured) || (OTP_CHANNELS.includes('sms') && smsConfigured);
  const items = [
    // Seguridad
    item('seguridad', 'Modo producción', isProd ? 'ok' : 'warn', isProd ? 'NODE_ENV=production.' : 'El servidor no está en modo producción (NODE_ENV).'),
    item('seguridad', 'Verificación en dos pasos del personal', s.staff_2fa_required === '0' ? 'bad' : 'ok',
      s.staff_2fa_required === '0' ? 'Está apagada: enciéndela en Ajustes antes de abrir al público.' : 'Obligatoria para el personal.'),
    item('seguridad', 'Llave de cifrado (DATA_KEY)', keyIsDerived ? 'warn' : lastRekey.unreadable ? 'bad' : 'ok',
      keyIsDerived ? 'Sin DATA_KEY: la llave sale de JWT_SECRET. Ponla siguiendo el README (Etapa 8.1).'
        : lastRekey.unreadable ? `${lastRekey.unreadable} elemento(s) cifrado(s) no se pudieron leer con ninguna llave (ver el registro del servidor).`
          : lastRekey.files || lastRekey.secrets ? `Lista. Al arrancar se pasaron ${lastRekey.files} archivo(s) y ${lastRekey.secrets} secreto(s) a la llave nueva.` : 'Lista.'),
    item('seguridad', 'Monitoreo de errores (Sentry)', Sentry ? 'ok' : 'warn', Sentry ? 'Los errores del servidor se reportan a Sentry.' : 'Sin SENTRY_DSN: los errores solo quedan en el registro de Railway.'),
    // Registro y avisos
    item('avisos', 'Código de verificación al registrarse', codeChannel ? 'ok' : !isProd ? 'info' : 'bad',
      codeChannel ? `Se envía por ${OTP_CHANNELS.map((c) => (c === 'email' ? 'correo' : 'SMS')).join(' y ')}.`
        : !isProd ? 'Desarrollo: el código se muestra en pantalla.'
          : echoCode ? 'SMS_DEV_ECHO está activo: el código se muestra en pantalla y cualquiera podría registrarse con un teléfono ajeno. Quítalo cuando el correo funcione.'
            : 'Ningún canal configurado: nadie podría registrarse (SMTP_* o TWILIO_*).'),
    item('avisos', 'Correo (SMTP)', mailConfigured ? 'ok' : 'bad', mailConfigured ? 'Configurado.' : 'Falta SMTP_HOST, SMTP_USER y SMTP_PASS.'),
    item('avisos', 'SMS (Twilio)', smsConfigured ? 'ok' : 'warn', smsConfigured ? 'Configurado.' : 'Sin Twilio: no salen SMS (ni los de emergencia).'),
    item('avisos', 'Teléfonos de emergencia (SOS)', SOS_PHONES.length && smsConfigured ? 'ok' : SOS_PHONES.length ? 'warn' : 'bad',
      SOS_PHONES.length ? `${SOS_PHONES.length} teléfono(s)${smsConfigured ? '' : ', pero sin Twilio no les llega el SMS'}.` : 'Sin SOS_ALERT_PHONES: las emergencias solo se ven en el panel.'),
    item('avisos', 'Notificaciones', pushEnabled ? 'ok' : 'warn', pushEnabled ? 'Llaves VAPID configuradas.' : 'Sin VAPID_*: no hay notificaciones.'),
    // Datos
    await uploadsCheck(),
    item('datos', 'Respaldos', 'info', 'Actívalos en Railway (MySQL y Volume) y haz uno propio cada semana con «npm run backup» (README, Etapa 7.2).'),
    item('datos', 'Correo de soporte en los términos', process.env.VITE_CONTACT_EMAIL ? 'ok' : isProd ? 'bad' : 'info',
      process.env.VITE_CONTACT_EMAIL ? `Los términos y la privacidad muestran ${process.env.VITE_CONTACT_EMAIL}.` : 'Sin VITE_CONTACT_EMAIL: los términos dicen «falta definir» donde va el correo de contacto. Agrégala y vuelve a desplegar.'),
    // Recargas: con la comisión activa (o alquileres pagados por transferencia) hace falta la cuenta para transferir
    (() => {
      const missing = [['bank_name', 'banco'], ['bank_account', 'número de cuenta'], ['bank_holder', 'a nombre de quién']].filter(([k]) => !String(s[k] || '').trim()).map(([, l]) => l);
      const needed = s.commission_enabled === '1' || s.rental_enabled === '1';
      return item('datos', 'Cuenta para las recargas', !needed ? 'info' : missing.length ? 'bad' : 'ok',
        !needed ? 'La comisión está apagada: los conductores no recargan saldo.'
          : missing.length ? `Falta ${missing.join(', ')} en Ajustes: los conductores no sabrán a dónde transferir.`
            : `${s.bank_name} · ${s.bank_account} a nombre de ${s.bank_holder}.`);
    })(),
    item('datos', 'Términos y privacidad', terms.n ? 'info' : 'ok', terms.n ? `Versión ${TERMS_VERSION}. ${terms.n} persona(s) aceptaron una versión anterior.` : `Versión ${TERMS_VERSION}; todos la aceptaron.`),
    // Mapas
    item('mapas', 'Búsqueda de direcciones y rutas', mapsProvider === 'osm' ? 'warn' : 'ok',
      mapsProvider === 'osm' ? 'Servicios públicos gratuitos de OpenStreetMap: bien para empezar, no para mucho tráfico (README, Etapa 7.3).' : `Con ${mapsProvider === 'locationiq' ? 'LocationIQ' : mapsProvider}.`),
    item('mapas', 'Mapa (baldosas)', /tile\.openstreetmap\.org/.test(TILE_URL) ? 'warn' : 'ok',
      /tile\.openstreetmap\.org/.test(TILE_URL) ? 'Servidores públicos de OpenStreetMap: pueden bloquear una app con muchos usuarios (VITE_TILE_URL).' : 'Proveedor propio.'),
    // Publicación
    item('version', 'Dirección pública', PUBLIC_URL.startsWith('https://') ? 'ok' : isProd ? 'warn' : 'info', PUBLIC_URL || 'Sin PUBLIC_URL ni CLIENT_ORIGIN.'),
    item('version', 'Proxy de Railway (TRUST_PROXY)', process.env.TRUST_PROXY ? 'ok' : isProd ? 'warn' : 'info',
      process.env.TRUST_PROXY ? 'Los límites de intentos usan la IP real.' : 'Sin TRUST_PROXY=1 los límites de intentos ven a todos con la misma IP.'),
  ];
  return {
    version: {
      commit: sha ? sha.slice(0, 7) : null,
      message: process.env.RAILWAY_GIT_COMMIT_MESSAGE?.split('\n')[0] || null,
      startedAt: STARTED_AT,
      node: process.version,
    },
    summary: { bad: items.filter((i) => i.status === 'bad').length, warn: items.filter((i) => i.status === 'warn').length },
    items,
  };
}

app.get('/api/admin/system', staffOnly('settings'), async (_req, res) => {
  res.json(await systemStatus());
});
