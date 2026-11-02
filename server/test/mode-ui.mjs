import 'dotenv/config';
// Modo pasajero en la pantalla: el conductor cambia desde el menú y la app muestra la otra pantalla. Uso: web en CLIENT_URL y API_URL
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

const phone = `9${rnd}8`.slice(0, 8);
const D = await registerUser({ name: 'UI Conductor', phone, password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HU${rnd.slice(0, 5)}` });
await pool.query("UPDATE users SET status = 'active' WHERE id = ?", [D.user.id]);
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(CLIENT, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.setGeolocation({ latitude: 14.0723, longitude: -87.1921, accuracy: 5 });
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  // Entra por la pantalla normal, con cookie de sesión como cualquier usuario
  await page.waitForSelector('input[placeholder^="Teléfono"]', { timeout: 20000 });
  await page.type('input[placeholder^="Teléfono"]', phone);
  await page.type('input[placeholder="Contraseña"]', 'Cielo-azul-77');
  await (await page.waitForSelector('button::-p-text(Entrar)')).click();
  const see = (text, timeout = 15000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true, () => false);
  const dismiss = async () => {
    for (const label of ['Acepto', 'Aceptar', 'Ahora no']) {
      const b = await page.$(`button::-p-text(${label})`);
      if (b) { await b.evaluate((x) => x.click()); await wait(400); }
    }
  };
  check('entra como conductor', await see('Ponerme disponible', 20000));
  await dismiss();
  const pickMenu = async (label) => {
    await (await page.waitForSelector('button.menu-btn')).evaluate((b) => b.click());
    await wait(500);
    const item = await page.waitForSelector(`.drawer-list button::-p-text(${label})`, { timeout: 8000 });
    await shot(page, 'modo-menu');
    await item.evaluate((b) => b.click());
  };
  await pickMenu('Cambiar a modo pasajero');
  check('al cambiar ve la pantalla de pasajero', await see('conductores de carro cerca'));
  await wait(1500);
  await shot(page, 'modo-pasajero');
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('al recargar sigue en modo pasajero', await see('conductores de carro cerca'));
  await wait(800);
  await pickMenu('Cambiar a modo conductor');
  check('al volver ve la pantalla de conductor', await see('Ponerme disponible'));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
