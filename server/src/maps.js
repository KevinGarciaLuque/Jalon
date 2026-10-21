// Búsqueda de direcciones y rutas por calle, con el proveedor que se elija en Railway:
//  - MAPS_PROVIDER=osm (por defecto): Photon y OSRM públicos (gratis, para desarrollo y poco tráfico; ver PHOTON_URL y OSRM_URL)
//  - MAPS_PROVIDER=locationiq + MAPS_KEY: LocationIQ (plan gratis de 5.000 consultas al día, de pago para más)
// La clave se queda en el servidor: la app nunca la ve. Las baldosas del mapa se eligen aparte (VITE_TILE_URL).
import { distanceKm } from './geo.js';

const PROVIDER = (process.env.MAPS_PROVIDER || 'osm').toLowerCase() === 'locationiq' && process.env.MAPS_KEY ? 'locationiq' : 'osm';
if ((process.env.MAPS_PROVIDER || 'osm').toLowerCase() !== PROVIDER) console.warn(`⚠ MAPS_PROVIDER=${process.env.MAPS_PROVIDER} no se puede usar (¿falta MAPS_KEY?): se usan los servicios públicos de OpenStreetMap.`);
const KEY = encodeURIComponent(process.env.MAPS_KEY || '');
const PHOTON = process.env.PHOTON_URL || 'https://photon.komoot.io';
const OSRM = process.env.OSRM_URL || 'https://router.project-osrm.org';
// LocationIQ: el buscador en api.locationiq.com y lo demás en la región (us1 o eu1). LOCATIONIQ_URL reemplaza ambos (pruebas).
const LIQ_SEARCH = process.env.LOCATIONIQ_URL || 'https://api.locationiq.com';
const LIQ = process.env.LOCATIONIQ_URL || `https://${process.env.LOCATIONIQ_REGION || 'us1'}.locationiq.com`;
const HONDURAS_BBOX = '-89.4,12.9,-83.1,16.6'; // oeste,sur,este,norte
const UA = { 'User-Agent': 'Jalon/0.1' };
export const mapsProvider = PROVIDER;

// ---- caché en memoria: lo más usado se queda y lo más viejo sale (así se repiten muchas menos consultas al proveedor) ----
const CACHE_MAX = 5000;
const ESTIMATE_TTL_MS = 60 * 1000; // una ruta estimada (el servicio falló) se vuelve a intentar al minuto, no a los 10
const cache = new Map();
function cached(key, ttlMs, load) {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < (hit.estimated ? ESTIMATE_TTL_MS : ttlMs)) {
    cache.delete(key);
    cache.set(key, hit); // pasa al final: es de lo más usado
    return hit.value;
  }
  const entry = { at: Date.now(), value: load(), estimated: false };
  cache.set(key, entry);
  entry.value.then(
    (v) => { entry.estimated = !!v?.estimated; },
    () => { if (cache.get(key) === entry) cache.delete(key); } // no guardar fallos
  );
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
  return entry.value;
}

// ---- si un servicio no responde, durante un rato no se le vuelve a preguntar ----
// Así nadie espera 8 segundos en cada viaje mientras el servicio está caído: la ruta se estima al instante.
const RETRY_MS = Number(process.env.MAPS_RETRY_SECONDS || 60) * 1000;
const downUntil = new Map(); // 'routes' | 'places' -> hora en que se vuelve a intentar
const isDown = (service) => (downUntil.get(service) || 0) > Date.now();
function markDown(service, e) {
  if (!isDown(service)) console.warn(`Mapas: ${service} no responde (${e.message}); se vuelve a intentar en ${RETRY_MS / 1000} s`);
  downUntil.set(service, Date.now() + RETRY_MS);
}
export class MapsUnavailable extends Error {}

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
// Una consulta al servicio: si falla, el servicio queda «caído» un rato
async function ask(service, url, ms) {
  if (isDown(service)) throw new MapsUnavailable(`${service} no disponible`);
  try {
    return await getJson(url, ms);
  } catch (e) {
    markDown(service, e);
    throw e;
  }
}

// "Mall Multiplaza, Bulevar Juan Pablo II, Barrio Morazán, Tegucigalpa"
const join = (parts) => [...new Set(parts.filter(Boolean))].join(', ');
const round = (p) => ({ ...p, lat: +Number(p.lat).toFixed(6), lng: +Number(p.lng).toFixed(6) });

