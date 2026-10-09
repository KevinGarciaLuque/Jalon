import 'dotenv/config';
// El mapa debe cargar sus baldosas de OpenStreetMap (si el navegador no envía Referer, OSM las bloquea con 403).
// Uso: CLIENT_URL=http://localhost:4100 node test/tiles.mjs   (servidor en modo producción, que es donde aplica la política de seguridad)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import { pool } from '../src/db.js';
import { registerUser } from './helpers.mjs';

const CLIENT = process.env.CLIENT_URL || 'http://localhost:5174';
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const phone = `8${String(Math.floor(Math.random() * 1e7)).padStart(7, '0')}`;
const P = await registerUser({ name: 'Test Pasajero', phone, password: 'secreto1', role: 'passenger' });

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const statuses = [];
let referer;
try {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(CLIENT, ['geolocation']);
  const page = await ctx.newPage();
  await page.setGeolocation({ latitude: 14.0723, longitude: -87.1921 });
  page.on('response', (r) => {
    if (r.url().includes('tile.openstreetmap.org')) {
      statuses.push(r.status());
      referer ??= r.request().headers().referer;
    }
  });
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => localStorage.setItem('jalon', JSON.stringify(s)), P);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.leaflet-tile', { timeout: 20000 });
  await new Promise((r) => setTimeout(r, 4000));
} finally {
  await browser.close();
  await pool.query("DELETE FROM users WHERE name = 'Test Pasajero'").catch(() => {});
  await pool.end();
}

const bad = statuses.filter((s) => s >= 400);
console.log(`Baldosas: ${statuses.length}, con error: ${bad.length} ${bad.length ? `(${[...new Set(bad)]})` : ''}; Referer enviado: ${referer ?? '(ninguno)'}`);
const ok = statuses.length > 0 && bad.length === 0 && !!referer; // sin Referer, OpenStreetMap puede bloquear el mapa
console.log(ok ? 'OK   el mapa carga sus baldosas y envía el Referer' : 'FAIL el mapa no carga bien o no envía el Referer');
process.exitCode = ok ? 0 : 1;
setTimeout(() => process.exit(process.exitCode), 300);
