import 'dotenv/config';
// Revisa que ninguna pantalla se desborde en teléfono, tablet y escritorio. Uso: npm run test:responsive (servidor :4000 y Vite :5174)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { registerUser, createTestSuperadmin } from './helpers.mjs';

const CLIENT = process.env.CLIENT_URL || 'http://localhost:5174';
const SHOTS = process.env.SHOTS_DIR || path.join(process.cwd(), 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const rnd = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

const VIEWS = [['telefono-pequeno', 320, 640], ['telefono', 390, 844], ['telefono-horizontal', 844, 390], ['tablet', 768, 1024], ['escritorio', 1366, 768]];
const D = await registerUser({ name: 'R Driver', phone: `9${rnd}`, password: 'secreto1', role: 'driver', vehicle: 'Toyota', plate: 'HCC1111' });
const P = await registerUser({ name: 'R Pasajero', phone: `8${rnd}`, password: 'secreto1', role: 'passenger' });
const adm = await createTestSuperadmin(pool);
const A = { token: jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' }), user: { ...adm, role: 'superadmin', status: 'active' } };

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
// Devuelve lo que sobresale del ancho de la pantalla (fuera de zonas con su propio scroll horizontal)
const overflow = (page) => page.evaluate(() => {
  const vw = document.documentElement.clientWidth;
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || getComputedStyle(el).position === 'fixed') continue;
    if (r.right > vw + 1 || r.left < -1) {
      let p = el.parentElement, scrolls = false;
      while (p) { const o = getComputedStyle(p).overflowX; if (o === 'auto' || o === 'scroll' || o === 'hidden') { scrolls = true; break; } p = p.parentElement; }
      if (!scrolls || el.matches('.admin > *, .admin .seg, .seg button')) bad.push(`${el.tagName}.${el.className}`.slice(0, 50));
    }
  }
  return { wide: document.documentElement.scrollWidth > vw + 1, bad: [...new Set(bad)].slice(0, 4) };
});

async function open(session, w, h, hash = '') {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: w, height: h, isMobile: w < 900, hasTouch: w < 900 });
  await page.evaluateOnNewDocument(() => { navigator.geolocation.getCurrentPosition = (ok) => ok({ coords: { latitude: 14.07, longitude: -87.19, accuracy: 10 }, timestamp: Date.now() }); navigator.geolocation.watchPosition = (ok) => { ok({ coords: { latitude: 14.07, longitude: -87.19, accuracy: 10 }, timestamp: Date.now() }); return 1; }; });
  await page.goto(CLIENT + hash, { waitUntil: 'domcontentloaded' });
  if (session) { await page.evaluate((s) => localStorage.setItem('jalon', JSON.stringify(s)), session); await page.reload({ waitUntil: 'domcontentloaded' }); }
  await new Promise((r) => setTimeout(r, 1800));
  return page;
}

try {
  for (const [vname, w, h] of VIEWS) {
    const screens = [
      ['ingreso', null, ''],
      ['pasajero', { token: P.token, user: P.user }, ''],
      ['conductor', { token: D.token, user: D.user }, ''],
      ['panel', A, ''],
    ];
    for (const [sname, session, hash] of screens) {
      const page = await open(session, w, h, hash);
      const r = await overflow(page);
      check(`${sname} @ ${vname} (${w}px) sin desborde`, !r.wide && r.bad.length === 0, r.bad.join(', '));
      await page.screenshot({ path: path.join(SHOTS, `r-${sname}-${vname}.png`) });
      if (sname === 'panel') {
        for (const tab of ['Reportes', 'Recargas', 'Mapa en vivo', 'Ajustes', 'Personal', 'Registro', 'Usuarios']) {
          const b = await page.$(`button::-p-text(${tab})`);
          if (!b) continue;
          await b.click();
          await new Promise((r) => setTimeout(r, 500));
          const t = await overflow(page);
          check(`panel/${tab} @ ${vname} sin desborde`, !t.wide && t.bad.length === 0, t.bad.join(', '));
          if (tab === 'Ajustes' && w === 390) await page.screenshot({ path: path.join(SHOTS, `r-ajustes-${vname}.png`) });
        }
      }
      await page.browserContext().close();
    }
  }
} finally {
  await browser.close();
  await pool.query("DELETE FROM users WHERE name IN ('R Driver','R Pasajero','T Superadmin')").catch(() => {});
  await pool.end();
}
console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK');
process.exit(fails ? 1 : 0);