// Cada proveedor responde distinto; aquí todo se convierte en { text, lat, lng }
const providers = {
  osm: {
    search: async (q, near) => {
      const bias = near ? `&lat=${near.lat.toFixed(2)}&lon=${near.lng.toFixed(2)}` : '';
      const data = await ask('places', `${PHOTON}/api/?q=${encodeURIComponent(q)}&limit=6&bbox=${HONDURAS_BBOX}${bias}`);
      return data.features.filter((f) => f.properties.countrycode === 'HN').map((f) => {
        const p = f.properties;
        return { text: join([p.name, p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street, p.locality || p.district, p.city || p.county]), lat: f.geometry.coordinates[1], lng: f.geometry.coordinates[0] };
      });
    },
    reverse: async (lat, lng) => {
      const f = (await ask('places', `${PHOTON}/reverse?lat=${lat}&lon=${lng}`)).features[0];
      const p = f?.properties;
      return p ? join([p.name, p.street && p.housenumber ? `${p.street} ${p.housenumber}` : p.street, p.locality || p.district, p.city || p.county]) : null;
    },
    routeUrl: (coords) => `${OSRM}/route/v1/driving/${coords}?overview=simplified&geometries=geojson`,
  },
  locationiq: {
    search: async (q, near) => {
      // Solo Honduras; si se sabe dónde está la persona, se prefieren los resultados cercanos (~30 km)
      const box = near ? `&viewbox=${near.lng - 0.3},${near.lat - 0.3},${near.lng + 0.3},${near.lat + 0.3}` : '';
      const data = await ask('places', `${LIQ_SEARCH}/v1/autocomplete?key=${KEY}&q=${encodeURIComponent(q)}&countrycodes=hn&limit=6&dedupe=1&normalizecity=1&accept-language=es${box}`);
      return (Array.isArray(data) ? data : []).filter((r) => (r.address?.country_code || 'hn') === 'hn').map((r) => {
        const a = r.address || {};
        return { text: join([r.display_place || a.name, a.road && a.house_number ? `${a.road} ${a.house_number}` : a.road, a.neighbourhood || a.suburb, a.city]) || r.display_name, lat: r.lat, lng: r.lon };
      });
    },
    reverse: async (lat, lng) => {
      const r = await ask('places', `${LIQ}/v1/reverse?key=${KEY}&lat=${lat}&lon=${lng}&format=json&normalizeaddress=1&accept-language=es`);
      const a = r?.address || {};
      return join([a.name, a.road && a.house_number ? `${a.road} ${a.house_number}` : a.road, a.neighbourhood || a.suburb, a.city]) || r?.display_name || null;
    },
    // Las rutas de LocationIQ responden igual que OSRM
    routeUrl: (coords) => `${LIQ}/v1/directions/driving/${coords}?key=${KEY}&overview=simplified&geometries=geojson`,
  },
};
const use = providers[PROVIDER];

export function searchPlaces(q, near) {
  q = q.trim().toLowerCase().slice(0, 100);
  const key = `s:${q}:${near ? `${near.lat.toFixed(2)},${near.lng.toFixed(2)}` : ''}`;
  return cached(key, 60 * 60 * 1000, async () => (await use.search(q, near)).filter((p) => p.text).map(round));
}

export function reversePlace(lat, lng) {
  return cached(`r:${lat.toFixed(4)}:${lng.toFixed(4)}`, 24 * 60 * 60 * 1000, () => use.reverse(lat, lng));
}

// Ruta por calles. Si el servicio falla (o está caído) se estima al instante: línea recta x 1.3 a ~25 km/h, para no bloquear los viajes.
export function getRoute(a, b) {
  const key = `${a.lat.toFixed(4)},${a.lng.toFixed(4)};${b.lat.toFixed(4)},${b.lng.toFixed(4)}`;
  return cached(`route:${key}`, 10 * 60 * 1000, async () => {
    try {
      const data = await ask('routes', use.routeUrl(`${a.lng},${a.lat};${b.lng},${b.lat}`), 8000);
      const r = data.routes?.[0];
      if (data.code !== 'Ok' || !r) throw new Error('sin ruta');
      return {
        distanceKm: r.distance / 1000,
        durationMin: r.duration / 60,
        coords: r.geometry.coordinates.map(([lng, lat]) => [+lat.toFixed(5), +lng.toFixed(5)]),
        estimated: false,
      };
    } catch {
      const km = distanceKm(a.lat, a.lng, b.lat, b.lng) * 1.3;
      return { distanceKm: km, durationMin: (km / 25) * 60, coords: [[a.lat, a.lng], [b.lat, b.lng]], estimated: true };
    }
  });
}
