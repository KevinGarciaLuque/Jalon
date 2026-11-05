// Compartir la app (permiso 'share'): la dirección pública para el QR y el enlace de pasajeros y conductores
import { app } from '../app.js';
import { staffOnly } from '../access.js';
import { PUBLIC_URL } from '../config.js';

// La dirección que se comparte: PUBLIC_URL si es https (p. ej. https://ktrachogo.com); si no, la del sitio desde donde se abrió el panel
export function shareLinks(req) {
  const base = (/^https:\/\//.test(PUBLIC_URL) ? PUBLIC_URL : `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
  // Los dos abren directo el registro (quien ya tiene cuenta toca «¿Ya tienes cuenta? Entrar»)
  return { home: `${base}/`, passenger: `${base}/?registro=pasajero`, driver: `${base}/?registro=conductor` };
}

app.get('/api/admin/share', staffOnly('share'), (req, res) => {
  res.json(shareLinks(req));
});
