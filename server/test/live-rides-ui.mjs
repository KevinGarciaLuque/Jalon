import 'dotenv/config';
// Mapa en vivo: «Viajes en curso» con barra de progreso. Tres viajes: uno yendo a recoger, uno a mitad de camino y uno con
// el botón de emergencia (sale primero, en rojo). Al tocar uno, el mapa muestra su ruta.
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
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}${process.env.THEME ? `-${process.env.THEME}` : ''}.png`), fullPage: true });
const connect = async (token) => { const s = io(API, { auth: { token }, transports: ['websocket'], reconnection: false }); await new Promise((r, j) => { s.once('connect', r); s.once('connect_error', j); }); return s; };
const next = (s, ev, pred = () => true, ms = 8000) => new Promise((res, rej) => { const h = (d) => { if (pred(d)) { s.off(ev, h); res(d); } }; s.on(ev, h); setTimeout(() => { s.off(ev, h); rej(new Error(`no llegó ${ev}`)); }, ms); });
const emitAck = (s, ev, data) => new Promise((r) => s.emit(ev, data, r));
const sockets = [];
const made = []; // viajes creados por esta prueba

const adm = await createTestSuperadmin(pool);
await pool.query('UPDATE users SET staff_mode = NULL WHERE id = ?', [adm.id]);
const SA = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);
await http('PUT', 'admin/settings', SA, { min_balance: -500 });

// Un viaje hasta `status`, con el conductor conectado en `at`
async function trip(n, name, origin, dest, status, at) {
  const D = await registerUser({ name, phone: `9${rnd}${n}`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `LR${rnd.slice(0, 3)}${n}` });
  await uploadDocs(D.token);
  await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
  const P = await registerUser({ name: `Pasajera ${n}`, phone: `8${rnd}${n}`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const ds = await connect(D.token);
  const ps = await connect(P.token);
  sockets.push(ds, ps);
  ds.emit('driver:online', { lat: origin.lat + 0.004, lng: origin.lng + 0.004 });
  await wait(300);
  const rideNew = next(ds, 'ride:new');
  const ack = await emitAck(ps, 'ride:request', { origin, dest, price: 100 });
  if (!ack?.ok) throw new Error(`no se pudo pedir: ${ack?.error}`);
  const rn = await rideNew;
  const offer = next(ps, 'offer:new');
  ds.emit('offer:make', { rideId: rn.id, price: 100 });
  const o = await offer;
  const accepted = next(ps, 'ride:state', (r) => r.status === 'accepted');
  ps.emit('offer:accept', { offerId: o.id });
  const r = await accepted;
  for (const st of ['arrived', 'started']) {
    if (status === 'accepted' || (status === 'arrived' && st === 'started')) break;
    const moved = next(ps, 'ride:state', (x) => x.status === st);
    ds.emit('ride:status', { rideId: r.id, status: st });
    await moved;
  }
  if (at) { ds.emit('driver:location', at); await wait(300); }
  made.push(r.id);
  return { id: r.id, ds, ps, P };
}

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
try {
  const kennedy = { lat: 14.0723, lng: -87.1921, text: 'Colonia Kennedy' };
  const mall = { lat: 14.0905, lng: -87.2055, text: 'Mall Multiplaza, Tegucigalpa' };
  const centro = { lat: 14.1050, lng: -87.2040, text: 'Parque Central, Tegucigalpa' };
  const t1 = await trip('61', 'Ana Recoge', kennedy, mall, 'accepted', { lat: 14.0800, lng: -87.1850 });
  const mid = { lat: (kennedy.lat + centro.lat) / 2, lng: (kennedy.lng + centro.lng) / 2 };
  const t2 = await trip('62', 'Beto Mitad', kennedy, centro, 'started', mid);
  const t3 = await trip('63', 'Carla Alerta', mall, centro, 'started', { lat: 14.0950, lng: -87.2050 });
  check('la emergencia queda registrada', (await emitAck(t3.ps, 'ride:sos', { lat: 14.0950, lng: -87.2050 }))?.ok === true);

  // ---------- La ruta del panel ----------
  const snap = await http('GET', 'admin/monitor', SA);
  const mine = (snap.rides || []).filter((r) => [t1.id, t2.id, t3.id].includes(r.id));
  check('el mapa en vivo trae los 3 viajes en curso', mine.length === 3, JSON.stringify(mine.map((r) => [r.id, r.status, r.level])));
  const r2 = mine.find((r) => r.id === t2.id);
  check('a mitad del camino marca cerca del 50 %', r2 && r2.progress >= 30 && r2.progress <= 70 && r2.etaMin >= 1, JSON.stringify(r2 && { p: r2.progress, eta: r2.etaMin }));
  const r1 = mine.find((r) => r.id === t1.id);
  check('yendo a recoger: etapa «Aceptado» con tiempo para llegar', r1?.stage === 0 && r1.etaMin >= 1 && r1.level === 'ok', JSON.stringify(r1 && { s: r1.stage, eta: r1.etaMin, l: r1.level }));
  const r3 = mine.find((r) => r.id === t3.id);
  check('el de la emergencia sale en rojo y primero', r3?.level === 'danger' && /emergencia/.test(r3.alert || '') && snap.rides[0].level === 'danger', JSON.stringify(r3 && { l: r3.level, a: r3.alert }));
  check('trae la ruta para dibujarla', Array.isArray(r2?.route) && r2.route.length >= 2);

  // ---------- La pantalla ----------
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => localStorage.setItem('jalon', JSON.stringify(s)), { token: SA, user: { ...adm, role: 'superadmin', status: 'active' } });
  await page.reload({ waitUntil: 'networkidle2' });
  await page.waitForSelector('nav.sidebar', { timeout: 20000 });
  await page.evaluate(() => [...document.querySelectorAll('nav.sidebar button, nav.sidebar a')].find((b) => b.textContent.includes('Mapa en vivo'))?.click());
  await page.waitForSelector('.live-rides .lr-card', { timeout: 15000 });
  await wait(800);
  const cards = await page.$$eval('.live-rides .lr-card', (l) => l.map((c) => c.innerText.replace(/\s+/g, ' ')));
  check('«Viajes en curso» muestra una tarjeta por viaje', cards.length >= 3, String(cards.length));
  check('la primera es la emergencia, con su aviso', cards[0].includes('Botón de emergencia'), cards[0]);
  check('el que va a mitad dice «En viaje N %» y cuánto falta', cards.some((c) => /En viaje \d+ %/.test(c) && /llega al destino en ~\d+ min/.test(c) && c.includes('Beto Mitad')));
  check('el contador dice cuántos tienen alerta', /Viajes en curso · 1 con alerta/.test(await page.$eval('.monitor .stats', (e) => e.innerText.replace(/\s+/g, ' '))));
  const bars = await page.$$eval('.lr-track[role="progressbar"]', (l) => l.map((b) => Number(b.getAttribute('aria-valuenow'))));
  check('cada barra tiene su avance', bars.length >= 3 && bars.every((v) => v >= 0 && v <= 100));
  // Tocar el viaje de la mitad: el mapa dibuja su ruta
  const idx = cards.findIndex((c) => c.includes('Beto Mitad'));
  await (await page.$$('.live-rides .lr-card'))[idx].click();
  await wait(1000);
  check('al tocarlo queda elegido y el mapa dibuja la ruta', !!(await page.$('.lr-card.on')) && !!(await page.$('.monmap path.leaflet-interactive')));
  await shot(page, 'viajes-en-curso');
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
  // Se cierran los viajes de prueba y sus emergencias
  if (made.length) {
    await pool.query("UPDATE alerts SET status = 'resolved' WHERE status = 'open' AND ride_id IN (?)", [made]);
    await pool.query("UPDATE rides SET status = 'cancelled', cancelled_by = 'admin' WHERE id IN (?) AND status IN ('accepted','arrived','started')", [made]);
  }
  sockets.forEach((s) => s.close());
  await http('PUT', 'admin/settings', SA, { min_balance: Number(before.min_balance) });
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
