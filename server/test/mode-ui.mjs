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
  await page.setViewport({ width: Number(process.env.VIEW_W) || 390, height: Number(process.env.VIEW_H) || 844 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  await page.setGeolocation({ latitude: 14.0723, longitude: -87.1921, accuracy: 5 });
  // Para simular un GPS lento (como en un celular): con window.__slowGps la primera respuesta tarda 6 s
  await page.evaluateOnNewDocument(() => {
    const geo = navigator.geolocation;
    const watch = geo.watchPosition.bind(geo);
    geo.watchPosition = (ok, ...rest) => {
      const t0 = Date.now();
      const slow = window.__slowGps;
      return watch((p) => { if (!slow) return ok(p); setTimeout(() => ok(p), Math.max(0, 6000 - (Date.now() - t0))); }, ...rest);
    };
  });
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
  check('un aviso confirma el modo pasajero', await see('Modo pasajero activado', 5000));
  await wait(600);
  await shot(page, 'modo-aviso-pasajero');
  check('el aviso se cierra solo', await page.waitForFunction(() => !document.querySelector('.mode-notice'), { timeout: 5000 }).then(() => true, () => false));
  await wait(500);
  await shot(page, 'modo-pasajero');
  await page.reload({ waitUntil: 'domcontentloaded' });
  check('al recargar sigue en modo pasajero', await see('conductores de carro cerca'));
  check('al recargar no repite el aviso', !(await page.$('.mode-notice')));
  await wait(800);
  const gone = (sel, timeout) => page.waitForFunction((s) => !document.querySelector(s), { timeout }, sel).then(() => true, () => false);
  await page.evaluate(() => { window.__slowGps = true; });
  const switchedAt = Date.now();
  await pickMenu('Cambiar a modo conductor');
  check('al volver ve la pantalla de conductor', await see('Ponerme disponible'));
  // Aunque el GPS tarde en responder, el mapa y su carro aparecen al instante (con la última posición conocida)
  const mapReady = await page.waitForFunction(() => !!document.querySelector('.leaflet-marker-icon.car.mine'), { timeout: 5000 }).then(() => Date.now() - switchedAt, () => null);
  check('con el GPS lento, el mapa y su carro aparecen enseguida', mapReady !== null && mapReady < 2500, `(${mapReady} ms)`);
  // Modo conductor: el carro sale del aviso y aterriza en el mapa
  check('empieza la animación del carro', await page.waitForSelector('.drive-in', { timeout: 5000 }).then(() => true, () => false));
  check('el aviso de la animación dice el modo y su carro', await see('Modo conductor activado', 2000) && await see('Yaris', 2000));
  await (await page.waitForSelector('.drive-in-mute')).click();
  check('el botón de sonido lo silencia (y no salta la animación)', (await page.evaluate(() => localStorage.getItem('ktracho:sfx'))) === 'off' && !!(await page.$('.drive-in')));
  await wait(400);
  await shot(page, 'modo-animacion');
  check('la animación termina sola', await gone('.drive-in', 5000));
  check('el carro del mapa queda visible', await page.$eval('.leaflet-marker-icon.car', (m) => !m.classList.contains('drive-in-hide')).catch(() => false));
  check('no sale además el aviso normal', !(await page.$('.mode-notice')));

  // Con «reducir movimiento» en el teléfono: solo el aviso de siempre
  await pickMenu('Cambiar a modo pasajero');
  await see('Modo pasajero activado', 5000);
  await gone('.mode-notice', 5000);
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]);
  await pickMenu('Cambiar a modo conductor');
  check('con movimiento reducido no hay animación', await see('Modo conductor activado', 5000) && !(await page.$('.drive-in')));
  await shot(page, 'modo-aviso-conductor');
  await (await page.waitForSelector('.mode-card button.primary')).click();
  check('«Entendido» lo cierra', await gone('.mode-notice', 1500));
  await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'no-preference' }]);

  // Si la animación no se puede descargar: el aviso de siempre y la app sigue
  await pickMenu('Cambiar a modo pasajero');
  await see('Modo pasajero activado', 5000);
  await gone('.mode-notice', 5000);
  await page.setBypassServiceWorker(true); // si no, la app instalada la saca de su copia guardada
  await page.setRequestInterception(true);
  page.on('request', (r) => (r.url().includes('/driveIn-') ? r.abort() : r.continue()));
  await page.reload({ waitUntil: 'domcontentloaded' }); // la animación ya estaba descargada: se empieza de cero
  await see('conductores de carro cerca');
  await wait(800);
  await pickMenu('Cambiar a modo conductor');
  check('si la animación falla sale el aviso normal', await page.waitForSelector('.mode-notice', { timeout: 5000 }).then(() => true, () => false) && !(await page.$('.drive-in')));
  check('y la pantalla de conductor funciona', await see('Ponerme disponible'));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
