import 'dotenv/config';
// Respaldos automáticos: base y documentos cifrados en un almacenamiento S3 (aquí uno falso), se pueden bajar y restaurar,
// se borran los viejos, y si falla se avisa. La firma de las peticiones se comprueba con los ejemplos oficiales de AWS.
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import crypto from 'crypto';
import { spawn } from 'child_process';
import jwt from 'jsonwebtoken';

let fails = 0;
// Los scripts se corren sin bloquear: el almacenamiento falso vive en este mismo proceso y tiene que poder contestarles
const run = (args, env) => new Promise((resolve) => {
  const c = spawn(process.execPath, args, { env });
  let stdout = '';
  let stderr = '';
  c.stdout.on('data', (d) => (stdout += d));
  c.stderr.on('data', (d) => (stderr += d));
  c.on('close', (status) => resolve({ status, stdout, stderr }));
});
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

// ---------- Almacenamiento S3 falso (en memoria) ----------
const store = new Map(); // llave → { body, modified }
let deny = false;
const lengths = [];
const fake = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    const u = new URL(req.url, 'http://x');
    const [, bucket, ...rest] = u.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    if (deny || bucket !== 'respaldos' || !/^AWS4-HMAC-SHA256 Credential=llave-prueba\//.test(req.headers.authorization || '')) {
      res.writeHead(403); return res.end('<Error><Code>AccessDenied</Code></Error>');
    }
    const body = Buffer.concat(chunks);
    if (req.method === 'PUT') {
      lengths.push([Number(req.headers['content-length']), body.length]);
      store.set(key, { body, modified: new Date() });
      return res.end();
    }
    if (req.method === 'DELETE') { store.delete(key); res.writeHead(204); return res.end(); }
    if (u.searchParams.get('list-type') === '2') {
      // De a 3 por página, para probar que se recorren todas
      const keys = [...store.keys()].filter((k) => k.startsWith(u.searchParams.get('prefix') || '')).sort();
      const from = Number(u.searchParams.get('continuation-token') || 0);
      const page = keys.slice(from, from + 3);
      const more = from + 3 < keys.length;
      res.setHeader('content-type', 'application/xml');
      return res.end(`<ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + 3}</NextContinuationToken>` : ''}${page.map((k) => `<Contents><Key>${k.replace(/&/g, '&amp;')}</Key><Size>${store.get(k).body.length}</Size><LastModified>${store.get(k).modified.toISOString()}</LastModified></Contents>`).join('')}</ListBucketResult>`);
    }
    const o = store.get(key);
    if (!o) { res.writeHead(404); return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
    res.end(o.body);
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));

// Documentos de prueba en una carpeta aparte
const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'ktracho-uploads-'));
fs.mkdirSync(path.join(uploads, 'recibos'));
fs.writeFileSync(path.join(uploads, 'doc-1.jpg'), crypto.randomBytes(5000));
fs.writeFileSync(path.join(uploads, 'doc-2.jpg'), crypto.randomBytes(3000));
fs.writeFileSync(path.join(uploads, 'recibos', 'r-1.jpg'), crypto.randomBytes(2000));

const KEY = crypto.randomBytes(32).toString('base64');
const BACKUP_ENV = {
  BACKUP_S3_ENDPOINT: `http://127.0.0.1:${fake.address().port}`, BACKUP_S3_BUCKET: 'respaldos', BACKUP_S3_ACCESS_KEY: 'llave-prueba',
  BACKUP_S3_SECRET_KEY: 'secreto-prueba', BACKUP_KEY: KEY, UPLOADS_DIR: uploads,
};
// El servidor de pruebas no tiene respaldos configurados: primero se prueba eso por la API
const { pool } = await import('../src/db.js');
const { API, http: api, createTestSuperadmin } = await import('./helpers.mjs');
const root = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });

