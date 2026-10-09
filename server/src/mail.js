// Envío de correo por SMTP (Gmail con contraseña de aplicación, Brevo, Resend, Zoho, etc.).
// Sin SMTP: en desarrollo el mensaje se imprime en la consola y queda en .mail-dev.log; en producción falla.
import { appendFileSync } from 'fs';
import dns from 'dns/promises';
import nodemailer from 'nodemailer';

const { SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS, SMTP_FROM, SMTP_SECURE } = process.env;

export const mailConfigured = Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS);

const transport = mailConfigured
  ? nodemailer.createTransport({
      host: SMTP_HOST,
      port: Number(SMTP_PORT || 587),
      secure: SMTP_SECURE ? SMTP_SECURE === 'true' : Number(SMTP_PORT) === 465, // 465 = TLS directo; 587 = STARTTLS
      auth: { user: SMTP_USER, pass: SMTP_PASS },
      connectionTimeout: 10000,
      greetingTimeout: 10000,
      socketTimeout: 15000,
    })
  : null;

export async function sendMail(to, subject, text) {
  if (!transport) {
    if (process.env.NODE_ENV === 'production' && process.env.SMS_DEV_ECHO !== 'true') throw new Error('Correo no configurado: define las variables SMTP_* en .env');
    console.log(`✉ [Correo de desarrollo] a ${to}: ${subject} — ${text}`);
    if (process.env.NODE_ENV !== 'production') appendFileSync(new URL('../.mail-dev.log', import.meta.url), `${JSON.stringify({ to, subject, text, at: Date.now() })}\n`);
    return;
  }
  await transport.sendMail({ from: SMTP_FROM || `Jalón <${SMTP_USER}>`, to, subject, text });
}

// Correo bien escrito (una sola dirección, sin espacios ni saltos de línea que permitan inyectar cabeceras)
const EMAIL_RE = /^[A-Za-z0-9._%+'-]{1,64}@([A-Za-z0-9-]{1,63}\.)+[A-Za-z]{2,24}$/;

// Devuelve el correo normalizado (minúsculas) o null si no es válido
export function normalizeEmail(v) {
  if (typeof v !== 'string') return null;
  const e = v.trim().toLowerCase();
  return e.length <= 160 && !e.includes('..') && EMAIL_RE.test(e) ? e : null;
}

// ¿El dominio puede recibir correo? Descarta errores de escritura como «gmial.com». Si el DNS falla por otra causa, no se bloquea a nadie.
export async function domainAcceptsMail(email) {
  if (process.env.EMAIL_CHECK_MX === 'false' || (process.env.NODE_ENV !== 'production' && process.env.EMAIL_CHECK_MX !== 'true')) return true;
  const domain = email.split('@')[1];
  try {
    const mx = await dns.resolveMx(domain);
    return mx.length > 0;
  } catch (e) {
    if (e.code === 'ENOTFOUND' || e.code === 'ENODATA') {
      try { return (await dns.resolve4(domain)).length > 0; } catch { return false; } // sin MX, el correo llega a la dirección del dominio
    }
    return true;
  }
}
