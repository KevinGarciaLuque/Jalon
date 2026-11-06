import 'dotenv/config';
// Modo de prueba del superadmin en la app: desde el avatar elige Panel, Pasajero o Conductor y vuelve al panel.
// Uso: web en CLIENT_URL y API_URL (servidor de pruebas).
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
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}${process.env.THEME ? `-${process.env.THEME}` : ''}.png`) });

const adm = await createTestSuperadmin(pool);
await pool.query('UPDATE users SET staff_mode = NULL WHERE id = ?', [adm.id]);
await pool.query('DELETE FROM vehicles WHERE driver_id = ?', [adm.id]);
const SA = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
const visible = (page, t) => page.evaluate((x) => document.body.innerText.includes(x), t);
const see = (page, t, timeout = 15000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t).then(() => true, () => false);
async function avatarMode(page, label) {
  await (await page.waitForSelector('button.avatar-btn', { timeout: 20000 })).evaluate((b) => b.click());
  await page.waitForSelector('.profile-pop .staff-modes', { timeout: 5000 });
  await wait(300);
  await (await page.$(`.staff-modes [role="menuitemradio"]::-p-text(${label})`)).click();
}
const closeNotice = async (page) => { const b = await page.waitForSelector('.mode-notice button', { timeout: 6000 }).catch(() => null); if (b) { await b.evaluate((x) => x.click()); await wait(300); } };

try {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(new URL(CLIENT).origin, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.setGeolocation({ latitude: 14.0723, longitude: -87.1921, accuracy: 10 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => { errors.push(`alerta: ${d.message()}`); d.dismiss(); });
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => localStorage.setItem('jalon', JSON.stringify(s)), { token: SA, user: { ...adm, role: 'superadmin', status: 'active' } });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('nav.sidebar, button.menu-btn', { timeout: 20000 });

  // ---------- Desde el avatar: las 3 opciones ----------
  await (await page.waitForSelector('button.avatar-btn')).evaluate((b) => b.click());
  await page.waitForSelector('.profile-pop .staff-modes', { timeout: 8000 }).catch(() => null);
  const opts = await page.$$eval('.staff-modes [role="menuitemradio"]', (b) => b.map((x) => `${x.textContent}${x.getAttribute('aria-checked') === 'true' ? '*' : ''}`)).catch(() => []);
  check('el avatar ofrece usar la app como Panel, Pasajero o Conductor', opts.join(',') === 'Panel*,Pasajero,Conductor', opts.join(','));
  await wait(300);
  await shot(page, 'modo-avatar');
  await page.keyboard.press('Escape');
  await wait(300);

  // ---------- Pasajero ----------
  await avatarMode(page, 'Pasajero');
  await closeNotice(page);
  check('en modo pasajero sale la barra de prueba', await see(page, 'Modo de prueba: pasajero'));
  check('y la pantalla del pasajero', !!(await page.waitForSelector('input[placeholder^="¿A dónde vas?"]', { timeout: 15000 }).catch(() => null)));
  check('sin el panel', !(await page.$('nav.sidebar')) && !(await visible(page, 'Indicadores')));
  await wait(600);
  await shot(page, 'modo-pasajero');

  // ---------- Conductor: la primera vez pide el vehículo ----------
  await avatarMode(page, 'Conductor');
  check('para manejar pide el vehículo de prueba', await see(page, 'Tu vehículo de prueba'));
  await page.type('input[aria-label="Modelo"]', 'Yaris');
  await page.type('input[aria-label="Placa"]', `SU${rnd.slice(0, 4)}`);
  await shot(page, 'modo-vehiculo');
  await (await page.$('button::-p-text(Guardar y entrar como conductor)')).click();
  await closeNotice(page);
  check('entra como conductor', await see(page, 'Modo de prueba: conductor'));
  check('con la pantalla del conductor', (await see(page, 'Ponerme disponible', 8000)) || (await see(page, 'disponible', 4000)));
  await wait(600);
  await shot(page, 'modo-conductor');

  // ---------- Volver al panel ----------
  await (await page.$('.test-mode-bar button')).click();
  const gone = await page.waitForSelector('.test-mode-bar', { hidden: true, timeout: 15000 }).then(() => true, () => false);
  const panel = !!(await page.waitForSelector('nav.sidebar, button.menu-btn', { timeout: 15000 }).catch(() => null));
  await wait(600);
  await shot(page, 'modo-panel');
  check('«Volver al panel» regresa al panel', gone && panel, JSON.stringify({ gone, panel }));
  await wait(800);
  check('sin la pantalla de pasajero ni de conductor', !(await page.$('.screen .map')));
  const [[row]] = await pool.query('SELECT staff_mode FROM users WHERE id = ?', [adm.id]);
  check('quedó en el panel en la base de datos', row.staff_mode === null);
  check('sin errores de JavaScript ni alertas', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
  await pool.query('UPDATE users SET staff_mode = NULL WHERE id = ?', [adm.id]);
  await pool.query('DELETE FROM vehicles WHERE driver_id = ?', [adm.id]);
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
