import 'dotenv/config';
// Sin GPS, la app no usa el centro de Tegucigalpa (la «ubicación de reserva» del mapa) como si fuera donde está la persona:
// el pasajero no puede pedir con «Mi ubicación» y el conductor no puede ponerse disponible hasta tener su ubicación real.
// Con una ubicación aproximada (más de 1 km de error) se le avisa al pasajero.
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

const adm = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const P = await registerUser({ name: 'Gina Sinseñal', phone: `8${rnd}91`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
const D = await registerUser({ name: 'Tomás Sinseñal', phone: `9${rnd}92`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `GE${rnd.slice(0, 4)}` });
await uploadDocs(D.token);
await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
// geo: null = permiso negado; si no, { latitude, longitude, accuracy }
async function open(sess, geo) {
  const ctx = await browser.createBrowserContext();
  if (geo) await ctx.overridePermissions(new URL(CLIENT).origin, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  if (geo) await page.setGeolocation(geo);
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => { localStorage.setItem('jalon', JSON.stringify(s)); localStorage.setItem('jalon-perms-later-push', String(Date.now())); localStorage.setItem('jalon-perms-later-geo', String(Date.now())); }, sess);
  await page.reload({ waitUntil: 'networkidle2' });
  for (const label of ['Acepto', 'Aceptar', 'Entendido']) { const b = await page.$(`button::-p-text(${label})`); if (b) { await b.evaluate((x) => x.click()); await wait(300); } }
  return page;
}
const has = (page, t, timeout = 10000) => page.waitForFunction((x) => document.body.innerText.includes(x), { timeout }, t).then(() => true, () => false);

try {
  // ---------- Pasajero sin GPS ----------
  const p1 = await open({ token: P.token, user: P.user }, null);
  check('sin GPS, el pasajero ve «No sabemos dónde estás»', await has(p1, 'No sabemos dónde estás'));
  const originVal = await p1.$eval('input[placeholder="¿Dónde te recogemos?"]', (i) => i.value).catch(() => 'x');
  check('y el punto de recogida queda vacío (no dice «Mi ubicación»)', originVal === '', originVal);
  check('el pin del mapa se puede arrastrar', await p1.$eval('.leaflet-marker-draggable', () => true).catch(() => false));
  await wait(400);
  await shot(p1, 'geo-pasajero-sin-gps');
  // «Cómo activar mi ubicación» abre la pantalla guiada
  await (await p1.$('.hint button.link')).click();
  check('«Cómo activar mi ubicación» abre la pantalla guiada', !!(await p1.waitForSelector('.geo-help', { timeout: 5000 }).catch(() => null)));
  check('con pasos numerados y «Ya la activé, volver a intentar»', (await p1.$$('.geo-steps li')).length >= 2 && (await p1.$eval('.geo-help button.geo-go', (b) => b.innerText).catch(() => '')).includes('Ya la activé'));
  await wait(400);
  await shot(p1, 'geo-ayuda');
  await (await p1.$('.geo-help button.geo-go')).click();
  check('si sigue bloqueada, lo dice', !!(await p1.waitForSelector('.geo-help .hint.danger', { timeout: 20000 }).catch(() => null)));

  // En iPhone salen los pasos de Ajustes → Localización
  const ctxI = await browser.createBrowserContext();
  const pi = await ctxI.newPage();
  await pi.setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1');
  await pi.setViewport({ width: 390, height: 844 });
  if (process.env.THEME) await pi.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  pi.on('pageerror', (e) => errors.push(e.message));
  await pi.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await pi.evaluate((s) => { localStorage.setItem('jalon', JSON.stringify(s)); localStorage.setItem('jalon-perms-later-push', String(Date.now())); }, { token: P.token, user: P.user });
  await pi.reload({ waitUntil: 'networkidle2' });
  for (const label of ['Acepto', 'Aceptar', 'Entendido']) { const b = await pi.$(`button::-p-text(${label})`); if (b) { await b.evaluate((x) => x.click()); await wait(300); } }
  await pi.waitForSelector('.perms-geo', { timeout: 15000 }).catch(() => null);
  const barBtn = await pi.$('.perms-bar button.primary');
  if (barBtn && !(await pi.$('.geo-help'))) await barBtn.click();
  await pi.waitForSelector('.geo-help', { timeout: 20000 }).catch(() => null);
  const ios = await pi.$eval('.geo-help', (e) => e.innerText).catch(() => '');
  check('en iPhone los pasos son de Ajustes → Localización y Safari', ios.includes('Localización') && ios.includes('Sitios web de Safari') && ios.includes('Ubicación exacta'), ios.slice(0, 200));
  await wait(400);
  await shot(pi, 'geo-ayuda-iphone');

  // ---------- Pasajero con ubicación aproximada (iPhone sin «Ubicación exacta») ----------
  const p2 = await open({ token: P.token, user: P.user }, { latitude: 14.0400, longitude: -87.2200, accuracy: 3000 });
  check('con una ubicación de ±3 km se le avisa que es aproximada', await has(p2, 'Tu ubicación es aproximada (±3.0 km)'));
  check('y sí puede pedir con «Mi ubicación»', (await p2.$eval('input[placeholder="¿Dónde te recogemos?"]', (i) => i.value).catch(() => '')) === 'Mi ubicación');
  await shot(p2, 'geo-pasajero-aproximada');

  // ---------- Pasajero con GPS bueno ----------
  const p3 = await open({ token: P.token, user: P.user }, { latitude: 14.0400, longitude: -87.2200, accuracy: 15 });
  await p3.waitForSelector('input[placeholder="¿Dónde te recogemos?"]', { timeout: 15000 });
  await wait(1200);
  const txt = await p3.evaluate(() => document.body.innerText);
  check('con buen GPS no sale ningún aviso de ubicación', !txt.includes('No sabemos dónde estás') && !txt.includes('aproximada'));

  // ---------- Conductor sin GPS ----------
  const d1 = await open({ token: D.token, user: D.user }, null);
  check('sin GPS, el conductor ve «No tenemos tu ubicación»', await has(d1, 'No tenemos tu ubicación'));
  const go = await d1.waitForSelector('button.go', { timeout: 15000 }).catch(() => null);
  check('y «Ponerme disponible» está desactivado', !!go && (await go.evaluate((b) => b.disabled)));
  await shot(d1, 'geo-conductor-sin-gps');

  // ---------- Conductor con GPS ----------
  const d2 = await open({ token: D.token, user: D.user }, { latitude: 14.0712, longitude: -87.1935, accuracy: 10 });
  const go2 = await d2.waitForSelector('button.go:not([disabled])', { timeout: 15000 }).catch(() => null);
  check('con GPS el conductor sí se puede poner disponible', !!go2);
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
