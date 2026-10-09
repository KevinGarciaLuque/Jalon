import { createRoot } from 'react-dom/client';
import 'leaflet/dist/leaflet.css';
import './index.css';
import App from './App.jsx';
import Track from './Track.jsx';

// /t/<código> es la página pública para seguir un viaje compartido
const shared = window.location.pathname.match(/^\/t\/([\w-]{8,40})$/);

createRoot(document.getElementById('root')).render(shared ? <Track token={shared[1]} /> : <App />);
