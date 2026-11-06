import 'dotenv/config';
// Propina en la app del conductor: al dejarla el pasajero sale la tarjeta de celebración con sonido, y queda en «Mis propinas».
// Uso: web en CLIENT_URL y API_URL (servidor de pruebas).
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
const next = (s, ev, pred = () => true, ms = 8000) => new Promise((res, rej) => { const h = (d) => { if (pred(d)) { s.off(ev, h); res(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); rej(new Error(`no llegó ${ev}`)); }, ms); });
const emitAck = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza, Tegucigalpa' };
const sockets = [];

const adm = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);
await http('PUT', 'admin/settings', SA, { tips_enabled: true, min_balance: -500 });
const D = await registerUser({ name: 'Tito Propina', phone: `9${rnd}551`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `TU${rnd.slice(0, 4)}` });
await uploadDocs(D.token);
await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
const P = await registerUser({ name: 'Lucía Fernández', phone: `8${rnd}552`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
try {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(new URL(CLIENT).origin, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.setGeolocation({ latitude: 14.0712, longitude: -87.1935, accuracy: 10 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.evaluateOnNewDocument(() => { window.__tips = []; window.addEventListener('ktracho:tip-alert', (e) => window.__tips.push(e.detail)); });
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => { localStorage.setItem('jalon', JSON.stringify(s)); localStorage.setItem('jalon-perms-later-push', String(Date.now())); localStorage.removeItem('jalon-ride-sound'); }, { token: D.token, user: D.user });
  await page.reload({ waitUntil: 'networkidle2' });
  for (const label of ['Acepto', 'Aceptar', 'Entendido']) { const b = await page.$(`button::-p-text(${label})`); if (b) { await b.evaluate((x) => x.click()); await wait(300); } }
  await (await page.waitForSelector('button.go', { timeout: 20000 })).click();
  await page.waitForSelector('.sound-toggle', { timeout: 10000 });
  await wait(600);

  // Un viaje completo: la app del conductor (esta página) recibe cada estado; se maneja desde otra conexión del mismo conductor
  const ds = await connect(D.token);
  const ps = await connect(P.token);
  sockets.push(ds, ps);
  const rideNew = next(ds, 'ride:new');
  await emitAck(ps, 'ride:request', { origin, dest, price: 100 });
  const rn = await rideNew;
  const offer = next(ps, 'offer:new');
  ds.emit('offer:make', { rideId: rn.id, price: 100 });
  const o = await offer;
  const accepted = next(ps, 'ride:state', (r) => r.status === 'accepted');
  ps.emit('offer:accept', { offerId: o.id });
  const r = await accepted;
  for (const st of ['arrived', 'started', 'completed']) {
    const moved = next(ps, 'ride:state', (x) => x.status === st);
    ds.emit('ride:status', { rideId: r.id, status: st });
    await moved;
  }
  await page.waitForFunction(() => document.body.innerText.includes('Cobrar en efectivo'), { timeout: 10000 }).catch(() => {});
  await wait(800);
  check('el conductor ve el viaje terminado', await page.evaluate(() => document.body.innerText.includes('Cobrar en efectivo')));

  // ---------- La pasajera deja propina ----------
  const tip = await http('POST', `rides/${r.id}/tip`, P.token, { amount: 25 });
  check('la pasajera deja L 25 de propina', tip.ride?.tip === 25, JSON.stringify(tip.error || ''));
  const cele = await page.waitForSelector('.tip-cele', { timeout: 8000 }).catch(() => null);
  check('al conductor le sale la tarjeta «¡Te dejaron propina!»', !!cele && (await page.$eval('.tip-cele', (e) => e.innerText)).includes('¡Te dejaron propina!'));
  const txt = cele ? await page.$eval('.tip-cele', (e) => e.innerText.replace(/\s+/g, ' ')) : '';
  check('con el monto, el nombre y cuánto cobrar en total', /L 25/.test(txt) && txt.includes('Lucía') && !txt.includes('Fernández') && /Cobra L 125/.test(txt), txt);
  const alerts = await page.evaluate(() => window.__tips);
  check('suena el «cha-ching» y vibra', alerts.length === 1 && alerts[0].sound === true, JSON.stringify(alerts));
  await wait(700);
  await shot(page, 'propina-celebracion');
  await (await page.$('.tip-cele button.primary')).click();
  await wait(300);
  check('«¡Gracias!» la cierra', !(await page.$('.tip-cele')));
  check('y abajo sigue el aviso de la propina', await page.evaluate(() => document.body.innerText.includes('de propina')));

  // ---------- Mis propinas ----------
  await (await page.waitForSelector('button.menu-btn')).evaluate((b) => b.click());
  await page.waitForSelector('.drawer', { timeout: 5000 });
  await wait(600);
  await page.waitForFunction(() => [...document.querySelectorAll('.drawer button')].some((b) => b.innerText.includes('Mis propinas') && b.innerText.includes('L 25')), { timeout: 6000 }).catch(() => {});
  const item = await page.$('.drawer button::-p-text(Mis propinas)');
  check('el menú tiene «Mis propinas» con lo del mes', !!item && (await item.evaluate((b) => b.closest('button').innerText.replace(/\s+/g, ' '))).includes('L 25.00'), item ? await item.evaluate((b) => b.closest('button').innerText.replace(/\s+/g, ' ')) : '');
  await item.evaluate((b) => b.click());
  await page.waitForSelector('.tips-sum', { timeout: 10000 });
  await wait(600);
  const sum = await page.$eval('.tips-sum', (e) => e.innerText.replace(/\s+/g, ' '));
  check('arriba: hoy, este mes y total', /Hoy L 25/.test(sum) && /Este mes L 25/.test(sum) && /Total L 25/.test(sum), sum);
  const rows = await page.$$eval('.tips-list li', (l) => l.map((x) => x.innerText.replace(/\s+/g, ' ')));
  check('el historial muestra la propina con pasajera y destino', rows.length === 1 && rows[0].includes('Lucía') && rows[0].includes('Mall Multiplaza') && rows[0].includes('L 25'), rows.join(' | '));
  await shot(page, 'propina-historial');
  await (await page.$('.overlay [role="radio"]::-p-text(Mes pasado)')).click();
  await page.waitForFunction(() => document.body.innerText.includes('Sin propinas en este período'), { timeout: 8000 }).catch(() => {});
  check('el mes pasado está vacío y lo dice', await page.evaluate(() => document.body.innerText.includes('Sin propinas en este período')));
  check('no se sale de la pantalla', !(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
  sockets.forEach((s) => s.close());
  await http('PUT', 'admin/settings', SA, { tips_enabled: before.tips_enabled !== '0', min_balance: Number(before.min_balance) });
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
