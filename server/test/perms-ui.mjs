import 'dotenv/config';
// Barra de permisos: avisa si la ubicación o las notificaciones están apagadas y ofrece activarlas.
// Uso: web en CLIENT_URL y API_URL (servidor de pruebas con VAPID_PUBLIC_KEY/VAPID_PRIVATE_KEY para la parte de notificaciones).
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
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}${process.env.THEME ? `-${process.env.THEME}` : ''}.png`) });
const HERE = { latitude: 14.0723, longitude: -87.1921, accuracy: 10 };

const P = await registerUser({ name: 'Paula Permisos', phone: `86${rnd}1`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
const P2 = await registerUser({ name: 'Pedro Permisos', phone: `86${rnd}2`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
async function open(session, perms = []) {
  const ctx = await browser.createBrowserContext();
  if (perms.length) await ctx.overridePermissions(new URL(CLIENT).origin, perms);
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  if (perms.includes('geolocation')) await page.setGeolocation(HERE);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => localStorage.setItem('jalon', JSON.stringify(s)), session);
  await page.reload({ waitUntil: 'networkidle2' });
  for (const label of ['Acepto', 'Aceptar']) {
    const b = await page.$(`button::-p-text(${label})`);
    if (b) { await b.evaluate((x) => x.click()); await wait(300); }
  }
  return page;
}
const bar = (page, timeout = 8000) => page.waitForSelector('.perms-bar', { timeout }).catch(() => null);
const barText = (page) => page.$eval('.perms-bar', (b) => b.innerText).catch(() => '');

try {
  // ---------- Sin permiso de ubicación: primero la barra de ubicación ----------
  const a = await open({ token: P.token, user: P.user });
  check('sin ubicación aparece la barra de ubicación', !!(await bar(a)) && (await a.$('.perms-geo')) !== null, await barText(a));
  await wait(500);
  await shot(a, 'permisos-ubicacion');
  const t = await barText(a);
  if (/bloqueada/.test(t)) {
    await (await a.$('.perms-bar button::-p-text(Cómo activarla)')).click();
    await wait(300);
    check('«Cómo activarla» muestra los pasos', (await a.$$('.perms-steps li')).length >= 3);
    await shot(a, 'permisos-ubicacion-pasos');
  } else {
    check('ofrece activar la ubicación', /Activa tu ubicación/.test(t) && !!(await a.$('.perms-bar button::-p-text(Activar)')));
  }
  check('la barra no se sale de la pantalla', !(await a.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)));

  // ---------- Con ubicación pero notificaciones apagadas ----------
  const b = await open({ token: P2.token, user: P2.user }, ['geolocation', 'notifications']);
  const nb = await bar(b, 10000);
  const key = await b.evaluate(async (tok) => (await (await fetch('/api/push/key', { headers: { Authorization: `Bearer ${tok}` } })).json()).key, P2.token);
  if (!key) {
    check('sin llaves VAPID en el servidor no ofrece notificaciones', !nb);
  } else {
    check('con ubicación, ofrece activar las notificaciones', !!nb && (await b.$('.perms-push')) !== null && /notificaciones apagadas/.test(await barText(b)), await barText(b));
    await wait(500);
    await shot(b, 'permisos-notificaciones');
    await (await b.$('.perms-bar button::-p-text(Activar)')).click();
    // Chrome sin ventana no puede suscribirse al servicio de avisos de Google: ahí se espera el mensaje de error en español
    const gone = await b.waitForSelector('.perms-bar', { hidden: true, timeout: 15000 }).then(() => true, () => false);
    if (gone) {
      const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?', [P2.user.id]);
      check('al tocar «Activar» se activan, la barra se va y queda guardado', n.n >= 1, String(n.n));
    } else {
      const err = await b.$eval('.perms-error', (e) => e.textContent).catch(() => '');
      check('si el navegador no deja suscribirse, lo explica en español', /No se pudieron activar/.test(err), err);
      await shot(b, 'permisos-notificaciones-error');
    }
  }

  // ---------- «Ahora no» la esconde (y sigue escondida al volver a abrir) ----------
  await (await a.$('.perms-bar button::-p-text(Ahora no)')).click();
  await wait(300);
  check('«Ahora no» la esconde', !(await a.$('.perms-geo')));
  await a.reload({ waitUntil: 'networkidle2' });
  await wait(1500);
  check('y no vuelve a salir al abrir otra vez', !(await a.$('.perms-geo')));
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
}
await pool.query('DELETE FROM push_subscriptions WHERE user_id IN (?, ?)', [P.user.id, P2.user.id]).catch(() => {});
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
