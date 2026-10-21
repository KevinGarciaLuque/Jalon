import 'dotenv/config';
// Herramienta de la prueba de llaves (rekey-unit): cada llamada es un proceso aparte con sus propias llaves, como el servidor real.
import fs from 'fs';
import { pool } from '../../src/db.js';
import { encryptBuffer, encryptText, openBuffer } from '../../src/secure.js';
import { rekeyAll } from '../../src/rekey.js';

const [cmd, a, b] = process.argv.slice(2);
const open = (blob) => { try { const r = openBuffer(blob); return { plain: r.plain.toString('utf8'), current: r.current }; } catch { return { error: true }; } };
let out;
if (cmd === 'seal-file') { fs.writeFileSync(a, encryptBuffer(Buffer.from(b))); out = { ok: true }; }
if (cmd === 'open-file') out = open(fs.readFileSync(a));
if (cmd === 'seal-user') { await pool.query('UPDATE users SET totp_secret = ? WHERE id = ?', [encryptText(b), a]); out = { ok: true }; }
if (cmd === 'open-user') { const [[u]] = await pool.query('SELECT totp_secret FROM users WHERE id = ?', [a]); out = open(Buffer.from(u.totp_secret, 'base64')); }
if (cmd === 'rekey') out = await rekeyAll(a, { userIds: b.split(',').map(Number) });
console.log(JSON.stringify(out));
await pool.end();
