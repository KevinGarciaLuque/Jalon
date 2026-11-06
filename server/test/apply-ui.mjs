import 'dotenv/config';
// «Quiero ser conductor» en la pantalla: un pasajero registra su vehículo y pasa a subir sus documentos. Uso: web en CLIENT_URL y API_URL
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import { pool } from '../src/db.js';
import { registerUser } from './helpers.mjs';

const CLIENT = process.env.CLIENT_URL || 'http://localhost:4000';
const SHOTS = process.env.SHOTS_DIR || '';
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const phone = `8${rnd}4`.slice(0, 8);
await registerUser({ name: 'UI Pasajera', phone, password: 'Cielo-azul-77', role: 'passenger' });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(CLIENT, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: Number(process.env.VIEW_W) || 390, height: Number(process.env.VIEW_H) || 844 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  await page.setGeolocation({ latitude: 14.0723, longitude: -87.1921, accuracy: 5 });
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  // Aparato nuevo: primero pregunta si ya tiene cuenta
  await (await page.waitForSelector('button::-p-text(Ya tengo cuenta)', { timeout: 20000 })).click();
  await page.waitForSelector('input[placeholder^="Teléfono"]', { timeout: 20000 });
  await page.type('input[placeholder^="Teléfono"]', phone);
  await page.type('input[placeholder="Contraseña"]', 'Cielo-azul-77');
  await (await page.waitForSelector('button::-p-text(Entrar)')).click();
  const see = (text, timeout = 15000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true, () => false);
  check('entra como pasajera', await see('conductores de carro cerca', 20000));
  for (const label of ['Acepto', 'Aceptar', 'Ahora no']) {
    const b = await page.$(`button::-p-text(${label})`);
    if (b) { await b.evaluate((x) => x.click()); await wait(400); }
  }
  const openMenu = async () => { await (await page.waitForSelector('button.menu-btn')).evaluate((b) => b.click()); await wait(500); };
  await openMenu();
  const labels = await page.$$eval('.drawer-list button', (bs) => bs.map((b) => b.textContent.trim()));
  check('el menú ofrece «Quiero ser conductor» y no el cambio de modo', labels.some((l) => l.includes('Quiero ser conductor')) && !labels.some((l) => l.includes('Cambiar a modo conductor')), `(${labels})`);
  await shot(page, 'apply-menu');
  await (await page.waitForSelector('.drawer-list button::-p-text(Quiero ser conductor)')).evaluate((b) => b.click());
  check('se abre el formulario del vehículo', await see('Tu vehículo'));
  await page.type('input[aria-label="Marca"]', 'Honda');
  await page.type('input[aria-label="Modelo"]', 'Fit');
  await page.type('input[aria-label="Color"]', 'Gris');
  await page.type('input[aria-label="Año"]', '2015');
  await page.type('input[aria-label="Placa"]', `HU${rnd.slice(0, 5)}`);
  await shot(page, 'apply-form');
  await (await page.waitForSelector('button::-p-text(Enviar solicitud)')).click();
  check('al enviarla pasa a subir sus documentos', await see('Tu solicitud de conductor', 10000));
  await wait(600);
  await shot(page, 'apply-aviso');
  await (await page.waitForSelector('.mode-card button.primary')).click();
  check('ve la pantalla de documentos', await see('Licencia de conducir', 10000));
  await wait(500);
  await shot(page, 'apply-documentos');
  await pickMenu();
  async function pickMenu() {
    await openMenu();
    await (await page.waitForSelector('.drawer-list button::-p-text(Cambiar a modo pasajero)')).evaluate((b) => b.click());
  }
  check('vuelve a pasajera para pedir viajes', await see('conductores de carro cerca'));
  await wait(3500);
  await openMenu();
  const after = await page.$$eval('.drawer-list button', (bs) => bs.map((b) => b.textContent.trim()));
  check('en el menú queda «Mi solicitud de conductor»', after.some((l) => l.includes('Mi solicitud de conductor')), `(${after})`);
  await shot(page, 'apply-menu-pendiente');
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
