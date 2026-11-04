// Errores que les salen a los usuarios en la app (pantallas en blanco, botones que fallan): la app los manda aquí
// y el servidor los pasa a Sentry con el mismo SENTRY_DSN (así el celular no carga otra librería ni otra llave).
// Sin datos personales: se quitan teléfonos, correos, tokens y lo que va después de «?» en las direcciones.
import rateLimit from 'express-rate-limit';
import { app } from '../app.js';
import { requestToken, userFromToken, effectiveUser, staffOnly, audit } from '../access.js';
import { Sentry, scrub } from '../config.js';

const limiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, message: { error: 'Demasiados reportes' } });

async function roleOf(req) {
  try {
    const u = await userFromToken(requestToken(req));
    return u ? effectiveUser(u).role : 'sin sesión';
  } catch {
    return 'sin sesión';
  }
}

app.post('/api/client-errors', limiter, async (req, res) => {
  const b = req.body || {};
  const message = scrub(b.message, 300) || 'Error sin mensaje';
  const stack = scrub(b.stack, 4000);
  const tags = {
    source: 'app',
    kind: ['error', 'promise', 'render'].includes(b.kind) ? b.kind : 'error',
    page: scrub(b.page, 100).replace(/[?#].*$/, '') || '/',
    version: scrub(b.version, 40) || 'desconocida',
    role: await roleOf(req),
  };
  // Siempre queda una línea en el registro de Railway, haya o no Sentry
  console.warn(JSON.stringify({ clientError: message, ...tags }));
  Sentry?.captureEvent({
    level: 'error',
    message: `[app] ${message}`,
    tags,
    extra: { stack, userAgent: scrub(req.headers['user-agent'], 300) },
    fingerprint: ['app', message, stack.split('\n')[1] || ''], // agrupa los repetidos
  });
  res.status(204).end();
});

// Botón «Probar Sentry» de Sistema: manda un error de prueba y espera a que salga
app.post('/api/admin/system/sentry-test', staffOnly('settings'), async (req, res) => {
  if (!Sentry) return res.status(409).json({ error: 'Falta SENTRY_DSN en Railway' });
  const eventId = Sentry.captureException(new Error(`Prueba de Sentry desde el panel (${new Date().toISOString()})`));
  const sent = await Sentry.flush(5000);
  await audit(req.staff, 'system.sentry_test');
  if (!sent) return res.status(502).json({ error: 'No se pudo enviar a Sentry: revisa el SENTRY_DSN' });
  res.json({ ok: true, eventId });
});
