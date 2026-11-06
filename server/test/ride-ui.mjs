import 'dotenv/config';
// Pantalla para pedir viaje: conductores cerca con tiempo de llegada, tipos de viaje en tarjetas (precio y tiempo),
// medidor de precio y destinos rápidos (Casa / Trabajo según la hora). Uso: web en CLIENT_URL y API_URL.
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { io } from 'socket.io-client';
import { pool } from '../src/db.js';
import { API, http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

const CLIENT = process.env.CLIENT_URL || 'http://localhost:4000';
const SHOTS = process.env.SHOTS_DIR || '';
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}${process.env.THEME ? `-${process.env.THEME}` : ''}.png`) });
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
const HERE = { latitude: 14.0723, longitude: -87.1921, accuracy: 10 };
const sockets = [];

const adm = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const P = await registerUser({ name: 'Rita Pide', phone: `87${rnd}1`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
await http('POST', 'favorites', P.token, { label: 'Casa', text: 'Colonia Palmira, Tegucigalpa', lat: 14.0951, lng: -87.1915 });
await http('POST', 'favorites', P.token, { label: 'Trabajo', text: 'Boulevard Morazán, Tegucigalpa', lat: 14.0905, lng: -87.1880 });
// Dos conductores de carro (uno a ~700 m) y uno en moto, en línea cerca
const online = [];
for (const [i, cat, lat] of [[1, 'car', 14.0770], [2, 'car', 14.0800], [3, 'moto', 14.0740]]) {
  const D = await registerUser({ name: `Cond ${i} Pide`, phone: `9${i}${rnd}5`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `RP${i}${rnd.slice(0, 3)}` });
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  await pool.query('UPDATE vehicles SET category = ? WHERE driver_id = ?', [cat, D.user.id]);
  const s = await connect(D.token);
  sockets.push(s);
  s.emit('driver:online', { lat, lng: -87.1921 });
  online.push(D);
}
await wait(800);

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
const text = (page, sel) => page.$eval(sel, (e) => e.innerText).catch(() => '');
try {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(new URL(CLIENT).origin, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.setGeolocation(HERE);
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  // Fija la hora a las 6 de la tarde: debe sugerir «¿Casa?» primero
  await page.evaluateOnNewDocument(() => { const H = Date.prototype.getHours; Date.prototype.getHours = function () { return this.getTime() > 0 ? 18 : H.call(this); }; });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => { localStorage.setItem('jalon', JSON.stringify(s)); localStorage.setItem('jalon-perms-later-push', String(Date.now())); }, { token: P.token, user: P.user });
  await page.reload({ waitUntil: 'networkidle2' });
  for (const label of ['Acepto', 'Aceptar']) { const b = await page.$(`button::-p-text(${label})`); if (b) { await b.evaluate((x) => x.click()); await wait(300); } }

  // ---------- Antes de elegir destino ----------
  await page.waitForFunction(() => /2 conductores de carro cerca/.test(document.querySelector('.nearby-line')?.innerText || ''), { timeout: 20000 }).catch(() => {});
  const line = await text(page, '.nearby-line');
  check('dice cuántos conductores hay cerca y en cuánto llega el primero', /2 conductores de carro cerca/.test(line) && /el primero llega en \d+ min/.test(line), line);
  const cards = await page.$$eval('.cat-cards [role="radio"]', (b) => b.map((x) => x.innerText.replace(/\s+/g, ' ').trim()));
  check('los tipos de viaje salen en tarjetas con su tiempo', cards.length === 3 && /Moto.*\d+ min/.test(cards[0]) && /Carro.*\d+ min/.test(cards[1]) && /Carro amplio.*Sin conductores/.test(cards[2]), cards.join(' | '));
  const chips = await page.$$eval('.quick-places button', (b) => b.map((x) => x.textContent.trim()));
  check('a las 6 de la tarde sugiere primero «¿Casa?»', /^🏠 ¿Casa\?/.test(chips[0] || '') && chips.some((c) => c.includes('Trabajo')), chips.join(' | '));
  check('la búsqueda pregunta «¿A dónde vamos hoy?»', !!(await page.$('input[placeholder^="¿A dónde vamos hoy?"]')));
  await wait(500);
  await shot(page, 'pedir-inicio');

  await (await page.$('.cat-cards [role="radio"]:nth-child(1)')).click();
  await wait(300);
  check('al elegir moto, la línea habla de motos', /1 conductor de moto cerca/.test(await text(page, '.nearby-line')), await text(page, '.nearby-line'));
  await (await page.$('.cat-cards [role="radio"]:nth-child(2)')).click();

  // ---------- Con destino: precio en cada tarjeta y el medidor ----------
  await (await page.$('.quick-places button.suggested')).click();
  await page.waitForSelector('.price-meter', { timeout: 30000 });
  await wait(400);
  const priced = await page.$$eval('.cat-cards [role="radio"]', (b) => b.map((x) => x.innerText));
  check('con destino, cada tarjeta muestra su precio', priced.every((t) => /L\s?\d+/.test(t)), priced.join(' | ').replace(/\s+/g, ' '));
  check('con el precio sugerido dice «Precio justo»', (await text(page, '.price-meter .pm-title')) === 'Precio justo', await text(page, '.price-meter .pm-title'));
  check('muestra el precio sugerido', /Sugerido L/.test(await text(page, '.price-meter')));
  await shot(page, 'pedir-justo');
  const up = await page.$('button[aria-label="Subir 5 lempiras"]');
  for (let i = 0; i < 8; i++) await up.click();
  await wait(400);
  check('si sube el precio dice «Te aceptan rápido»', (await text(page, '.price-meter .pm-title')) === 'Te aceptan rápido', await text(page, '.price-meter .pm-title'));
  await shot(page, 'pedir-rapido');
  const down = await page.$('button[aria-label="Bajar 5 lempiras"]');
  for (let i = 0; i < 16; i++) await down.click();
  await wait(400);
  check('si lo baja mucho dice «Puede tardar»', (await text(page, '.price-meter .pm-title')) === 'Puede tardar', await text(page, '.price-meter .pm-title'));
  await shot(page, 'pedir-tarda');
  await (await page.$('.cat-cards [role="radio"]:nth-child(3)')).evaluate((b) => { b.scrollIntoView({ block: 'center' }); b.click(); });
  await wait(400);
  check('en un tipo sin conductores lo avisa', (await text(page, '.price-meter .pm-title')) === 'Sin conductores cerca', await text(page, '.price-meter .pm-title'));
  check('el botón de pedir sigue a la vista', !!(await page.$('.ask-bar button.primary')));
  check('no se sale de la pantalla', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
  sockets.forEach((s) => s.close());
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
