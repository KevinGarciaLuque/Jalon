import 'dotenv/config';
// Etapa 7.2: respaldo y restauración comprobados (npm run backup / npm run restore)
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { spawnSync } from 'child_process';
import { pool, DB_NAME } from '../src/db.js';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jalon-respaldo-'));
const env = { ...process.env, BACKUP_DIR: dir };
const run = (script, ...args) => spawnSync(process.execPath, [`scripts/${script}.mjs`, ...args], { env, encoding: 'utf8' });
const rewrite = (from, to, change) => fs.writeFileSync(to, zlib.gzipSync(change(zlib.gunzipSync(fs.readFileSync(from)).toString('utf8'))));

try {
  // Un dato con tildes, comillas y saltos de línea, para ver que vuelve tal cual
  const note = "Prueba d'respaldo: «ñandú»\nsegunda línea \\ fin";
  const [[u]] = await pool.query('SELECT id FROM users ORDER BY id LIMIT 1');
  const [ins] = await pool.query("INSERT INTO audit_log (actor_id, action, details) VALUES (?, 'test.backup', ?)", [u.id, JSON.stringify({ note })]);

  const b = run('backup');
  const file = fs.readdirSync(dir).find((f) => f.endsWith('.sql.gz'));
  check('el respaldo termina bien y deja un archivo', b.status === 0 && !!file, b.stderr);
  check('sin archivos a medias', !fs.readdirSync(dir).some((f) => f.endsWith('.partial')));
  const full = path.join(dir, file);
  const sql = zlib.gunzipSync(fs.readFileSync(full)).toString('utf8');
  check('guarda las fechas en UTC (no se corren al restaurar en otro servidor)', sql.includes("SET time_zone = '+00:00';"));
  check('trae todas las tablas y el resumen final', /CREATE TABLE `users`/.test(sql) && /CREATE TABLE `wallet_entries`/.test(sql) && sql.includes('-- jalon-manifest '));

  // Simulacro de restauración
  const r = run('restore', full);
  check('el simulacro restaura y comprueba que quedó idéntico', r.status === 0 && r.stdout.includes('Restauración comprobada'), r.stderr.slice(-300));
  const [[left]] = await pool.query('SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ?', [`${DB_NAME}_restore_check`]);
  check('y borra la base del simulacro', left.n === 0);

  // Recuperación de verdad en una base nueva
  const into = `${DB_NAME}_recuperada`;
  await pool.query(`DROP DATABASE IF EXISTS \`${into}\``);
  const rec = run('restore', full, `--into=${into}`);
  check('restaura en una base nueva', rec.status === 0);
  const [[back]] = await pool.query(`SELECT details FROM \`${into}\`.audit_log WHERE id = ?`, [ins.insertId]);
  check('los textos con tildes, comillas y saltos de línea vuelven iguales', JSON.parse(typeof back.details === 'string' ? back.details : JSON.stringify(back.details)).note === note);
  const [[t1]] = await pool.query('SELECT UNIX_TIMESTAMP(created_at) AS t FROM audit_log WHERE id = ?', [ins.insertId]);
  const [[t2]] = await pool.query(`SELECT UNIX_TIMESTAMP(created_at) AS t FROM \`${into}\`.audit_log WHERE id = ?`, [ins.insertId]);
  check('las fechas vuelven exactas', Number(t1.t) === Number(t2.t));
  const [[a1]] = await pool.query("SELECT AUTO_INCREMENT AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'users'", [DB_NAME]);
  const [[a2]] = await pool.query("SELECT AUTO_INCREMENT AS n FROM information_schema.tables WHERE table_schema = ? AND table_name = 'users'", [into]);
  check('los números de los registros nuevos siguen donde iban', Number(a2.n) >= Number(a1.n) - 1);

  // Nunca escribe encima de datos
  check('no restaura encima de una base con datos', run('restore', full, `--into=${into}`).status !== 0);
  check('ni encima de la base de la app', run('restore', full, `--into=${DB_NAME}`).status !== 0);
  await pool.query(`DROP DATABASE IF EXISTS \`${into}\``);

  // Un respaldo alterado o incompleto se detecta
  const tampered = path.join(dir, 'alterado.sql.gz');
  rewrite(full, tampered, (s) => {
    const out = s.replace("'test.backup'", "'test.backuX'"); // se cambia una letra del registro de esta prueba
    if (out === s) throw new Error('no se pudo alterar el respaldo');
    return out;
  });
  const t = run('restore', tampered);
  check('un respaldo alterado no pasa la comprobación', t.status !== 0 && /algún valor es distinto/.test(t.stderr), t.stdout.slice(-200));
  const cut = path.join(dir, 'cortado.sql.gz');
  rewrite(full, cut, (s) => s.slice(0, s.indexOf('-- jalon-manifest')));
  const c = run('restore', cut);
  check('un respaldo incompleto se rechaza', c.status !== 0 && /incompleto/.test(c.stderr));
  const evil = path.join(dir, 'malicioso.sql.gz');
  rewrite(full, evil, (s) => s.replace('SET FOREIGN_KEY_CHECKS = 0;\n', `SET FOREIGN_KEY_CHECKS = 0;\nDROP DATABASE \`${DB_NAME}\`;\n`));
  const m = run('restore', evil);
  const [[still]] = await pool.query('SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ?', [DB_NAME]);
  check('un respaldo con sentencias ajenas (borrar una base) se rechaza sin tocar nada', m.status !== 0 && /no lleva/.test(m.stderr) && still.n === 1);
  check('un archivo que no existe, también',run('restore', path.join(dir, 'no-existe.sql.gz')).status !== 0);
} catch (e) {
  check('la prueba terminó sin errores', false, e.message);
} finally {
  await pool.query("DELETE FROM audit_log WHERE action = 'test.backup'").catch(() => {});
  fs.rmSync(dir, { recursive: true, force: true });
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
