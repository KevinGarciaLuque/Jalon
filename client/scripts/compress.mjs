// Después de compilar: guarda junto a cada .js y .css de dist/assets una copia comprimida con Brotli (.br).
// El servidor la entrega a los navegadores que la aceptan (todos los actuales): pesa ~12% menos que con gzip.
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';

const dir = path.join(import.meta.dirname, '..', 'dist', 'assets');
let before = 0;
let after = 0;
for (const name of fs.readdirSync(dir)) {
  if (!/\.(js|css)$/.test(name)) continue;
  const data = fs.readFileSync(path.join(dir, name));
  const br = zlib.brotliCompressSync(data, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: data.length } });
  fs.writeFileSync(path.join(dir, `${name}.br`), br);
  before += data.length;
  after += br.length;
}
console.log(`Brotli: ${(before / 1024).toFixed(0)} kB → ${(after / 1024).toFixed(0)} kB`);
