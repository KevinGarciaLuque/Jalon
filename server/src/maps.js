// Búsqueda de direcciones (Photon/OpenStreetMap) y rutas por calle (OSRM).
// Son servicios públicos gratuitos pensados para desarrollo y poco tráfico: antes de publicar la app
// con muchos usuarios conviene un proveedor propio o de pago (ver PHOTON_URL y OSRM_URL en .env).
import { distanceKm } from './geo.js';

const PHOTON = process.env.PHOTON_URL || 'https://photon.komoot.io';
const OSRM = process.env.OSRM_URL || 'https://router.project-osrm.org';
const HONDURAS_BBOX = '-89.4,12.9,-83.1,16.6'; // oeste,sur,este,norte
const UA = { 'User-Agent': 'Jalon/0.1' };

// ---- caché simple en memoria (evita repetir consultas y respeta los límites del servicio) ----
const cache = new Map();
function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < ttlMs) return hit.value;
  const value = load();
  cache.set(key, { at: Date.now(), value });
  value.catch(() => cache.delete(key)); // no guardar fallos
  if (cache.size > 1000) cache.delete(cache.keys().next().value);
  return value;
}

async function getJson(url, ms = 6000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { headers: UA, signal: ctl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

// "Mall Multiplaza, Bulevar Juan Pablo II, Barrio Morazán, Tegucigalpa"
function label(p) {
  const parts = [p.name, p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street, p.locality || p.district, p.city || p.county];
  return [...new Set(parts.filter(Boolean))].join(', ');
}

const toPlace = (f) => ({ text: label(f.properties), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] });

export function searchPlaces(q, near) {
  q = q.trim().toLowerCase().slice(0, 100);
  const bias = near ? `&lat=${near.lat.toFixed(2)}&lon=${near.lng.toFixed(2)}` : '';
  const url = `${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6&bbox=${HONDURAS_BBOX}${bias}`;
  return cached(`s:${q}:${bias}`, 60 * 60 * 1000, async () => {
    const data = await getJson(url);
    return data.features.filter((f) => f.properties.countrycode === 'HN').map(toPlace).filter((p) => p.text);
  });
}

export function reversePlace(lat, lng) {
  const url = `${PHOTON}/reverse?lat=${lat}&lon=${lng}`;
  return cached(`r:${lat.toFixed(4)}:${lng.toFixed(4)}`, 24 * 60 * 60 * 1000, async () => {
    const data = await getJson(url);
    const f = data.features[0];
    return f ? label(f.properties) : null;
  });
}

// Ruta por calles. Si el servicio falla se estima: línea recta x 1.3 a ~25 km/h, para no bloquear los viajes.
export function getRoute(a, b) {
  const key = `${a.lat.toFixed(4)},${a.lng.toFixed(4)};${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
  return cached(`route:${key}`, 10 * 60 * 1000, async () => {
    try {
      const url = `${OSRM}/route/v1/driving/${a.lng},${a.lat};${b.lng},${b.lat}?overview=simplified&geometries=geojson`;
      const data = await getJson(url, 8000);
      const r = data.routes?.[0];
      if (data.code !== 'Ok' || !r) throw new Error('sin ruta');
      return {
        distanceKm: r.distance / 1000,
        durationMin: r.duration / 60,
        coords: r.geometry.coordinates.map(([lng, lat]) => [+lat.toFixed(5), +lng.toFixed(5)]),
        estimated: false,
      };
    } catch (e) {
      console.warn('OSRM no disponible, se estima la ruta:', e.message);
      const km = distanceKm(a.lat, a.lng, b.lat, b.lng) * 1.3;
      return { distanceKm: km, durationMin: (km / 25) * 60, coords: [[a.lat, a.lng], [b.lat, b.lng]], estimated: true };
    }
  });
}
