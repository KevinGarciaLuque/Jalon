import 'dotenv/config';
// Aviso al conductor: con la app abierta, cada solicitud nueva suena y vibra; se puede silenciar.
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
const emitAck = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const origin = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
const dest = { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza' };

const adm = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const D = await registerUser({ name: 'Dani Suena', phone: `9${rnd}771`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `RA${rnd.slice(0, 4)}` });
await uploadDocs(D.token);
await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
const passengers = [];
for (const i of [1, 2, 3]) passengers.push(await registerUser({ name: `Pasa ${i} Suena`, phone: `8${i}${rnd}7`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' }));
const sockets = [];
const asked = []; // [socket, rideId] para cancelarlos al final

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
try {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(new URL(CLIENT).origin, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: Number(process.env.VIEW_H) || 844 });
  await page.setGeolocation({ latitude: 14.0712, longitude: -87.1935, accuracy: 10 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  page.on('pageerror', (e) => errors.push(e.message));
  // Se anotan los avisos que da la app
  await page.evaluateOnNewDocument(() => { window.__alerts = []; window.addEventListener('ktracho:ride-alert', (e) => window.__alerts.push(e.detail)); });
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => { localStorage.setItem('jalon', JSON.stringify(s)); localStorage.setItem('jalon-perms-later-push', String(Date.now())); localStorage.removeItem('jalon-ride-sound'); }, { token: D.token, user: D.user });
  await page.reload({ waitUntil: 'networkidle2' });
  for (const label of ['Acepto', 'Aceptar', 'Entendido']) { const b = await page.$(`button::-p-text(${label})`); if (b) { await b.evaluate((x) => x.click()); await wait(300); } }
  await (await page.waitForSelector('button.go', { timeout: 20000 })).click();
  await page.waitForSelector('.sound-toggle', { timeout: 10000 });
  await wait(800);
  check('al ponerse disponible el sonido está activado', (await page.$eval('.sound-toggle input', (i) => i.checked)) === true);

  // ---------- Llega una solicitud: suena ----------
  const p1 = await connect(passengers[0].token);
  p1.uid = passengers[0].user.id;
  sockets.push(p1);
  const r1 = await emitAck(p1, 'ride:request', { origin, dest, price: 90 });
  asked.push([p1, p1.uid]);
  check('el pasajero pide un viaje', !!r1?.ok, JSON.stringify(r1));
  await page.waitForFunction(() => window.__alerts.length > 0, { timeout: 8000 }).catch(() => {});
  const a1 = await page.evaluate(() => window.__alerts);
  check('al llegar la solicitud el conductor oye el aviso', a1.length === 1 && a1[0].sound === true, JSON.stringify(a1));
  check('y la ve en la lista', await page.evaluate(() => document.body.innerText.includes('Solicitudes cercanas (1)')));
  await shot(page, 'aviso-solicitud');
  // «Aceptar» debe verse sin bajar en la hoja (también en celulares bajitos)
  await wait(600);
  const acc = await page.evaluate(() => {
    const b = [...document.querySelectorAll('.sheet button')].find((x) => /^Aceptar/.test(x.textContent.trim()));
    const sh = document.querySelector('.sheet').getBoundingClientRect();
    const r = b?.getBoundingClientRect();
    return r ? { top: Math.round(r.top), bottom: Math.round(r.bottom), sheetTop: Math.round(sh.top), sheetBottom: Math.round(sh.bottom), vh: innerHeight } : null;
  });
  check('«Aceptar» se ve sin bajar', !!acc && acc.bottom <= Math.min(acc.sheetBottom, acc.vh) && acc.top >= acc.sheetTop, JSON.stringify(acc));
  // También con la barra amarilla del modo de prueba del superadmin (le quita alto a la pantalla)
  const withBar = await page.evaluate(async () => {
    const bar = document.createElement('div');
    bar.className = 'test-mode-bar';
    bar.innerHTML = '<span><b>🧪 Modo de prueba: conductor.</b> Los viajes son reales.</span><button class="sm">Volver al panel</button>';
    document.querySelector('.app').insertBefore(bar, document.querySelector('.app > header').nextSibling);
    await new Promise((r) => setTimeout(r, 700));
    const b = [...document.querySelectorAll('.sheet button')].find((x) => /^Aceptar/.test(x.textContent.trim()));
    const sh = document.querySelector('.sheet').getBoundingClientRect();
    const r = b.getBoundingClientRect();
    await window.__shotHook?.();
    const out = { top: Math.round(r.top), bottom: Math.round(r.bottom), sheetTop: Math.round(sh.top), sheetBottom: Math.round(sh.bottom), vh: innerHeight };
    bar.remove();
    return out;
  });
  check('y también con la barra del modo de prueba', withBar.bottom <= Math.min(withBar.sheetBottom, withBar.vh) && withBar.top >= withBar.sheetTop, JSON.stringify(withBar));

  // ---------- Silenciar ----------
  await page.evaluate(() => { window.__alerts = []; });
  await (await page.$('.sound-toggle')).click();
  await wait(300);
  check('se puede silenciar', (await page.$eval('.sound-toggle', (b) => b.textContent)).includes('Silencio'));
  await wait(1600);
  const p2 = await connect(passengers[1].token);
  p2.uid = passengers[1].user.id;
  sockets.push(p2);
  const r2 = await emitAck(p2, 'ride:request', { origin, dest, price: 95 });
  asked.push([p2, p2.uid]);
  await page.waitForFunction(() => document.body.innerText.includes('Solicitudes cercanas (2)'), { timeout: 8000 }).catch(() => {});
  await wait(500);
  check('silenciado, la solicitud llega sin sonido', (await page.evaluate(() => window.__alerts.length)) === 0, JSON.stringify(await page.evaluate(() => window.__alerts)));
  await page.reload({ waitUntil: 'networkidle2' });
  await (await page.waitForSelector('button.go', { timeout: 20000 })).click();
  await page.waitForSelector('.sound-toggle', { timeout: 15000 }).catch(() => null);
  check('recuerda el silencio al volver a abrir', (await page.$eval('.sound-toggle', (b) => b.textContent).catch(() => '')).includes('Silencio'));

  // ---------- Activarlo otra vez ----------
  await (await page.$('.sound-toggle')).click();
  await wait(1700);
  await page.evaluate(() => { window.__alerts = []; });
  const p3 = await connect(passengers[2].token);
  p3.uid = passengers[2].user.id;
  sockets.push(p3);
  const r3 = await emitAck(p3, 'ride:request', { origin, dest, price: 100 });
  asked.push([p3, p3.uid]);
  await page.waitForFunction(() => window.__alerts.length > 0, { timeout: 8000 }).catch(() => {});
  check('al activarlo vuelve a sonar', (await page.evaluate(() => window.__alerts.length)) === 1);
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
  // Los pasajeros cancelan (así el servidor también las saca de las solicitudes abiertas)
  for (const [s, uid] of asked) {
    const [[r]] = await pool.query("SELECT id FROM rides WHERE passenger_id = ? AND status = 'requested'", [uid]);
    if (r) s.emit('ride:cancel', { rideId: r.id });
  }
  await wait(800);
  sockets.forEach((s) => s.close());
  await pool.query("UPDATE rides SET status = 'cancelled', cancelled_by = 'system' WHERE status = 'requested' AND passenger_id IN (?, ?, ?)", passengers.map((p) => p.user.id));
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
