// Restaurar un respaldo hecho con «npm run backup».
//   npm run restore -- <archivo>                simulacro: lo restaura en una base aparte (<base>_restore_check), comprueba que quedó
//                                               idéntico al respaldo y la borra. No toca la base de la app.
//   npm run restore -- <archivo> --into=<base>  recuperación de verdad: lo restaura en <base>, que debe estar vacía o no existir.
//                                               Nunca escribe encima de una base con datos.
// Opción --keep: en el simulacro, deja la base de prueba para revisarla.
import fs from 'fs';
import zlib from 'zlib';
import readline from 'readline';
import { connect, fingerprint, balanceIssues, tablesOf, q, DB_NAME, FORMAT } from './backup-lib.mjs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const into = args.find((a) => a.startsWith('--into='))?.slice(7);
const keep = args.includes('--keep');
if (!file || !fs.existsSync(file)) {
  console.error('Uso: npm run restore -- <archivo .sql.gz> [--into=<base vacía>] [--keep]');
  process.exit(2);
}
const target = into || `${DB_NAME}_restore_check`;
if (!/^[\w$]{1,64}$/.test(target)) {
  console.error(`Nombre de base inválido: ${target}`);
  process.exit(2);
}

const conn = await connect();
let ok = false;
try {
  // Seguridad: nunca se restaura encima de una base que tiene tablas (salvo la de simulacro, que es nuestra)
  const [[exists]] = await conn.query('SELECT COUNT(*) AS n FROM information_schema.schemata WHERE schema_name = ?', [target]);
  const tables = exists.n ? await tablesOf(conn, target) : [];
  if (into && tables.length) throw new Error(`La base «${target}» ya tiene ${tables.length} tablas. Para recuperar, crea una base nueva y vacía (no se escribe encima de datos).`);
  if (!into) await conn.query(`DROP DATABASE IF EXISTS ${q(target)}`);
  await conn.query(`CREATE DATABASE IF NOT EXISTS ${q(target)} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
  await conn.query(`USE ${q(target)}`);

  console.log(`Restaurando ${file}\nen la base «${target}»${into ? '' : ' (simulacro: se borra al final)'}…`);
  const t0 = Date.now();
  let manifest = null;
  let statements = 0;
  const lines = readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()), crlfDelay: Infinity });
  for await (const line of lines) {
    if (line.startsWith('-- jalon-manifest ')) manifest = JSON.parse(line.slice(18));
    if (!line.trim() || line.startsWith('--')) continue;
    await conn.query(line);
    statements++;
  }
  if (!manifest) throw new Error('El archivo está incompleto (le falta el resumen final). Usa otro respaldo.');
  if (manifest.format !== FORMAT) throw new Error(`Formato de respaldo desconocido (${manifest.format})`);
  console.log(`${statements} sentencias en ${((Date.now() - t0) / 1000).toFixed(1)} s. Comprobando…\n`);

  // ¿Quedó idéntico? Misma lista de tablas, mismas filas y la misma huella de cada tabla
  const restored = await fingerprint(conn, target);
  const problems = [];
  for (const [t, want] of Object.entries(manifest.tables)) {
    const got = restored[t];
    if (!got) problems.push(`falta la tabla ${t}`);
    else if (got.rows !== want.rows) problems.push(`${t}: ${got.rows} filas, el respaldo tenía ${want.rows}`);
    else if (got.hash !== want.hash) problems.push(`${t}: mismas filas pero algún valor es distinto`);
    console.log(`  ${got && got.rows === want.rows && got.hash === want.hash ? '✓' : '✗'} ${t.padEnd(22)} ${String(want.rows).padStart(7)} filas`);
  }
  for (const t of Object.keys(restored)) if (!manifest.tables[t]) problems.push(`tabla de más: ${t}`);

  // Revisión del negocio (no es un error del respaldo: muestra cómo venía la base)
  if (restored.users && restored.wallet_entries) {
    const issues = await balanceIssues(conn);
    console.log(issues.length
      ? `\nAviso: ${issues.length} conductor(es) con saldo distinto de la suma de sus movimientos (así venía en la base respaldada): ${issues.slice(0, 5).map((i) => `#${i.id}`).join(', ')}`
      : '\nSaldos: el de cada conductor coincide con la suma de sus movimientos.');
  }

  if (problems.length) {
    console.error(`\n✗ La restauración NO quedó idéntica al respaldo:\n  - ${problems.join('\n  - ')}`);
    process.exitCode = 1;
  } else {
    ok = true;
    console.log(`\n✓ Restauración comprobada: ${Object.keys(manifest.tables).length} tablas idénticas al respaldo del ${manifest.at} (base ${manifest.database}).`);
    if (into) console.log(`La base «${target}» está lista. Apunta la app a ella (MYSQL_URL o DB_NAME) y reiníciala.`);
  }
} catch (e) {
  console.error(`\n✗ No se pudo restaurar: ${e.message}`);
  process.exitCode = 1;
} finally {
  if (!into && !keep) await conn.query(`DROP DATABASE IF EXISTS ${q(target)}`).catch(() => {});
  else if (!into && keep) console.log(`(se dejó la base de prueba «${target}» para revisarla)`);
  await conn.end();
}
process.exit(ok ? 0 : 1);
