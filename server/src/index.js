// Arranque del servidor de Ktracho GO. Cada parte vive en su propio archivo; aquí solo se cargan en orden:
// primero la configuración y Express, después las rutas y los sockets, y al final la web compilada y el manejo de errores.
import express from 'express';
import { existsSync } from 'fs';
import path from 'path';
import { pool } from './db.js';
import { keyIsDerived } from './secure.js';
import { encryptLegacyDocuments } from './docs.js';
import { rekeyAll } from './rekey.js';
import { Sentry, reportError, PORT, isProd, HERE, UPLOADS } from './config.js';
import { app, server, io } from './app.js';
import './routes/auth.js';
import './routes/me.js';
import './routes/driver.js';
import './routes/admin-users.js';
import './routes/admin-ops.js';
import './routes/rentals.js';
import './routes/permissions.js';
import './routes/history.js';
import './routes/metrics.js';
import './routes/system.js';
import './routes/share.js';
import './routes/notifications.js';
import './routes/passkeys.js';
import './sockets.js';
import './jobs.js';

// En producción el mismo servidor entrega la web ya compilada (client/dist), incluida /t/<código> del seguimiento
const DIST = path.join(HERE, '..', '..', 'client', 'dist');
if (existsSync(DIST)) {
  // Los .js y .css van también comprimidos con Brotli (client/scripts/compress.mjs): ~12% menos que gzip
  app.use('/assets', (req, res, next) => {
    if (!/\bbr\b/.test(req.headers['accept-encoding'] || '') || !/^\/[\w.-]+\.(js|css)$/.test(req.path)) return next();
    const file = path.join(DIST, 'assets', `${req.path.slice(1)}.br`);
    if (!existsSync(file)) return next();
    res.type(path.extname(req.path));
    res.set({ 'Content-Encoding': 'br', Vary: 'Accept-Encoding', 'Cache-Control': 'public, max-age=31536000, immutable' });
    res.sendFile(file);
  });
  app.use('/assets', express.static(path.join(DIST, 'assets'), { immutable: true, maxAge: '1y' }));
  // Una pieza que ya no existe (de una versión anterior) es un 404, no la página: así la app sabe que debe recargarse
  app.use('/assets', (_req, res) => res.status(404).end());
  app.use(express.static(DIST, {
    index: false,
    maxAge: '1h',
    setHeaders: (res, file) => {
      // version.json dice qué versión está publicada: siempre se consulta al servidor
      if (/(sw\.js|manifest\.webmanifest|version\.json)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
    },
  }));
  app.use((req, res, next) => {
    if (req.method !== 'GET' || req.path.startsWith('/api/') || req.path.startsWith('/socket.io/')) return next();
    res.sendFile(path.join(DIST, 'index.html'));
  });
}

// Los documentos que se guardaron antes del cifrado se cifran una sola vez al arrancar
const legacyDocs = await encryptLegacyDocuments(UPLOADS);
if (legacyDocs) console.log(`Se cifraron ${legacyDocs} documento(s) guardados antes del cifrado.`);
// Si se puso o cambió DATA_KEY, lo cifrado con la llave anterior pasa a la nueva (una sola vez; después no hay nada que hacer)
const rekeyed = await rekeyAll(UPLOADS);
if (rekeyed.files || rekeyed.secrets) console.log(`Llave de cifrado nueva: se volvieron a cifrar ${rekeyed.files} archivo(s) y ${rekeyed.secrets} secreto(s) 2FA.`);
if (rekeyed.unreadable) console.warn(`⚠ ${rekeyed.unreadable} elemento(s) cifrado(s) no se pudieron leer con ninguna llave (¿cambió JWT_SECRET antes de poner DATA_KEY?). Se dejaron como estaban.`);
if (isProd && keyIsDerived) console.warn('⚠ DATA_KEY no está definida: la llave de cifrado se deriva de JWT_SECRET. Define DATA_KEY (ver README) para poder rotar JWT_SECRET sin perder los documentos.');

// Errores no controlados: siempre JSON, sin filtrar detalles internos
app.use((err, _req, res, _next) => {
  const status = err.status >= 400 && err.status < 500 ? err.status : 500;
  if (status === 500) reportError(err);
  res.status(status).json({ error: status === 500 ? 'Error del servidor' : 'Solicitud inválida' });
});

// Errores que se escapan de todo: se reportan y, si el estado puede estar dañado, el proceso se reinicia (Railway lo levanta de nuevo)
process.on('unhandledRejection', (e) => reportError(e));
process.on('uncaughtException', async (e) => {
  reportError(e);
  await Sentry?.close(2000);
  process.exit(1);
});

// Railway envía SIGTERM al desplegar una versión nueva: se cierran las conexiones con orden
for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    console.log(`${sig} recibido: cerrando…`);
    io.close(() => pool.end().finally(async () => { await Sentry?.close(2000); process.exit(0); }));
    setTimeout(() => process.exit(0), 8000).unref();
  });
}

server.listen(PORT, () => console.log(`Ktracho GO API en http://localhost:${PORT}`));
