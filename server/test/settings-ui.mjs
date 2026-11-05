import 'dotenv/config';
// Ajustes por pestañas: cada sección en su pestaña, aviso de cambios sin guardar y un solo «Guardar ajustes» para todo.
// Uso: web en CLIENT_URL y API_URL (servidor de pruebas). VIEW_W/VIEW_H cambian el tamaño (por defecto, computadora).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { http, createTestSuperadmin } from './helpers.mjs';

const CLIENT = process.env.CLIENT_URL || 'http://localhost:4000';
const SHOTS = process.env.SHOTS_DIR || '';
const W = Number(process.env.VIEW_W) || 1366;
const H = Number(process.env.VIEW_H) || 900;
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = `${W < 700 ? 'cel' : 'pc'}${process.env.THEME ? `-${process.env.THEME}` : ''}`;
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}-${tag}.png`) });

const adm = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
try {
  const page = await browser.newPage();
  await page.setViewport({ width: W, height: H });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => { localStorage.setItem('jalon', JSON.stringify(s)); localStorage.removeItem('jalon-settings-tab'); }, { token: SA, user: { ...adm, role: 'superadmin', status: 'active' } });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('nav.sidebar, button.menu-btn', { timeout: 20000 });
  if (!(await page.$('nav.sidebar'))) { await (await page.$('button.menu-btn')).evaluate((b) => b.click()); await page.waitForSelector('.drawer'); await wait(400); }
  await (await page.waitForSelector('::-p-text(Ajustes)', { timeout: 15000 })).evaluate((b) => b.closest('button').click());
  await page.waitForSelector('.settings-tabs');
  await wait(400);

  const tabs = await page.$$eval('.settings-tabs [role="tab"]', (b) => b.map((x) => x.textContent.trim()));
  check('Ajustes tiene 6 pestañas', tabs.length === 6, tabs.join(' | '));
  const visible = (t) => page.evaluate((x) => document.body.innerText.includes(x), t);
  check('empieza en «Comisión y saldo»', (await visible('Cobrar comisión')) && !(await visible('Tarifas sugeridas')));
  await shot(page, 'ajustes-comision');

  const open = async (label) => { await (await page.$(`.settings-tabs button::-p-text(${label})`)).click(); await wait(250); };
  await open('Tarifas');
  check('«Tarifas» muestra solo las tarifas', (await visible('Tarifas sugeridas')) && !(await visible('Cobrar comisión')));
  await shot(page, 'ajustes-tarifas');
  await open('Viajes');
  check('«Viajes» tiene las propinas y el mapa', (await visible('Dejar que el pasajero dé propina')) && (await visible('El mapa puede girar')));
  await open('Seguridad');
  check('«Seguridad» tiene PIN, «¿Todo bien?», selfie y dos pasos', (await visible('Pedir el PIN')) && (await visible('Exigir verificación en dos pasos')));
  await open('Alquiler');
  check('«Alquiler» tiene sus reglas', await visible('Activar el alquiler'));
  await open('Cuentas bancarias');
  check('«Cuentas bancarias» oculta el botón de guardar ajustes', !(await page.$eval('form.settings', (f) => f.offsetParent !== null)));
  await shot(page, 'ajustes-cuentas');

  // Cambiar algo en una pestaña, ir a otra y guardar desde allí
  await open('Viajes');
  const tipBox = await page.evaluateHandle(() => [...document.querySelectorAll('.settings label.check')].find((l) => l.textContent.includes('propina')).querySelector('input'));
  const wasOn = await tipBox.evaluate((i) => i.checked);
  await tipBox.click();
  await wait(200);
  check('la pestaña con cambios se marca con •', (await page.$eval('#set-tab-rides', (b) => b.textContent)).includes('•'));
  check('avisa «Tienes cambios sin guardar»', await visible('Tienes cambios sin guardar'));
  await open('Comisión y saldo');
  check('desde otra pestaña dice dónde están los cambios', await visible('también en «Viajes»'));
  await shot(page, 'ajustes-sin-guardar');
  await (await page.$('.settings-save button.primary')).click();
  await page.waitForFunction(() => document.body.innerText.includes('Ajustes guardados'), { timeout: 8000 }).catch(() => {});
  check('guarda y quita la marca', (await visible('Ajustes guardados')) && !(await page.$eval('#set-tab-rides', (b) => b.textContent)).includes('•'));
  check('el cambio de la otra pestaña quedó guardado', (await http('GET', 'admin/settings', SA)).tips_enabled === (wasOn ? '0' : '1'));
  check('recuerda la pestaña al volver', await page.evaluate(() => localStorage.getItem('jalon-settings-tab')) === 'commission');
  check('no se sale de la pantalla', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
  await http('PUT', 'admin/settings', SA, { tips_enabled: before.tips_enabled !== '0' });
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
