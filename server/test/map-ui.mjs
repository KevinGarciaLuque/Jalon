import 'dotenv/config';
// Mapa que gira (como Waze) y sus botones, con un GPS simulado que «maneja». Uso: npm run test:map (web en CLIENT_URL y API_URL)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { http, registerUser, createTestSuperadmin } from './helpers.mjs';

const CLIENT = process.env.CLIENT_URL || 'http://localhost:4000';
const SHOTS = process.env.SHOTS_DIR || '';
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const norm = (deg) => ((deg % 360) + 360) % 360;
const near = (a, b, tol = 15) => { const d = Math.abs(norm(a) - norm(b)); return Math.min(d, 360 - d) <= tol; };
// Giro del mapa (lo muestra la brújula) y giro del carro en pantalla
const compassAngle = (page) => page.$eval('.map-btn.compass svg', (s) => Number((s.style.transform.match(/-?[\d.]+/) || [0])[0]));
const carAngle = (page) => page.$eval('.car-rot', (c) => Number((c.style.transform.match(/-?[\d.]+/) || [0])[0])).catch(() => NaN);

const D = await registerUser({ name: 'MAP Conductor', phone: `9${rnd}7`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', category: 'car', make: 'Toyota', model: 'Yaris', color: 'Gris', year: '2018', plate: `HMP${rnd.slice(0, 4)}` });
const P = await registerUser({ name: 'MAP Pasajera', phone: `8${rnd}7`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const open = async (who, extra = {}) => {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(CLIENT, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  await page.setGeolocation({ latitude: 14.0723, longitude: -87.1921, accuracy: 5 });
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.evaluate((s) => localStorage.setItem('jalon', JSON.stringify(s)), { token: who.token, user: { ...who.user, ...extra } });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.map-btn.compass', { timeout: 20000 });
  await wait(800);
  return page;
};
// El GPS avanza hacia el este, unos 30 m por segundo (más que caminando: el mapa gira)
async function driveEast(page, steps = 6) {
  for (let i = 1; i <= steps; i++) {
    await page.setGeolocation({ latitude: 14.0723, longitude: -87.1921 + i * 0.00028, accuracy: 5 });
    await wait(1000);
  }
  await wait(700);
}

try {
  check('el servidor dice si el mapa puede girar', (await http('GET', 'me', D.token)).user?.mapRotation === true);

  // ---- Conductor: el mapa lo sigue y gira según hacia dónde va ----
  const drv = await open(D);
  check('el conductor ve la brújula y «Mi ubicación»', !!(await drv.$('.map-btn.compass')) && !!(await drv.$('[aria-label="Mi ubicación"]')));
  check('el mapa del conductor empieza con el norte arriba', near(await compassAngle(drv), 0, 2));
  await driveEast(drv);
  const turned = await compassAngle(drv);
  check('al manejar hacia el este el mapa gira (el este queda arriba)', near(turned, 270), `(${turned}°)`);
  const car = await carAngle(drv);
  check('el carro queda apuntando hacia arriba en la pantalla', near(car, 0, 20), `(${car}°)`);
  check('«Mi ubicación» está activo: el mapa lo sigue', !!(await drv.$('[aria-label="Mi ubicación"].on')));
  await shot(drv, 'map-1-conductor-gira');

  // Parado (GPS quieto) el mapa no da vueltas
  await drv.setGeolocation({ latitude: 14.0723, longitude: -87.1921 + 6 * 0.00028 + 0.00001, accuracy: 5 });
  await wait(1500);
  check('quieto (el GPS tiembla un poco) el mapa no gira', near(await compassAngle(drv), turned, 3));

  // Brújula: norte arriba
  await drv.click('.map-btn.compass');
  await wait(800);
  check('al tocar la brújula vuelve el norte arriba', near(await compassAngle(drv), 0, 2));
  check('la brújula dice que ahora está con el norte arriba', (await drv.$eval('.map-btn.compass', (b) => b.getAttribute('aria-label'))).startsWith('Norte arriba'));
  await driveEast(drv, 3);
  check('con el norte arriba, aunque maneje, el mapa no gira', near(await compassAngle(drv), 0, 2));

  // Mover el mapa con el dedo deja de seguirlo; «Mi ubicación» lo vuelve a centrar
  const box = await drv.$eval('.map', (m) => { const r = m.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 200 }; });
  await drv.mouse.move(box.x, box.y);
  await drv.mouse.down();
  await drv.mouse.move(box.x - 120, box.y + 60, { steps: 8 });
  await drv.mouse.up();
  await wait(400);
  check('al mover el mapa con el dedo deja de seguirlo', !(await drv.$('[aria-label="Mi ubicación"].on')));
  await drv.click('[aria-label="Mi ubicación"]');
  await wait(900);
  const centered = await drv.evaluate(() => {
    const m = document.querySelector('.leaflet-container').getBoundingClientRect();
    const c = document.querySelector('.car-rot').getBoundingClientRect();
    const sheet = document.querySelector('.screen .sheet');
    const covered = sheet && getComputedStyle(sheet).position === 'absolute' ? Math.min(sheet.offsetHeight, m.height * 0.7) : 0;
    return Math.hypot(c.x + c.width / 2 - (m.x + m.width / 2), c.y + c.height / 2 - (m.y + (m.height - covered) / 2));
  });
  check('«Mi ubicación» lo centra en la parte del mapa que se ve (no debajo de la hoja) y lo sigue', centered < 40 && !!(await drv.$('[aria-label="Mi ubicación"].on')), `(${Math.round(centered)} px del centro)`);
  // La brújula recuerda la forma elegida en este aparato
  await drv.reload({ waitUntil: 'domcontentloaded' });
  await drv.waitForSelector('.map-btn.compass', { timeout: 20000 });
  check('recuerda «norte arriba» al volver a abrir', (await drv.$eval('.map-btn.compass', (b) => b.getAttribute('aria-label'))).startsWith('Norte arriba'));
  await drv.browserContext().close();

  // ---- Pasajera: norte arriba; con destino aparece «Ver todo el viaje» ----
  const pas = await open(P);
  await driveEast(pas, 3);
  check('el mapa de la pasajera no gira solo (norte arriba)', near(await compassAngle(pas), 0, 2));
  check('sin destino no aparece «Ver todo el viaje»', !(await pas.$('[aria-label="Ver todo el viaje"]')));
  // Con la brújula se elige que gire, y al manejar gira
  await pas.click('.map-btn.compass');
  await wait(300);
  check('la brújula avisa «El mapa gira según hacia dónde vas»', !!(await pas.$('.map-toast')) && (await pas.$eval('.map-toast', (t) => t.textContent)).includes('gira'));
  await driveEast(pas, 4);
  check('después de elegirlo, el mapa de la pasajera también gira', near(await compassAngle(pas), 270));
  await pas.click('.map-btn.compass'); // otra vez norte arriba para marcar el destino
  await wait(700);
  const mapBox = await pas.$eval('.map', (m) => { const r = m.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + 120 }; });
  await pas.mouse.click(mapBox.x, mapBox.y); // marca el destino tocando el mapa
  const fitBtn = await pas.waitForSelector('[aria-label="Ver todo el viaje"]', { timeout: 15000 }).catch(() => null);
  check('con destino aparece «Ver todo el viaje»', !!fitBtn);
  if (fitBtn) {
    await fitBtn.click();
    await wait(800);
    await shot(pas, 'map-2-pasajera-ver-viaje');
  }
  await pas.browserContext().close();

  // ---- Con el giro apagado por el superadmin: el mapa queda con el norte arriba ----
  const root = await createTestSuperadmin(pool);
  const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  await http('PUT', 'admin/settings', SA, { map_rotation: '0' });
  check('al apagarlo en Ajustes, la app se entera', (await http('GET', 'me', D.token)).user?.mapRotation === false);
  const off = await open(D, { mapRotation: false });
  await driveEast(off);
  check('con el giro apagado, el mapa del conductor no gira', near(await compassAngle(off), 0, 2));
  check('la brújula dice que el norte está arriba', (await off.$eval('.map-btn.compass', (b) => b.getAttribute('aria-label'))).startsWith('El norte está arriba'));
  await off.browserContext().close();
  await http('PUT', 'admin/settings', SA, { map_rotation: '1' });
  await pool.query('DELETE FROM users WHERE id = ?', [root.id]).catch(() => {});
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]); // en Windows a veces no termina de cerrar
  await pool.end();
}
console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK');
process.exit(fails ? 1 : 0);
