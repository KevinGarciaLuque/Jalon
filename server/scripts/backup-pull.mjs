// Bajar los respaldos automáticos del almacenamiento externo (Cloudflare R2 u otro S3) y descifrarlos.
// Necesita las mismas variables que el servidor: BACKUP_S3_* y BACKUP_KEY.
//   npm run backup:pull                    baja el último respaldo de la base a server/backups (o BACKUP_DIR), ya descifrado
//   npm run backup:pull -- --list          muestra los respaldos de la base que hay guardados
//   npm run backup:pull -- --file=<nombre> baja ese respaldo en vez del último
//   npm run backup:pull -- --uploads [--to=<carpeta>]   baja los documentos a UPLOADS_DIR (o a esa carpeta). Nunca escribe
//                                          encima de un archivo que ya existe. Siguen cifrados con DATA_KEY, como en la app.
// Después, para la base: npm run restore -- <archivo .sql.gz>   (ver README, «Respaldos automáticos»)
import fs from 'fs';
import path from 'path';
import * as s3 from '../src/s3.js';
import { backupMissing, decryptFile, decryptBuffer } from '../src/backupCrypto.js';
import { UPLOADS } from '../src/config.js';

const args = process.argv.slice(2);
const opt = (name) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const missing = backupMissing();
if (missing.length) {
  console.error(`Faltan variables: ${missing.join(', ')}`);
  process.exit(2);
}

try {
  if (args.includes('--uploads')) {
    const to = path.resolve(opt('to') || UPLOADS);
    const all = (await s3.list('uploads/')).filter((o) => o.key.endsWith('.enc'));
    let got = 0;
    let skipped = 0;
    for (const o of all) {
      const name = o.key.slice('uploads/'.length, -'.enc'.length);
      const dest = path.join(to, ...name.split('/'));
      if (!dest.startsWith(to + path.sep)) continue; // nombre raro: no se sale de la carpeta
      if (fs.existsSync(dest)) { skipped++; continue; }
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, decryptBuffer(await s3.getBuffer(o.key)), { mode: 0o600 });
      got++;
    }
    console.log(`Documentos: ${got} bajados a ${to}${skipped ? `, ${skipped} ya estaban (no se tocaron)` : ''}.`);
  } else {
    const all = (await s3.list('db/')).filter((o) => o.key.endsWith('.sql.gz.enc')).sort((a, b) => new Date(b.modified) - new Date(a.modified));
    if (args.includes('--list')) {
      all.forEach((o) => console.log(`  ${o.key.slice(3)}   ${(o.size / 1048576).toFixed(1)} MB`));
      console.log(`${all.length} respaldo(s).`);
      process.exit(0);
    }
    const pick = opt('file') ? all.find((o) => o.key === `db/${opt('file')}` || o.key === `db/${opt('file')}.enc`) : all[0];
    if (!pick) throw new Error(opt('file') ? `No existe ${opt('file')} (mira la lista con --list)` : 'Todavía no hay respaldos guardados');
    const dir = path.resolve(process.env.BACKUP_DIR || path.join(import.meta.dirname, '..', 'backups'));
    fs.mkdirSync(dir, { recursive: true });
    const enc = path.join(dir, path.basename(pick.key));
    const plain = enc.replace(/\.enc$/, '');
    await s3.getToFile(pick.key, enc);
    await decryptFile(enc, plain);
    fs.rmSync(enc, { force: true });
    console.log(`Respaldo descifrado: ${plain}`);
    console.log(`Comprobar que se restaura bien (simulacro, no toca la app): npm run restore -- "${plain}"`);
  }
} catch (e) {
  console.error(`No se pudo: ${e.message}`);
  process.exitCode = 1;
}
