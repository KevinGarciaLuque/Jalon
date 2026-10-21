// Etapa 7.4: la web se entrega en piezas comprimidas con Brotli; una pieza vieja que ya no existe da 404 (no la página)
import fs from 'fs';
import path from 'path';
import http from 'http';
import { API } from './helpers.mjs';

// Pide un archivo y devuelve los bytes tal como llegan (fetch los descomprimiría solo)
const raw = (url, encoding) => new Promise((resolve, reject) => {
  http.get(url, { headers: { 'Accept-Encoding': encoding } }, (res) => {
    const parts = [];
    res.on('data', (c) => parts.push(c));
    res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(parts) }));
  }).on('error', reject);
});

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const DIST = path.join(import.meta.dirname, '..', '..', 'client', 'dist');

if (!fs.existsSync(path.join(DIST, 'index.html'))) {
  console.log('(sin client/dist: compila la web con «npm run build» para probar esta parte)');
} else {
  const html = await (await fetch(`${API}/`)).text();
  const main = /\/assets\/index-[\w-]+\.js/.exec(html)?.[0];
  check('la página carga su pieza principal', !!main);
  const br = await raw(`${API}${main}`, 'gzip, deflate, br');
  const plain = await raw(`${API}${main}`, 'identity');
  check('a quien acepta Brotli se le manda comprimida', br.status === 200 && br.headers['content-encoding'] === 'br' && /javascript/.test(br.headers['content-type']));
  check('y avisa que depende de la compresión aceptada', /Accept-Encoding/i.test(br.headers.vary || ''));
  check('se guarda un año en el navegador (el nombre cambia con cada versión)', /immutable/.test(br.headers['cache-control'] || ''));
  check('a quien no la acepta, el archivo normal', plain.status === 200 && !plain.headers['content-encoding'] && plain.body.includes('react'));
  check('comprimida pesa menos de un tercio', br.body.length * 3 < plain.body.length, `(${(br.body.length / 1024).toFixed(0)} kB de ${(plain.body.length / 1024).toFixed(0)} kB)`);
  const gone = await fetch(`${API}/assets/Passenger-viejo123.js`);
  check('una pieza de una versión anterior da 404 (así la app sabe que debe recargarse)', gone.status === 404 && !/html/.test(gone.headers.get('content-type') || ''));
  check('no se puede salir de la carpeta', (await fetch(`${API}/assets/..%2f..%2fserver%2fpackage.json`, { headers: { 'Accept-Encoding': 'br' } })).status === 404);
  const pages = (await fetch(`${API}/privacidad`)).status;
  check('las páginas siguen entregando la app', pages === 200);
  const lazy = fs.readdirSync(path.join(DIST, 'assets')).filter((f) => /^(Admin|Passenger|Driver|mapParts|socket)-.*\.js$/.test(f));
  check('el panel, el mapa y el tiempo real van en piezas aparte', ['Admin', 'Passenger', 'Driver', 'mapParts', 'socket'].every((p) => lazy.some((f) => f.startsWith(`${p}-`))));
  const mainSrc = fs.readFileSync(path.join(DIST, main), 'utf8');
  check('la pieza principal no trae Leaflet ni el panel', !mainSrc.includes('leaflet-container') && !mainSrc.includes('Exportar a Excel'));
}

console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
