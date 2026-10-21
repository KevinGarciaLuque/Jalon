import { Suspense } from 'react';
import { createRoot } from 'react-dom/client';
import './index.css';
import App from './App.jsx';
import { Loading } from './components.jsx';
import { lazyPage } from './lib.js';

// Se descargan solo si se abren (la app normal no los necesita)
const Track = lazyPage(() => import('./Track.jsx'));
const Legal = lazyPage(() => import('./Legal.jsx'));

const path = window.location.pathname;
// /t/<código>: seguimiento público de un viaje compartido · /terminos y /privacidad: páginas legales
const shared = path.match(/^\/t\/([\w-]{8,40})$/);
const view = shared ? <Track token={shared[1]} /> : path === '/terminos' ? <Legal doc="terms" /> : path === '/privacidad' ? <Legal doc="privacy" /> : <App />;

createRoot(document.getElementById('root')).render(<Suspense fallback={<Loading />}>{view}</Suspense>);

// Hace la web instalable. Solo en la versión publicada, para no interferir con el servidor de desarrollo.
if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}
