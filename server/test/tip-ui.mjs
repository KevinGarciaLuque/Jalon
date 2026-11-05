import 'dotenv/config';
// Propinas en la pantalla: al terminar, el pasajero elige la propina y el conductor la ve al instante.
// Uso: web en CLIENT_URL y API_URL (servidor de pruebas)
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

const adm = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);
await http('PUT', 'admin/settings', SA, { tips_enabled: true });
const P = await registerUser({ name: 'Paola UI', phone: `87${rnd}1`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
const D = await registerUser({ name: 'Carlos UI', phone: `97${rnd}2`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HU${rnd.slice(0, 4)}` });
await uploadDocs(D.token);
await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
const sockets = [];
async function open(session) {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(CLIENT, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  await page.setGeolocation({ latitude: 14.0723, longitude: -87.1921, accuracy: 5 });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => localStorage.setItem('jalon', JSON.stringify(s)), session);
  await page.reload({ waitUntil: 'networkidle2' });
  for (const label of ['Acepto', 'Aceptar', 'Ahora no']) {
    const b = await page.$(`button::-p-text(${label})`);
    if (b) { await b.evaluate((x) => x.click()); await wait(300); }
  }
  return page;
}
const see = (page, text, timeout = 15000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true, () => false);
const wide = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);

try {
  const pp = await open({ token: P.token, user: P.user });
  const pd = await open({ token: D.token, user: D.user });
  await wait(1500);
  // El viaje se hace por sockets aparte (mismas cuentas): las pantallas reciben todo por su propia conexión
  const ps = await connect(P.token); sockets.push(ps);
  const ds = await connect(D.token); sockets.push(ds);
  ds.emit('driver:online', { lat: 14.0712, lng: -87.1935 });
  await wait(500);
  const rideNew = next(ds, 'ride:new');
  const ack = await emitAck(ps, 'ride:request', { origin: { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' }, dest: { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza' }, price: 100 });
  if (!ack?.ok) throw new Error(`no se pudo pedir: ${ack?.error}`);
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

  check('al llegar, el pasajero ve la propina', await see(pp, '¿Le dejas propina a Carlos UI?'));
  check('con montos rápidos', !!(await pp.$('.tip-box button::-p-text(L 20)')) && !!(await pp.$('.tip-box button::-p-text(Otra)')));
  await (await pp.$('.tip-box button::-p-text(L 20)')).evaluate((b) => b.scrollIntoView({ block: 'center' }));
  await (await pp.$('.tip-box button::-p-text(L 20)')).click();
  check('al elegir, el botón dice el nuevo total', await see(pp, 'Dar L 20 de propina · total L 120'));
  await wait(300);
  await shot(pp, 'propina-elegir');
  check('la pantalla no se sale', !(await wide(pp)));
  await (await pp.$('.tip-box button.primary')).click();
  check('queda anotada con el total', (await see(pp, 'Le dejaste L 20 de propina')) && (await see(pp, 'L 120')));
  check('y ya no se ofrece otra vez', !(await pp.$('.tip-box')));
  await (await pp.$('.tip-done')).evaluate((b) => b.scrollIntoView({ block: 'center' }));
  await wait(300);
  await shot(pp, 'propina-pasajero');

  check('el conductor la ve al instante', await see(pd, 'Te dejó L 20 de propina'));
  check('y cobra el total con la propina', await see(pd, 'Cobrar en efectivo: L 120'));
  await shot(pd, 'propina-conductor');
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  sockets.forEach((s) => s.close());
  await browser.close();
  await http('PUT', 'admin/settings', SA, { tips_enabled: before.tips_enabled !== '0' });
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
