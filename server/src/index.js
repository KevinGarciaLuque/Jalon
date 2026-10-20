// Arranque del servidor de Jalón. Cada parte vive en su propio archivo; aquí solo se cargan en orden:
// primero la configuración y Express, después las rutas y los sockets, y al final la web compilada y el manejo de errores.
import express from 'express';
import { existsSync } from 'fs';
import path from 'path';
import { pool } from './db.js';
import { keyIsDerived } from './secure.js';
import { encryptLegacyDocuments } from './docs.js';
import { Sentry, reportError, PORT, isProd, HERE, UPLOADS } from './config.js';
import { app, server, io } from './app.js';
import './routes/auth.js';
import './routes/me.js';
import './routes/driver.js';
import './routes/admin-users.js';
import './routes/admin-ops.js';
import './sockets.js';
import './jobs.js';

// En producción el mismo servidor entrega la web ya compilada (client/dist), incluida /t/<código> del seguimiento
const DIST = path.join(HERE, '..', '..', 'client', 'dist');
if (existsSync(DIST)) {
  app.use('/assets', express.static(path.join(DIST, 'assets'), { immutable: true, maxAge: '1y' }));
  app.use(express.static(DIST, {
    index: false,
    maxAge: '1h',
    setHeaders: (res, file) => {
      if (/(sw\.js|manifest\.webmanifest)$/.test(file)) res.setHeader('Cache-Control', 'no-cache');
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

server.listen(PORT, () => console.log(`Jalón API en http://localhost:${PORT}`));