try {
  const off = await api('GET', 'admin/backups', SA);
  check('sin configurar, Sistema dice qué variables faltan', off.configured === false && off.missing.includes('BACKUP_KEY') && off.missing.includes('BACKUP_S3_BUCKET'), JSON.stringify(off.missing));
  check('sin configurar no se puede «Respaldar ahora»', (await api('POST', 'admin/backups/run', SA, {})).status === 409);
  const sys = await api('GET', 'admin/system', SA);
  check('Sistema muestra los respaldos automáticos como apagados', sys.items?.some((i) => i.label === 'Respaldos automáticos' && /Apagados/.test(i.detail)));
  check('un pasajero no ve los respaldos', (await fetch(`${API}/api/admin/backups`)).status === 401);

  Object.assign(process.env, BACKUP_ENV);
  const { sign } = await import('../src/s3.js');
  const crypt = await import('../src/backupCrypto.js');
  const B = await import('../src/services/backups.js');

  // ---------- Firma (ejemplos oficiales de AWS) ----------
  const base = { accessKey: 'AKIAIOSFODNN7EXAMPLE', secretKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY', region: 'us-east-1', now: new Date('2013-05-24T00:00:00Z'), payloadHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855' };
  check('firma igual al ejemplo de AWS (leer un archivo)', sign({ ...base, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/test.txt', headers: { range: 'bytes=0-9' } }).authorization.endsWith('Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41'));
  check('firma igual al ejemplo de AWS (listar)', sign({ ...base, method: 'GET', url: 'https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J' }).authorization.endsWith('Signature=34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7'));

  // ---------- Cifrado ----------
  const secret = Buffer.from('datos de la base 99887766');
  const sealed = crypt.encryptBuffer(secret);
  check('el cifrado no deja ver el contenido', !sealed.includes(Buffer.from('99887766')));
  check('se descifra con la misma llave', crypt.decryptBuffer(sealed).equals(secret));
  let wrong = false;
  try { crypt.decryptBuffer(sealed, crypto.randomBytes(32)); } catch { wrong = true; }
  check('con otra llave no se puede leer', wrong);
  const tampered = Buffer.from(sealed); tampered[20] ^= 1;
  let caught = false;
  try { crypt.decryptBuffer(tampered); } catch { caught = true; }
  check('si alguien lo altera, se nota', caught);

  // ---------- Primer respaldo ----------
  check('con las variables, queda configurado', B.backupConfigured());
  const first = await B.runBackup({ trigger: 'manual', actor: root.id });
  const [[row]] = await pool.query('SELECT * FROM backups WHERE id = ?', [first.id]);
  check('el respaldo queda anotado como bueno', row.status === 'ok' && row.trigger === 'manual' && row.bytes > 0 && row.rows_count > 0 && row.tables_count > 10, JSON.stringify({ status: row.status, error: row.error }));
  const dbKey = [...store.keys()].find((k) => k.startsWith('db/'));
  check('la base se sube a db/ cifrada', /^db\/.+\.sql\.gz\.enc$/.test(dbKey || '') && store.get(dbKey).body.subarray(0, 4).toString() === 'KTB1');
  check('los documentos se suben cifrados (también los de subcarpetas)', ['uploads/doc-1.jpg.enc', 'uploads/doc-2.jpg.enc', 'uploads/recibos/r-1.jpg.enc'].every((k) => store.get(k)?.body.subarray(0, 4).toString() === 'KTB1') && first.files.uploaded === 3);
  check('el índice de documentos va cifrado', store.get('uploads/_indice.json')?.body.subarray(0, 4).toString() === 'KTB1');
  check('cada subida dice su tamaño (lo exige R2)', lengths.length > 0 && lengths.every(([h, b]) => h === b));
  check('sin cifrar no queda nada en la carpeta temporal', !fs.readdirSync(os.tmpdir()).some((f) => f.startsWith('ktracho-respaldo-')));

  // ---------- Se puede restaurar ----------
  const env = { ...process.env };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ktracho-bajada-'));
  const pull = await run(['scripts/backup-pull.mjs'], { ...env, BACKUP_DIR: dir });
  const plain = fs.readdirSync(dir).find((f) => f.endsWith('.sql.gz'));
  check('«npm run backup:pull» baja y descifra el último', pull.status === 0 && !!plain, pull.stderr || pull.stdout);
  const restore = await run(['scripts/restore.mjs', path.join(dir, plain)], env);
  check('y el simulacro de restauración queda idéntico', restore.status === 0 && /Restauración comprobada/.test(restore.stdout), (restore.stderr || '').slice(-300));
  // También directo desde el archivo cifrado (bajado a mano de R2)
  const encCopy = path.join(dir, 'a-mano.sql.gz.enc');
  fs.writeFileSync(encCopy, store.get(dbKey).body);
  const restoreEnc = await run(['scripts/restore.mjs', encCopy], env);
  check('«npm run restore» también acepta el archivo cifrado', restoreEnc.status === 0 && !fs.existsSync(path.join(dir, 'a-mano.sql.gz')), (restoreEnc.stderr || '').slice(-300));
  const badKey = await run(['scripts/restore.mjs', encCopy], { ...env, BACKUP_KEY: crypto.randomBytes(32).toString('base64') });
  check('con otra BACKUP_KEY no se restaura y lo explica', badKey.status !== 0 && /BACKUP_KEY no es la correcta/.test(badKey.stderr));
  const docsTo = path.join(dir, 'documentos');
  const pullDocs = await run(['scripts/backup-pull.mjs', '--uploads', `--to=${docsTo}`], env);
  check('los documentos se bajan idénticos', pullDocs.status === 0 && ['doc-1.jpg', 'doc-2.jpg', 'recibos/r-1.jpg'].every((f) => fs.readFileSync(path.join(docsTo, f)).equals(fs.readFileSync(path.join(uploads, f)))), pullDocs.stderr);
  fs.writeFileSync(path.join(docsTo, 'doc-1.jpg'), 'mío');
  await run(['scripts/backup-pull.mjs', '--uploads', `--to=${docsTo}`], env);
  check('al bajar documentos nunca escribe encima de uno que ya existe', fs.readFileSync(path.join(docsTo, 'doc-1.jpg'), 'utf8') === 'mío');

  // ---------- Solo se copian los documentos nuevos o cambiados; los borrados se guardan 30 días ----------
  fs.writeFileSync(path.join(uploads, 'doc-2.jpg'), crypto.randomBytes(3100)); // cambió (p. ej. al cambiar la llave de cifrado)
  fs.writeFileSync(path.join(uploads, 'doc-3.jpg'), crypto.randomBytes(100)); // nuevo
  fs.rmSync(path.join(uploads, 'doc-1.jpg')); // se borró en la app
  const second = await B.syncUploads();
  check('solo sube lo nuevo y lo cambiado', second.uploaded === 2, JSON.stringify(second));
  check('lo borrado en la app sigue en la copia unos días', store.has('uploads/doc-1.jpg.enc') && second.deleted === 0);
  const later = await B.syncUploads(new Date(Date.now() + 31 * 86400e3));
  check('a los 30 días de borrado se quita de la copia', !store.has('uploads/doc-1.jpg.enc') && later.deleted === 1 && later.uploaded === 0);

  // ---------- Los respaldos viejos de la base se borran (quedan al menos 3) ----------
  const old = (d) => ({ body: Buffer.from('KTB1viejo'), modified: new Date(Date.now() - d * 86400e3) });
  ['db/x-20260901-0900.sql.gz.enc', 'db/x-20260902-0900.sql.gz.enc', 'db/x-20260903-0900.sql.gz.enc'].forEach((k, i) => store.set(k, old(60 - i)));
  await B.runBackup();
  const dbs = [...store.keys()].filter((k) => k.startsWith('db/'));
  check('borra los de más de 30 días pero siempre deja los 3 últimos', dbs.length === 3 && dbs.includes('db/x-20260903-0900.sql.gz.enc') && !dbs.includes('db/x-20260901-0900.sql.gz.enc'), JSON.stringify(dbs));

  // ---------- Uno a la vez ----------
  const both = await Promise.allSettled([B.runBackup(), B.runBackup()]);
  check('no se hacen dos respaldos a la vez', both.filter((r) => r.status === 'fulfilled').length === 1 && both.some((r) => r.status === 'rejected' && /Ya se está haciendo/.test(r.reason.message)));

  // ---------- Cuándo toca (hora de Honduras) ----------
  await pool.query("DELETE FROM backups WHERE `trigger` = 'auto'");
  const at = (h) => new Date(`2026-11-04T${String(h + 6).padStart(2, '0')}:30:00Z`); // h:30 en Honduras
  check('antes de las 3 a. m. no toca', !(await B.backupDue(at(2))));
  check('después de las 3 a. m., sin uno de hoy, toca', await B.backupDue(at(3)));
  await pool.query("INSERT INTO backups (status, `trigger`, started_at) VALUES ('ok', 'auto', ?)", [at(3)]);
  check('con uno bueno de hoy ya no toca', !(await B.backupDue(at(9))));
  check('al día siguiente vuelve a tocar', await B.backupDue(new Date(at(3).getTime() + 86400e3)));
  await pool.query("DELETE FROM backups WHERE `trigger` = 'auto'");
  await pool.query("INSERT INTO backups (status, `trigger`, started_at) VALUES ('failed', 'auto', ?)", [at(3)]);
  check('si falló, espera una hora para reintentar', !(await B.backupDue(new Date(at(3).getTime() + 30 * 60e3))) && (await B.backupDue(new Date(at(3).getTime() + 61 * 60e3))));
  await pool.query("INSERT INTO backups (status, `trigger`, started_at) VALUES ('failed', 'auto', ?), ('failed', 'auto', ?)", [at(4), at(5)]);
  check('después de 3 intentos fallidos no insiste ese día', !(await B.backupDue(at(10))));
  await pool.query("DELETE FROM backups WHERE `trigger` = 'auto'");

  // ---------- Si falla, queda anotado y se avisa ----------
  deny = true;
  let failMsg = '';
  try { await B.runBackup({ trigger: 'manual' }); } catch (e) { failMsg = e.message; }
  deny = false;
  const [[bad]] = await pool.query("SELECT status, error FROM backups ORDER BY id DESC LIMIT 1");
  check('un fallo queda anotado con el motivo', bad.status === 'failed' && /403 \(AccessDenied\)/.test(bad.error), failMsg);
  await new Promise((r) => setTimeout(r, 500));
  const [[note]] = await pool.query("SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND title = 'Falló el respaldo de la base de datos'", [root.id]);
  check('y el superadmin recibe el aviso', note.n >= 1);
  const list = await B.recentBackups(5);
  check('la lista de respaldos trae el último primero', list[0].status === 'failed' && list.some((b) => b.status === 'ok'));
  fs.rmSync(dir, { recursive: true, force: true });
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  fake.close();
  fs.rmSync(uploads, { recursive: true, force: true });
}

await pool.query('DELETE FROM backups');
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
