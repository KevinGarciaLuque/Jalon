import 'dotenv/config';
// La entrada para gente nueva: la primera vez pregunta «¿Eres nuevo?», el enlace de pasajeros abre el registro
// y, si alguien intenta entrar sin cuenta, le ofrece crearla. Uso: web en CLIENT_URL y API_URL.
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

const phone = `84${rnd}1`.slice(0, 8);
await registerUser({ name: 'Wendy Bienvenida', phone, password: 'Cielo-azul-77', role: 'passenger' });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
async function fresh(url = CLIENT) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: 390, height: 844 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(url, { waitUntil: 'networkidle2' });
  return page;
}
const see = (page, text, timeout = 10000) => page.waitForFunction((t) => document.body.innerText.includes(t), { timeout }, text).then(() => true, () => false);
const press = async (page, text) => { await (await page.waitForSelector(`button::-p-text(${text})`, { timeout: 10000 })).click(); await wait(300); };

try {
  // ---------- Primera vez ----------
  const a = await fresh();
  check('la primera vez pregunta si es nuevo', (await see(a, '¡Bienvenido a Ktracho GO!')) && (await see(a, '¿Es tu primera vez aquí?')));
  check('sin formulario de entrada todavía', !(await a.$('input[placeholder="Contraseña"]')));
  await shot(a, 'bienvenida');
  await press(a, 'Soy nuevo · Crear mi cuenta');
  check('«Soy nuevo» abre «Crear cuenta»', (await see(a, 'Crear cuenta')) && !!(await a.$('input[placeholder="Nombre"]')));
  check('el registro ofrece «¿Ya tienes cuenta? Entrar»', await see(a, '¿Ya tienes cuenta? Entrar'));
  await press(a, '¿Ya tienes cuenta? Entrar');
  check('y lleva a «Entrar»', !!(await a.$('input[placeholder="Contraseña"]')) && !(await a.$('input[placeholder="Nombre"]')));
  await shot(a, 'entrar-con-inicio');
  await press(a, '← Inicio');
  check('«← Inicio» en Entrar vuelve a la pregunta', await see(a, '¿Es tu primera vez aquí?'));
  await press(a, 'Soy nuevo · Crear mi cuenta');
  await press(a, '← Inicio');
  check('y también desde Crear cuenta', await see(a, '¿Es tu primera vez aquí?'));

  // ---------- Intenta entrar sin cuenta ----------
  const b = await fresh();
  await press(b, 'Ya tengo cuenta · Entrar');
  await b.type('input[placeholder^="Teléfono"]', `83${rnd}9`.slice(0, 8));
  await b.type('input[placeholder="Contraseña"]', 'cualquier-cosa-1');
  await press(b, 'Entrar');
  check('al fallar ofrece «¿Todavía no tienes cuenta?»', (await see(b, 'Teléfono o contraseña incorrectos')) && (await see(b, '¿Todavía no tienes cuenta?')));
  await shot(b, 'entrada-fallida');
  await (await b.$('.no-account button')).click();
  await wait(300);
  const kept = await b.$eval('input[placeholder^="Teléfono"]', (i) => i.value);
  check('«Crear mi cuenta» abre el registro con su teléfono ya escrito', (await see(b, 'Crear cuenta')) && kept === `83${rnd}9`.slice(0, 8), kept);

  // ---------- Enlace de pasajeros ----------
  const c = await fresh(`${CLIENT}/?registro=pasajero`);
  check('el enlace de pasajeros abre directo el registro', (await see(c, 'Crear cuenta')) && !(await see(c, '¡Bienvenido a Ktracho GO!', 1000)));
  check('con «Soy pasajero» elegido', await c.$eval('.seg button.on', (x) => x.textContent) === 'Soy pasajero');

  // ---------- Quien ya entró una vez no vuelve a ver la pregunta ----------
  const d = await fresh();
  await press(d, 'Ya tengo cuenta · Entrar');
  await d.type('input[placeholder^="Teléfono"]', phone);
  await d.type('input[placeholder="Contraseña"]', 'Cielo-azul-77');
  await press(d, 'Entrar');
  await d.waitForSelector('button.avatar-btn', { timeout: 20000 });
  await d.evaluate(() => localStorage.removeItem('jalon'));
  await d.reload({ waitUntil: 'networkidle2' });
  check('después de entrar una vez, va directo a «Entrar»', !!(await d.waitForSelector('input[placeholder="Contraseña"]', { timeout: 10000 }).catch(() => null)) && !(await see(d, '¡Bienvenido', 1000)));
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
