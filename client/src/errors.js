// Reporte de errores: lo que falla en el celular del usuario llega al servidor, que lo pasa a Sentry.
// Solo en la versión publicada, cada error distinto una sola vez y como mucho 10 por visita (para no gastar datos).
import { API } from './lib.js';

const sent = new Set();
// Ruido que no es un fallo de la app: extensiones del navegador, avisos internos del navegador, falta de internet
const NOISE = /ResizeObserver loop|^Script error\.?$|Failed to fetch|NetworkError|Load failed|chrome-extension:|moz-extension:/i;

export function reportError(error, kind = 'error') {
  if (!import.meta.env.PROD) return;
  const message = String(error?.message || error || '').slice(0, 300);
  const stack = String(error?.stack || '').slice(0, 4000);
  if (!message || NOISE.test(message) || NOISE.test(stack) || sent.has(message) || sent.size >= 10) return;
  sent.add(message);
  fetch(`${API}/api/client-errors`, {
    method: 'POST',
    credentials: 'include',
    keepalive: true, // llega aunque la página se esté cerrando
    headers: { 'Content-Type': 'application/json', 'X-Jalon-Session': 'cookie' },
    body: JSON.stringify({ message, stack, kind, page: window.location.pathname, version: __APP_VERSION__ }),
  }).catch(() => {});
}

export function watchErrors() {
  window.addEventListener('error', (e) => reportError(e.error || e.message));
  window.addEventListener('unhandledrejection', (e) => reportError(e.reason, 'promise'));
}
