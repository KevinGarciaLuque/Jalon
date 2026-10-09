import { createRoot } from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './index.css';
import App from './App.jsx';
import Track from './Track.jsx';
import Legal from './Legal.jsx';

const path = window.location.pathname;
// /t/<código>: seguimiento público de un viaje compartido · /terminos y /privacidad: páginas legales
const shared = path.match(/^\/t\/([\w-]{8,40})$/);
const view = shared ? <Track token={shared[1]} /> : path === '/terminos' ? <Legal doc="terms" /> : path === '/privacidad' ? <Legal doc="privacy" /> : <App />;

createRoot(document.getElementById('root')).render(view);

// Hace la web instalable. Solo en la versión publicada, para no interferir con el servidor de desarrollo.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
