// Almacenamiento fuera de Railway para los respaldos: cualquier servicio compatible con S3 (Cloudflare R2, Backblaze B2, AWS S3).
// Sin librerías: las peticiones se firman con AWS Signature V4 (lo que piden todos estos servicios).
//   BACKUP_S3_ENDPOINT   p. ej. https://<cuenta>.r2.cloudflarestorage.com
//   BACKUP_S3_BUCKET     el nombre del espacio (bucket)
//   BACKUP_S3_ACCESS_KEY y BACKUP_S3_SECRET_KEY   la llave con permiso de leer y escribir en ese espacio
//   BACKUP_S3_REGION     opcional («auto» sirve para R2)
import crypto from 'crypto';
import fs from 'fs';
import { Readable } from 'stream';

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();
// Como pide S3: todo codificado menos letras, números y - _ . ~ (y «/» en la ruta)
const enc = (s, keepSlash) => {
  const e = encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
  return keepSlash ? e.replace(/%2F/g, '/') : e;
};

// Firma una petición (AWS Signature V4). Devuelve las cabeceras que hay que mandar.
export function sign({ method, url, headers = {}, payloadHash = 'UNSIGNED-PAYLOAD', accessKey, secretKey, region, service = 's3', now = new Date() }) {
  const u = new URL(url);
  const amzDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  const day = amzDate.slice(0, 8);
  const all = { ...headers, host: u.host, 'x-amz-content-sha256': payloadHash, 'x-amz-date': amzDate };
  const names = Object.keys(all).map((h) => h.toLowerCase()).sort();
  const lower = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), String(v).trim()]));
  const query = [...u.searchParams].map(([k, v]) => [enc(k), enc(v)]).sort(([a, x], [b, y]) => (a < b ? -1 : a > b ? 1 : x < y ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join('&');
  const canonical = [method, enc(decodeURIComponent(u.pathname), true), query, names.map((h) => `${h}:${lower[h]}\n`).join(''), names.join(';'), payloadHash].join('\n');
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  const key = hmac(hmac(hmac(hmac(`AWS4${secretKey}`, day), region), service), 'aws4_request');
  const signature = crypto.createHmac('sha256', key).update(toSign).digest('hex');
  return { ...all, authorization: `AWS4-HMAC-SHA256 Credential=${accessKey}/${scope}, SignedHeaders=${names.join(';')}, Signature=${signature}` };
}

const cfg = () => ({
  endpoint: (process.env.BACKUP_S3_ENDPOINT || '').replace(/\/+$/, ''),
  bucket: process.env.BACKUP_S3_BUCKET || '',
  accessKey: process.env.BACKUP_S3_ACCESS_KEY || '',
  secretKey: process.env.BACKUP_S3_SECRET_KEY || '',
  region: process.env.BACKUP_S3_REGION || 'auto',
});
export const s3Missing = () => Object.entries({ BACKUP_S3_ENDPOINT: cfg().endpoint, BACKUP_S3_BUCKET: cfg().bucket, BACKUP_S3_ACCESS_KEY: cfg().accessKey, BACKUP_S3_SECRET_KEY: cfg().secretKey })
  .filter(([, v]) => !v).map(([k]) => k);

async function request(method, key, { query = '', body, length, headers = {} } = {}) {
  const c = cfg();
  const url = `${c.endpoint}/${enc(c.bucket)}/${enc(key, true)}${query ? `?${query}` : ''}`;
  const h = sign({ method, url, headers: { ...headers, ...(length !== undefined ? { 'content-length': length } : {}) }, accessKey: c.accessKey, secretKey: c.secretKey, region: c.region });
  delete h.host; // lo pone fetch
  const res = await fetch(url, { method, headers: h, body, duplex: body ? 'half' : undefined, signal: AbortSignal.timeout(10 * 60 * 1000) });
  if (!res.ok && !(method === 'GET' && res.status === 404) && !(method === 'DELETE' && res.status === 404)) {
    const text = await res.text().catch(() => '');
    const code = text.match(/<Code>([^<]+)<\/Code>/)?.[1];
    throw new Error(`El almacenamiento respondió ${res.status}${code ? ` (${code})` : ''} al ${method === 'PUT' ? 'subir' : method === 'DELETE' ? 'borrar' : 'leer'} ${key}`);
  }
  return res;
}

// Sube un archivo del disco (sin cargarlo entero en memoria)
export async function putFile(key, file) {
  const { size } = await fs.promises.stat(file);
  await request('PUT', key, { body: Readable.toWeb(fs.createReadStream(file)), length: size, headers: { 'content-type': 'application/octet-stream' } });
  return size;
}
export async function putBuffer(key, buf) {
  await request('PUT', key, { body: buf, length: buf.length, headers: { 'content-type': 'application/octet-stream' } });
}
// null si no existe
export async function getBuffer(key) {
  const res = await request('GET', key);
  return res.status === 404 ? null : Buffer.from(await res.arrayBuffer());
}
export async function getToFile(key, file) {
  const res = await request('GET', key);
  if (res.status === 404) throw new Error(`No existe ${key} en el almacenamiento`);
  await fs.promises.writeFile(file, Readable.fromWeb(res.body));
}
export const remove = (key) => request('DELETE', key);

// Todo lo que hay bajo «prefix»: [{ key, size, modified }]
export async function list(prefix) {
  const out = [];
  let token = null;
  do {
    const q = new URLSearchParams({ 'list-type': '2', prefix, ...(token ? { 'continuation-token': token } : {}) });
    const xml = await (await request('GET', '', { query: q.toString() })).text();
    for (const m of xml.matchAll(/<Contents>([\s\S]*?)<\/Contents>/g)) {
      const tag = (t) => m[1].match(new RegExp(`<${t}>([^<]*)</${t}>`))?.[1];
      out.push({ key: tag('Key').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'"), size: Number(tag('Size')), modified: tag('LastModified') });
    }
    token = /<IsTruncated>true<\/IsTruncated>/.test(xml) ? xml.match(/<NextContinuationToken>([^<]+)<\/NextContinuationToken>/)?.[1] : null;
  } while (token);
  return out;
}
