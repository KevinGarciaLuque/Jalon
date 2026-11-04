import 'dotenv/config';
// Códigos promocionales en la pantalla: el pasajero aplica un código y ve cuánto paga; el personal ve la pestaña Promociones.
// Uso: web en CLIENT_URL y API_URL (necesita las búsquedas de direcciones, como el recorrido completo)
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
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}${process.env.THEME ? `-${process.env.THEME}` : ''}.png`) });

const adm = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const before = await http('GET', 'admin/settings', SA);
await http('POST', 'admin/bank-accounts', SA, { bank: 'Banco UI', type: 'Ahorros', number: `77-${rnd}`, holder: 'Ktracho GO' });
await http('PUT', 'admin/settings', SA, { commission_enabled: true });
const CODE = `UI${rnd}`;
await http('POST', 'admin/promos', SA, { code: CODE, description: 'L 30 menos en tu viaje', kind: 'fixed', value: 30, max_uses: 100 });
const P = await registerUser({ name: 'UI Promo', phone: `87${rnd}1`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
async function open(session) {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(CLIENT, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: Number(process.env.VIEW_W) || 390, height: Number(process.env.VIEW_H) || 844 });
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

try {
  // ---------- Pasajero ----------
  const pass = await open({ token: P.token, user: P.user });
  await pass.waitForSelector('input[placeholder^="¿A dónde vas?"]', { timeout: 20000 });
  await pass.type('input[placeholder^="¿A dónde vas?"]', 'Mall Multiplaza Tegucigalpa');
  await (await pass.waitForSelector('::-p-text(Mall Multiplaza,)', { timeout: 20000 })).click(); // la sugerencia (no lo escrito)
  check('aparece el botón para pedir', await see(pass, 'Pedir viaje por', 25000));
  await (await pass.waitForSelector('button::-p-text(¿Tienes un código promocional?)')).click();
  await pass.type('input[aria-label="Código promocional"]', 'NOEXISTE');
  await (await pass.waitForSelector('.promo-form button')).click();
  check('un código que no existe muestra el motivo', await see(pass, 'Ese código no existe'));
  await pass.$eval('input[aria-label="Código promocional"]', (el) => { el.value = ''; });
  await pass.click('input[aria-label="Código promocional"]', { clickCount: 3 });
  await pass.type('input[aria-label="Código promocional"]', CODE.toLowerCase());
  await (await pass.waitForSelector('.promo-form button')).click();
  check('con un código bueno muestra cuánto descuenta', await see(pass, 'L 30 menos'));
  const price = Number(await pass.$eval('.price input', (el) => el.value));
  check('el botón dice cuánto paga con el descuento', await see(pass, `pagas L ${price - 30}`), `(precio ${price})`);
  await wait(300);
  await shot(pass, 'promo-pasajero');
  await (await pass.waitForSelector('button::-p-text(Pedir viaje por)')).click();
  check('el viaje pedido muestra lo que paga con el código', await see(pass, `pagas L ${price - 30} en vez de L ${price}`));
  await wait(400);
  await shot(pass, 'promo-pasajero-viaje');
  const wide = await pass.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('no se sale de la pantalla a lo ancho', !wide);

  // ---------- Panel ----------
  const admin = await open({ token: SA, user: { ...adm, role: 'superadmin', status: 'active' } });
  const menu = await admin.waitForSelector('button.menu-btn', { timeout: 20000 });
  if (!(await admin.$('nav.sidebar'))) { await menu.evaluate((b) => b.click()); await admin.waitForSelector('.drawer'); await wait(400); }
  await (await admin.waitForSelector('::-p-text(Promociones)', { timeout: 15000 })).evaluate((b) => b.closest('button').click());
  check('la pestaña Promociones muestra el código y su descuento', (await see(admin, CODE)) && (await see(admin, 'L 30 menos')));
  check('dice cuántas veces se usó y cuánto puso Ktracho GO', await see(admin, 'Ktracho GO puso'));
  check('tiene el formulario para crear uno nuevo', await see(admin, 'Crear código'));
  await shot(admin, 'promo-panel');
  const wideA = await admin.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
  check('el panel no se sale de la pantalla a lo ancho', !wideA);
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
  await pool.query("UPDATE rides SET status = 'cancelled', cancelled_by = 'system' WHERE passenger_id = ? AND status = 'requested'", [P.user.id]);
  await http('PUT', 'admin/settings', SA, { commission_enabled: before.commission_enabled === '1' });
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
