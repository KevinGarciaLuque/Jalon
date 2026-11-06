import 'dotenv/config';
// Viajes entre ciudades en la app: el conductor ve el viaje publicado en su tablero y acepta la tarifa;
// el pasajero ve la oferta en «Mis viajes» y la elige; el viaje queda reservado para los dos.
// Uso: web en CLIENT_URL y API_URL (servidor de pruebas).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

const CLIENT = process.env.CLIENT_URL || 'http://localhost:4000';
const SHOTS = process.env.SHOTS_DIR || '';
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}${process.env.THEME ? `-${process.env.THEME}` : ''}.png`) });
const tegus = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy, Tegucigalpa' };
const comayagua = { lat: 14.4514, lng: -87.6375, text: 'Comayagua, Comayagua' };

const adm = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);
await http('PUT', 'admin/settings', SA, { intercity_enabled: true, min_balance: -500 });
const D = await registerUser({ name: 'Rolando Carretera', phone: `9${rnd}81`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Hilux', plate: `IU${rnd.slice(0, 4)}` });
await uploadDocs(D.token);
await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
const P = await registerUser({ name: 'Karla Mejía', phone: `8${rnd}82`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
const tomorrow6 = new Date(Date.now() + 864e5);
tomorrow6.setHours(6, 0, 0, 0);
const pub = await http('POST', 'intercity', P.token, { origin: tegus, dest: comayagua, departAt: tomorrow6.toISOString(), seats: 2, luggage: true, price: 900, note: 'Frente a la pulpería' });

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
async function open(sess, at) {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(new URL(CLIENT).origin, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.setGeolocation({ ...at, accuracy: 10 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('dialog', (d) => d.accept());
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => { localStorage.setItem('jalon', JSON.stringify(s)); localStorage.setItem('jalon-perms-later-push', String(Date.now())); localStorage.setItem('jalon-perms-later-geo', String(Date.now())); }, sess);
  await page.reload({ waitUntil: 'networkidle2' });
  for (const label of ['Acepto', 'Aceptar', 'Entendido']) { const b = await page.$(`button::-p-text(${label})`); if (b) { await b.evaluate((x) => x.click()); await wait(300); } }
  return page;
}
const text = (page, sel) => page.$eval(sel, (e) => e.innerText.replace(/\s+/g, ' ')).catch(() => '');

try {
  // ---------- Conductor: desde el menú, el tablero ----------
  const dp = await open({ token: D.token, user: D.user }, { latitude: 14.0712, longitude: -87.1935 });
  check('el conductor ve el acceso a «Viajes entre ciudades»', !!(await page$(dp, '.ic-entry')));
  await (await dp.waitForSelector('button.menu-btn', { timeout: 15000 })).evaluate((b) => b.click());
  await dp.waitForSelector('.drawer', { timeout: 5000 });
  await wait(500);
  const item = await dp.$('.drawer button ::-p-text(Viajes entre ciudades)');
  check('y en el menú', !!item);
  await item.evaluate((b) => b.closest('button').click());
  await dp.waitForSelector('.ic-panel .ic-card', { timeout: 10000 });
  await wait(700);
  const card = await text(dp, '.ic-panel .ic-card');
  check('la tarjeta muestra precio, personas, maletas, salida y la ruta', /L 900 para 2 pasajeros/.test(card) && card.includes('Con maletas') && card.includes('Mañana') && card.includes('Comayagua') && card.includes('Karla') && !card.includes('Mejía'), card);
  await shot(dp, 'ic-tablero');
  await (await dp.$('.ic-panel button.ic-accept')).click();
  await dp.waitForSelector('.ic-myoffer', { timeout: 8000 }).catch(() => null);
  check('«Aceptar tarifa» envía la oferta y queda esperando al pasajero', (await text(dp, '.ic-myoffer')).includes('Tu oferta: L 900'));

  // ---------- Pasajero: la oferta y elegirla ----------
  const pp = await open({ token: P.token, user: P.user }, { latitude: 14.0723, longitude: -87.1921 });
  await pp.waitForSelector('.trip-kind', { timeout: 15000 });
  const entry = await text(pp, '.ic-entry');
  check('el pasajero ve «En la ciudad / Entre ciudades» y el aviso de su viaje con oferta', entry.includes('Tus viajes entre ciudades (1)') && entry.includes('1 oferta para elegir'), entry);
  await shot(pp, 'ic-pasajero-inicio');
  await (await pp.$('.trip-kind button:nth-child(2)')).click();
  await pp.waitForSelector('.ic-panel .ic-offers li', { timeout: 10000 });
  await wait(600);
  const offer = await text(pp, '.ic-offers li');
  check('en «Mis viajes» está la oferta del conductor con su hora', offer.includes('Rolando Carretera') && offer.includes('L 900') && offer.includes('Mañana'), offer);
  await shot(pp, 'ic-ofertas');
  await (await pp.$('.ic-offers button.primary')).click();
  await pp.waitForFunction(() => document.querySelector('.ic-card .pill')?.innerText.includes('Reservado'), { timeout: 8000 }).catch(() => {});
  const booked = await text(pp, '.ic-card');
  check('al elegirla queda reservado con el conductor', booked.includes('Reservado') && booked.includes('Rolando Carretera'), booked);
  await shot(pp, 'ic-reservado');

  // El formulario de un viaje nuevo
  await (await pp.$('.ic-panel [role="tab"]')).click();
  await pp.waitForSelector('.ic-form', { timeout: 5000 });
  await wait(400);
  check('el formulario pide salida, personas y maletas', !!(await pp.$('.ic-form input[type="datetime-local"]')) && (await text(pp, '.ic-form')).includes('¿Cuántos viajan?'));
  await shot(pp, 'ic-nuevo');

  // ---------- Conductor: su reserva ----------
  await dp.waitForFunction(() => [...document.querySelectorAll('.ic-panel [role="tab"]')].some((b) => b.innerText.includes('Mis reservas (1)')), { timeout: 8000 }).catch(() => {});
  await (await dp.$('.ic-panel [role="tab"]:nth-child(2)')).click();
  await wait(500);
  const mine = await text(dp, '.ic-panel .ic-card');
  check('el conductor la ve en «Mis reservas» (se actualizó sola)', mine.includes('Reservado') && mine.includes('Karla'), mine);
  await shot(dp, 'ic-reservas');
  check('no se sale de la pantalla', !(await dp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)) && !(await pp.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
  await pool.query("UPDATE rides SET status = 'cancelled' WHERE id = ? AND status IN ('board','booked')", [pub.id]);
  await http('PUT', 'admin/settings', SA, { intercity_enabled: before.intercity_enabled === '1', min_balance: Number(before.min_balance) });
}
async function page$(page, sel) { return page.waitForSelector(sel, { timeout: 15000 }).catch(() => null); }
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
