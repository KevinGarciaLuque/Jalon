// Limpieza de JPEG en el servidor: nunca se confía en que la app ya haya reducido la foto.
// - Quita los metadatos (EXIF con la ubicación GPS y el modelo del celular, XMP, comentarios, miniaturas): segmentos APPn y COM.
// - Quita todo lo que venga después del fin de imagen (así no se esconde otro archivo detrás de una foto).
// - Comprueba que la estructura sea de un JPEG real (cabecera, tamaño, datos y fin) y limita las dimensiones.
export class JpegError extends Error {}

const MAX_SIDE = 8000; // píxeles

export function sanitizeJpeg(input) {
  const b = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) throw new JpegError('No es un JPEG');

  const out = [Buffer.from([0xff, 0xd8])];
  let i = 2;
  let size = null;
  let scans = 0;
  let ended = false;

  while (i < b.length) {
    if (b[i] !== 0xff) throw new JpegError('Estructura inválida');
    while (b[i] === 0xff) i++; // relleno permitido entre segmentos
    const marker = b[i++];
    if (marker === undefined) throw new JpegError('Estructura incompleta');

    if (marker === 0xd9) { ended = true; break; } // EOI: lo que siga se descarta
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd8)) continue; // marcadores sin contenido

    if (i + 2 > b.length) throw new JpegError('Segmento truncado');
    const len = b.readUInt16BE(i);
    if (len < 2 || i + len > b.length) throw new JpegError('Segmento inválido');
    const segment = b.subarray(i - 2, i + len); // incluye 0xFF + marcador + longitud + datos

    if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7) || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
      if (len < 8) throw new JpegError('Cabecera de imagen inválida');
      size = { height: b.readUInt16BE(i + 3), width: b.readUInt16BE(i + 5) };
    }

    const isMetadata = (marker >= 0xe0 && marker <= 0xef) || marker === 0xfe;
    if (!isMetadata) out.push(segment);
    i += len;

    if (marker === 0xda) {
      // Inicio de datos de la imagen: se copia todo hasta el siguiente marcador "de verdad"
      // (en los datos, FF00 es un byte FF normal y FFD0-D7 son marcas de reinicio)
      const start = i;
      while (i < b.length) {
        if (b[i] === 0xff && b[i + 1] !== 0x00 && !(b[i + 1] >= 0xd0 && b[i + 1] <= 0xd7) && b[i + 1] !== 0xff) break;
        i++;
      }
      out.push(b.subarray(start, i));
      scans++;
    }
  }

  if (!ended) throw new JpegError('El archivo está incompleto');
  if (!size || !scans) throw new JpegError('No contiene una imagen');
  if (!size.width || !size.height || size.width > MAX_SIDE || size.height > MAX_SIDE) throw new JpegError('Dimensiones no permitidas');

  out.push(Buffer.from([0xff, 0xd9]));
  return { buf: Buffer.concat(out), ...size };
}
