// Etapa 7.3: mapas con proveedor configurable (LocationIQ), caché y «servicio caído».
// Se prueba contra un LocationIQ de mentira (respuestas con el formato de su documentación), sin clave real.
import http from 'http';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

// ---- LocationIQ de mentira ----
const hits = [];
let routesFail = false;
const fake = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');
  hits.push(url);
  const send = (status, body) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.searchParams.get('key') !== 'clave-de-prueba') return send(401, { error: 'Invalid key' });
  if (url.pathname === '/v1/autocomplete') {
    return send(200, [
      { lat: '14.0849', lon: '-87.1631', display_name: 'Mall Multiplaza, Bulevar Juan Pablo II, Tegucigalpa, Honduras', display_place: 'Mall Multiplaza', address: { name: 'Mall Multiplaza', road: 'Bulevar Juan Pablo II', suburb: 'Lomas del Mayab', city: 'Tegucigalpa', country_code: 'hn' } },
      { lat: '13.7', lon: '-89.2', display_name: 'Multiplaza, San Salvador', display_place: 'Multiplaza', address: { city: 'San Salvador', country_code: 'sv' } },
    ]);
  }
  if (url.pathname === '/v1/reverse') return send(200, { display_name: 'x', address: { road: 'Avenida La Paz', house_number: '12', neighbourhood: 'Barrio La Plazuela', city: 'Tegucigalpa' } });
  if (url.pathname.startsWith('/v1/directions/driving/')) {
    if (routesFail) return send(503, { error: 'down' });
    return send(200, { code: 'Ok', routes: [{ distance: 5400, duration: 720, geometry: { type: 'LineString', coordinates: [[-87.19, 14.07], [-87.18, 14.08], [-87.16, 14.08]] } }] });
  }
  send(404, {});
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${fake.address().port}`;

process.env.MAPS_PROVIDER = 'locationiq';
process.env.MAPS_KEY = 'clave-de-prueba';
process.env.LOCATIONIQ_URL = base;
process.env.MAPS_RETRY_SECONDS = '1';
const maps = await import('../src/maps.js?locationiq');
check('con MAPS_PROVIDER=locationiq y su clave se usa LocationIQ', maps.mapsProvider === 'locationiq');

// Buscar
const near = { lat: 14.07, lng: -87.19 };
const found = await maps.searchPlaces('Multiplaza', near);
check('busca direcciones y deja solo las de Honduras', found.length === 1 && found[0].text === 'Mall Multiplaza, Bulevar Juan Pablo II, Lomas del Mayab, Tegucigalpa', JSON.stringify(found));
check('con números de verdad en las coordenadas', typeof found[0].lat === 'number' && found[0].lat === 14.0849 && found[0].lng === -87.1631);
const q = hits.find((u) => u.pathname === '/v1/autocomplete');
check('manda la clave, el país, el idioma y la zona cercana', q.searchParams.get('key') === 'clave-de-prueba' && q.searchParams.get('countrycodes') === 'hn' && q.searchParams.get('accept-language') === 'es' && !!q.searchParams.get('viewbox'));
const n = hits.length;
await maps.searchPlaces('  MULTIPLAZA ', near);
check('la misma búsqueda no se vuelve a pedir al proveedor (caché)', hits.length === n);

// Nombre de un punto
check('el nombre de un punto del mapa', (await maps.reversePlace(14.07, -87.2)) === 'Avenida La Paz 12, Barrio La Plazuela, Tegucigalpa');

// Rutas
const a = { lat: 14.07, lng: -87.19 };
const b = { lat: 14.08, lng: -87.16 };
const route = await maps.getRoute(a, b);
check('la ruta por calles (formato OSRM)', !route.estimated && route.distanceKm === 5.4 && route.durationMin === 12 && route.coords.length === 3 && route.coords[0][0] === 14.07);
check('la ruta pide el camino en el orden longitud,latitud', hits.some((u) => u.pathname === '/v1/directions/driving/-87.19,14.07;-87.16,14.08'));

// Servicio caído: se estima al instante y no se le vuelve a preguntar durante un rato
routesFail = true;
const c = { lat: 14.1, lng: -87.2 };
const d = { lat: 14.05, lng: -87.15 };
const est = await maps.getRoute(c, d);
check('si el servicio de rutas falla, la ruta se estima', est.estimated && est.distanceKm > 5 && est.coords.length === 2);
const before = hits.length;
const t0 = Date.now();
const est2 = await maps.getRoute({ lat: 14.11, lng: -87.21 }, d);
check('mientras está caído no se le pregunta (respuesta inmediata)', est2.estimated && hits.length === before && Date.now() - t0 < 50);
routesFail = false;
await new Promise((r) => setTimeout(r, 1100));
const again = await maps.getRoute({ lat: 14.12, lng: -87.22 }, d);
check('pasado el rato se vuelve a intentar', !again.estimated);
// La ruta estimada no se queda 10 minutos guardada (se reintenta al minuto); aquí se comprueba que sigue guardada antes del minuto
const before2 = hits.length;
check('una ruta estimada se guarda solo un momento (sigue guardada antes del minuto)', (await maps.getRoute(c, d)).estimated && hits.length === before2);

// Una clave equivocada no tumba la búsqueda de rutas: se estima
process.env.MAPS_KEY = 'otra';
const bad = await import('../src/maps.js?clave-mala');
check('con una clave equivocada las rutas se estiman (los viajes siguen)', (await bad.getRoute(a, { lat: 14.2, lng: -87.3 })).estimated);
let err = null;
try { await bad.searchPlaces('Multiplaza', null); } catch (e) { err = e; }
check('y la búsqueda avisa del error (la app pide tocar el mapa)', !!err);

// Sin clave, se queda con OpenStreetMap
delete process.env.MAPS_KEY;
const fallback = await import('../src/maps.js?sin-clave');
check('LocationIQ sin clave vuelve a los servicios públicos', fallback.mapsProvider === 'osm');

fake.close();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
