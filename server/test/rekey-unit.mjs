import 'dotenv/config';
// Etapa 8.1: poner DATA_KEY (o cambiarla) sin perder los documentos ni los secretos de la verificación en dos pasos
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { spawnSync } from 'child_process';
import { pool } from '../src/db.js';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jalon-llaves-'));
const key = () => crypto.randomBytes(32).toString('base64');
const JWT = 'secreto-jwt-de-la-prueba-de-llaves-0123456789';
const NEW = key();
const NEWER = key();
// Cada llamada corre con sus propias variables, como un servidor que arranca con otra configuración
function tool(env, ...args) {
  const e = { ...process.env, JWT_SECRET: JWT, ...env };
  for (const k of ['DATA_KEY', 'DATA_KEY_OLD']) if (env[k] === undefined) delete e[k];
  const r = spawnSync(process.execPath, ['test/fixtures/crypto-tool.mjs', ...args], { env: e, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr.slice(-400));
  return JSON.parse(r.stdout.trim().split('\n').pop());
}

const ids = [];
try {
  for (const n of [1, 2]) {
    const [r] = await pool.query(
      "INSERT INTO users (name, phone, password_hash, role, status, totp_enabled, terms_accepted_at) VALUES ('T Llaves', ?, ?, 'support', 'active', 1, NOW())",
      [`56${String(Math.floor(Math.random() * 1e6)).padStart(6, '0')}`, await bcrypt.hash('no-se-usa-1', 4)]
    );
    ids.push(r.insertId);
  }
  const doc = path.join(dir, '9-license-prueba.enc');
  const receipt = path.join(dir, 'topup-9-prueba.enc');

  // Antes: sin DATA_KEY (llave derivada de JWT_SECRET), como está hoy en Railway
  tool({}, 'seal-file', doc, 'licencia de conducir');
  tool({}, 'seal-file', receipt, 'comprobante');
  tool({}, 'seal-user', ids[0], 'SECRETO2FAUNO');
  tool({}, 'seal-user', ids[1], 'SECRETO2FADOS');
  check('sin DATA_KEY todo se lee con la llave de siempre', tool({}, 'open-file', doc).current === true);

  // Se pone DATA_KEY: lo de antes se sigue leyendo aunque todavía no se haya pasado a la llave nueva
  const before = tool({ DATA_KEY: NEW }, 'open-file', doc);
  check('con DATA_KEY nueva, lo cifrado antes se sigue leyendo', before.plain === 'licencia de conducir' && before.current === false);
  check('y los secretos 2FA también (el personal puede seguir entrando)', tool({ DATA_KEY: NEW }, 'open-user', ids[0]).plain === 'SECRETO2FAUNO');

  // Al arrancar se pasa todo a la llave nueva
  const r1 = tool({ DATA_KEY: NEW }, 'rekey', dir, ids.join(','));
  check('al arrancar se vuelven a cifrar los archivos y los secretos', r1.files === 2 && r1.secrets === 2 && r1.unreadable === 0, JSON.stringify(r1));
  check('sin archivos temporales a medias', !fs.readdirSync(dir).some((f) => f.endsWith('.rekey')));
  const after = tool({ DATA_KEY: NEW }, 'open-file', doc);
  check('ahora están con la llave nueva y el contenido es el mismo', after.current === true && after.plain === 'licencia de conducir');
  check('ya no dependen de JWT_SECRET (se puede cambiar sin perder nada)', tool({ DATA_KEY: NEW, JWT_SECRET: 'otro-jwt-totalmente-distinto-0123456789' }, 'open-file', receipt).plain === 'comprobante');
  check('los secretos 2FA también', tool({ DATA_KEY: NEW, JWT_SECRET: 'otro-jwt-totalmente-distinto-0123456789' }, 'open-user', ids[1]).plain === 'SECRETO2FADOS');
  const r2 = tool({ DATA_KEY: NEW }, 'rekey', dir, ids.join(','));
  check('la segunda vez no hay nada que hacer', r2.files === 0 && r2.secrets === 0);

  // Cambiar una DATA_KEY por otra: la anterior va en DATA_KEY_OLD
  check('sin la llave anterior, lo cifrado con ella no se lee', tool({ DATA_KEY: NEWER }, 'open-file', doc).error === true);
  const r3 = tool({ DATA_KEY: NEWER, DATA_KEY_OLD: NEW }, 'rekey', dir, ids.join(','));
  check('con DATA_KEY_OLD se pasa todo a la llave nueva', r3.files === 2 && r3.secrets === 2);
  check('y se lee solo con la nueva', tool({ DATA_KEY: NEWER }, 'open-user', ids[0]).plain === 'SECRETO2FAUNO');

  // Un archivo que no se puede leer con ninguna llave se deja como estaba
  fs.writeFileSync(path.join(dir, 'roto.enc'), Buffer.concat([Buffer.from('JE1'), crypto.randomBytes(60)]));
  const r4 = tool({ DATA_KEY: key(), DATA_KEY_OLD: key() }, 'rekey', dir, ids.join(','));
  check('lo que no se puede leer se deja como estaba (y se avisa)', r4.unreadable >= 1 && fs.readFileSync(path.join(dir, 'roto.enc')).length === 63);
  check('una DATA_KEY mal escrita detiene el arranque (mejor que cifrar con algo raro)', spawnSync(process.execPath, ['test/fixtures/crypto-tool.mjs', 'open-file', doc], { env: { ...process.env, DATA_KEY: 'corta' }, encoding: 'utf8' }).status !== 0);
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
} finally {
  if (ids.length) await pool.query('DELETE FROM users WHERE id IN (?)', [ids]);
  fs.rmSync(dir, { recursive: true, force: true });
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
