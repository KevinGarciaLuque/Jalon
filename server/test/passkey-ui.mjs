import 'dotenv/config';
// Face ID / huella en la app: un autenticador virtual de Chrome hace de celular. Uso: npm run test:passkey (web en CLIENT_URL y API_URL)
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
const rnd = String(Math.floor(Math.random() * 1e6)).padStart(6, '0');
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clickText = async (page, sel, text, timeout = 15000) => (await page.waitForSelector(`${sel}::-p-text(${text})`, { timeout })).click();

const phone = `8${rnd}9`.slice(0, 8);
const P = await registerUser({ name: 'PK Pasajera', phone, password: 'Cielo-azul-77', role: 'passenger' });
const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  page.on('dialog', (d) => d.accept());
  // El «celular»: una llave de plataforma con Face ID (verificación de usuario) que siempre reconoce a la persona
  const cdp = await page.createCDPSession();
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });

  // Entrar con la contraseña → se ofrece activar Face ID
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[name="username"]', { timeout: 15000 });
  const attrs = await page.evaluate(() => ({ user: document.querySelector('input[name="username"]').autocomplete, pass: document.querySelector('input[name="password"]').autocomplete }));
  check('el formulario marca usuario y contraseña para el llavero del celular', attrs.user === 'username' && attrs.pass === 'current-password', JSON.stringify(attrs));
  check('la pantalla de entrada ofrece «Entrar con …»', !!(await page.$('.passkey-btn')));
  await page.type('input[name="username"]', phone);
  await page.type('input[name="password"]', 'Cielo-azul-77');
  await clickText(page, 'button', 'Entrar');
  const offer = await page.waitForSelector('.offer-pop', { timeout: 15000 }).catch(() => null);
  check('después de entrar con la contraseña ofrece activar Face ID / huella', !!offer);
  await wait(400);
  await shot(page, 'pk-1-oferta');
  await clickText(page, '.offer-pop button', 'Activar');
  check('al activarlo dice «¡Listo!»', !!(await page.waitForSelector('.offer-pop ::-p-text(¡Listo!)', { timeout: 15000 }).catch(() => null)));
  await clickText(page, '.offer-pop button', 'Entendido');
  const [[n]] = await pool.query('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?', [P.user.id]);
  check('la llave quedó guardada en el servidor', n.n === 1);

  // Mi cuenta muestra el aparato
  await (await page.waitForSelector('button.menu-btn')).evaluate((b) => b.click());
  await page.waitForSelector('.drawer');
  await wait(400); // que termine de entrar el menú
  await clickText(page, '.drawer button', 'Mi cuenta');
  check('Mi cuenta muestra el aparato con Face ID / huella', !!(await page.waitForSelector('[aria-labelledby="pk-title"] .row', { timeout: 15000 }).catch(() => null)) && (await page.$$eval('[aria-labelledby="pk-title"] .row', (rs) => rs.length)) === 1);
  await wait(400);
  await shot(page, 'pk-2-mi-cuenta');

  // Salir y volver a entrar solo con Face ID
  await clickText(page, '.overlay button', 'Cerrar ✕');
  await (await page.waitForSelector('button.menu-btn')).evaluate((b) => b.click());
  await page.waitForSelector('.drawer');
  await wait(400);
  await page.click('.drawer-logout');
  await page.waitForSelector('.passkey-btn', { timeout: 15000 });
  await page.click('.passkey-btn');
  check('entra con Face ID / huella sin escribir la contraseña', !!(await page.waitForSelector('button.menu-btn', { timeout: 15000 }).catch(() => null)));
  await wait(1500);
  check('al entrar con Face ID no vuelve a ofrecer activarlo', !(await page.$('.offer-pop')));

  // Quitar el aparato desde Mi cuenta
  await (await page.waitForSelector('button.menu-btn')).evaluate((b) => b.click());
  await page.waitForSelector('.drawer');
  await wait(400); // que termine de entrar el menú
  await clickText(page, '.drawer button', 'Mi cuenta');
  await clickText(page, '[aria-labelledby="pk-title"] button', 'Quitar');
  check('se puede quitar desde Mi cuenta', !!(await page.waitForSelector('[aria-labelledby="pk-title"] ::-p-text(Todavía no lo tienes activado)', { timeout: 15000 }).catch(() => null)));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]); // en Windows a veces no termina de cerrar
  await pool.query('DELETE FROM passkeys WHERE user_id = ?', [P.user.id]).catch(() => {});
  await pool.end();
}
console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK');
process.exit(fails ? 1 : 0);
