import 'dotenv/config';
// Panel → Sistema en la pantalla: la sección de respaldos con los últimos intentos. Uso: web en CLIENT_URL (servidor sin BACKUP_*)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { createTestSuperadmin } from './helpers.mjs';

const CLIENT = process.env.CLIENT_URL || 'http://localhost:4000';
const SHOTS = process.env.SHOTS_DIR || '';
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const adm = await createTestSuperadmin(pool);
await pool.query(
  "INSERT INTO backups (status, `trigger`, started_at, finished_at, bytes, rows_count, files_total, files_uploaded, error) VALUES ('ok','auto', NOW() - INTERVAL 1 DAY, NOW() - INTERVAL 1 DAY, 5400000, 12345, 310, 12, NULL), ('failed','manual', NOW() - INTERVAL 2 HOUR, NOW() - INTERVAL 2 HOUR, NULL, NULL, NULL, NULL, 'El almacenamiento respondió 403 (AccessDenied) al subir db/x.sql.gz.enc')"
);
const session = { token: jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' }), user: { ...adm, role: 'superadmin', status: 'active' } };
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: Number(process.env.VIEW_W) || 390, height: Number(process.env.VIEW_H) || 844 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => localStorage.setItem('jalon', JSON.stringify(s)), session);
  await page.reload({ waitUntil: 'networkidle2' });
  const see = (text, timeout = 15000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true, () => false);
  for (const label of ['Acepto', 'Aceptar', 'Ahora no']) {
    const b = await page.$(`button::-p-text(${label})`);
    if (b) { await b.evaluate((x) => x.click()); await wait(300); }
  }
  const tab = await page.waitForSelector('button::-p-text(Sistema)', { timeout: 20000 });
  await tab.evaluate((b) => b.click());
  check('se abre Sistema', await see('Versión publicada'));
  check('muestra que los respaldos automáticos están apagados y qué falta', await see('Respaldos automáticos') && await see('Faltan en Railway: BACKUP_S3_ENDPOINT'));
  check('la sección Respaldos lista los últimos intentos', await see('Base 5.1 MB · 12345 filas · 12 documento(s) nuevos de 310') && await see('403 (AccessDenied)'));
  check('cada intento dice si salió bien con palabra (no solo color)', await see('✓ Listo') && await see('✕ Falló'));
  check('sin configurar no aparece «Respaldar ahora»', !(await page.evaluate(() => document.body.innerText.includes('Respaldar ahora'))));
  const section = await page.$('section[aria-label="Respaldos"]');
  await section.evaluate((s) => s.scrollIntoView({ block: 'center' }));
  await wait(400);
  const wide = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no se sale de la pantalla a lo ancho', !wide);
  if (SHOTS) await page.screenshot({ path: path.join(SHOTS, `sistema-respaldos${process.env.THEME ? `-${process.env.THEME}` : ''}.png`) });
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
  await pool.query('DELETE FROM backups');
  await pool.query('DELETE FROM users WHERE id = ?', [adm.id]).catch(() => {});
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
