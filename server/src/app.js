// Express (seguridad, CORS, registros y límites de intentos), el servidor HTTP y Socket.IO
import http from 'http';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import { Server } from 'socket.io';
import { isProd, TILE_URL, tileOrigin, allowOrigin } from './config.js';

export const app = express();
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY)); // detrás de nginx/Railway/etc.
app.use(helmet({
  // OpenStreetMap exige saber desde qué sitio se piden sus baldosas; con "no-referrer" (el valor por defecto de helmet) las bloquea
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'img-src': ["'self'", 'data:', 'blob:', tileOrigin(TILE_URL)], // mapa y documentos del admin
      'connect-src': ["'self'"], // API y WebSocket del mismo servidor
    },
  },
}));
app.use(cors({ origin: allowOrigin }));
const smallJson = express.json({ limit: '10kb' });
app.use((req, res, next) => (/^\/api\/(driver\/(documents|topups)|rentals\/\d+\/receipt)/.test(req.path) ? next() : smallJson(req, res, next)));

// Una línea JSON por petición a la API (método, ruta, estado y milisegundos), útil en los registros de Railway. Sin teléfonos ni contraseñas.
if (isProd || process.env.LOG_REQUESTS === 'true') {
  app.use((req, res, next) => {
    if (!req.path.startsWith('/api/') || req.path === '/api/health') return next();
    const t0 = Date.now();
    res.on('finish', () => console.log(JSON.stringify({ t: new Date().toISOString(), m: req.method, p: req.route?.path || req.path, s: res.statusCode, ms: Date.now() - t0 })));
    next();
  });
}

// Qué funciones del navegador puede usar la web: solo la ubicación (el mapa); cámara y micrófono nunca
app.use((_req, res, next) => {
  res.setHeader('Permissions-Policy', 'geolocation=(self), camera=(), microphone=(), payment=(), usb=(), interest-cohort=()');
  next();
});

const limitMsg = { error: 'Demasiados intentos. Intenta de nuevo en unos minutos.' };
// Solo cuentan los intentos fallidos de login (contra fuerza bruta)
export const loginLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: isProd ? 10 : 500, skipSuccessfulRequests: true, message: limitMsg }); // en desarrollo es holgado: las pruebas fallan a propósito muchas veces
export const mapsLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, message: limitMsg });
export const trackLimiter = rateLimit({ windowMs: 60 * 1000, limit: 60, message: limitMsg });
export const registerLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: isProd ? 50 : 1000, message: limitMsg });
export const otpLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: isProd ? 20 : 1000, message: limitMsg });

export const server = http.createServer(app);
export const io = new Server(server, { cors: { origin: allowOrigin } });

export const photoJson = express.json({ limit: '3mb' });
