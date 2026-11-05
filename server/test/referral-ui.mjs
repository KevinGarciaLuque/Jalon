import 'dotenv/config';
// Referidos en la pantalla: «Invita y gana» del pasajero, el registro con ?ref=, el descuento de bienvenida al pedir
// y la pestaña Referidos del panel. Uso: web en CLIENT_URL y API_URL (necesita las búsquedas de direcciones)
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
await http('POST', 'admin/bank-accounts', SA, { bank: 'Banco UI', type: 'Ahorros', number: `78-${rnd}`, holder: 'Ktracho GO' });
await http('PUT', 'admin/settings', SA, { commission_enabled: true, referral_enabled: true, referral_reward: 30, referral_welcome: 20 });
await wait(300);
const A = await registerUser({ name: 'Marta UI', phone: `86${rnd}1`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
const CODE = (await http('GET', 'referrals/me', A.token)).code;
const B = await registerUser({ name: 'Nico UI', phone: `86${rnd}2`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger', referral: CODE });

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
async function open(session, url = CLIENT) {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(CLIENT, ['geolocation']);
  const page = await ctx.newPage();
  await page.setViewport({ width: Number(process.env.VIEW_W) || 390, height: Number(process.env.VIEW_H) || 844 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  await page.setGeolocation({ latitude: 14.0723, longitude: -87.1921, accuracy: 5 });
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  if (session) {
    await page.evaluate((s) => localStorage.setItem('jalon', JSON.stringify(s)), session);
    await page.reload({ waitUntil: 'networkidle2' });
  } else await page.waitForNetworkIdle().catch(() => {});
  for (const label of ['Acepto', 'Aceptar', 'Ahora no']) {
    const b = await page.$(`button::-p-text(${label})`);
    if (b) { await b.evaluate((x) => x.click()); await wait(300); }
  }
  return page;
}
const see = (page, text, timeout = 15000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true, () => false);
const wide = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
async function openMenu(page) {
  const menu = await page.waitForSelector('button.menu-btn', { timeout: 20000 });
  await menu.evaluate((b) => b.click());
  await page.waitForSelector('.drawer');
  await wait(400);
}

try {
  // ---------- «Invita y gana» ----------
  const pa = await open({ token: A.token, user: A.user });
  await openMenu(pa);
  check('el menú tiene «Invita y gana»', await see(pa, 'Invita y gana'));
  await (await pa.waitForSelector('::-p-text(Invita y gana)')).evaluate((b) => b.closest('button').click());
  check('muestra el código de la persona', await see(pa, CODE));
  check('dice el premio y la bienvenida', (await see(pa, 'L 30 de descuento')) && (await see(pa, 'L 20 menos')));
  check('lista al invitado como pendiente', (await see(pa, 'Nico')) && (await see(pa, 'Esperando su primer viaje')));
  check('tiene los botones para compartir y copiar', !!(await pa.$('button::-p-text(Compartir por WhatsApp)')) && !!(await pa.$('button::-p-text(Copiar enlace)')));
  await wait(300);
  await shot(pa, 'referidos-invita');
  check('«Invita y gana» no se sale de la pantalla', !(await wide(pa)));

  // ---------- Registro con el enlace ----------
  const reg = await open(null, `${CLIENT}/?ref=${CODE.toLowerCase()}`);
  check('el enlace abre el registro', await see(reg, 'Crear cuenta'));
  const val = await reg.$eval('input[aria-label="Código de invitación"]', (el) => el.value).catch(() => '');
  check('con el código de invitación ya escrito', val === CODE, val);
  await shot(reg, 'referidos-registro');

  // ---------- El invitado ve su bienvenida al pedir ----------
  const pb = await open({ token: B.token, user: B.user });
  await pb.waitForSelector('input[placeholder^="¿A dónde vas?"]', { timeout: 20000 });
  await pb.type('input[placeholder^="¿A dónde vas?"]', 'Mall Multiplaza Tegucigalpa');
  await (await pb.waitForSelector('::-p-text(Mall Multiplaza,)', { timeout: 20000 })).click();
  check('aparece el botón para pedir', await see(pb, 'Pedir viaje por', 25000));
  check('le ofrece su descuento de bienvenida sin escribir el código', await see(pb, 'Usar tu descuento de L 20'));
  await shot(pb, 'referidos-bienvenida');
  await (await pb.waitForSelector('button.promo-gift')).click();
  const price = Number(await pb.$eval('.price input', (el) => el.value));
  check('al tocarlo, el botón dice cuánto paga', await see(pb, `pagas L ${price - 20}`), `(precio ${price})`);
  check('el pedido no se sale de la pantalla', !(await wide(pb)));

  // ---------- Panel ----------
  const admin = await open({ token: SA, user: { ...adm, role: 'superadmin', status: 'active' } });
  const menu = await admin.waitForSelector('button.menu-btn', { timeout: 20000 });
  if (!(await admin.$('nav.sidebar'))) { await menu.evaluate((b) => b.click()); await admin.waitForSelector('.drawer'); await wait(400); }
  await (await admin.waitForSelector('::-p-text(Referidos)', { timeout: 15000 })).evaluate((b) => b.closest('button').click());
  check('la pestaña Referidos muestra quién invitó a quién', (await see(admin, 'Marta UI')) && (await see(admin, 'Nico UI')));
  await shot(admin, 'referidos-panel-lista');
  await (await admin.waitForSelector('.page-tabs [role="tab"]::-p-text(Reglas)')).click();
  await wait(200);
  check('el superadmin tiene el botón para apagarlos', await see(admin, 'Apagar los referidos'));
  check('muestra las reglas para cambiar', await see(admin, 'Premio para quien invita'));
  await wait(300);
  await shot(admin, 'referidos-panel');
  check('el panel no se sale de la pantalla', !(await wide(admin)));
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
  await http('PUT', 'admin/settings', SA, { commission_enabled: before.commission_enabled === '1', referral_enabled: before.referral_enabled === '1', referral_reward: Number(before.referral_reward), referral_welcome: Number(before.referral_welcome) });
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
