import 'dotenv/config';
// Barra «Actualizar»: aparece cuando el servidor publica otra versión y recarga la app. Uso: npm run test:update (web compilada en CLIENT_URL)
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CLIENT = process.env.CLIENT_URL || 'http://localhost:4000';
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  const real = await (await fetch(`${CLIENT}/version.json`)).json().catch(() => null);
  check('el servidor publica /version.json con el número de la versión', !!real?.build, `(${real?.build})`);

  // Con la misma versión no aparece nada
  await page.goto(CLIENT, { waitUntil: 'networkidle2' });
  await new Promise((r) => setTimeout(r, 800));
  check('con la versión al día no aparece la barra', !(await page.$('.update-bar')));

  // El servidor «publica» otra versión: la barra aparece al volver a la app
  let fake = true;
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    if (fake && new URL(req.url()).pathname === '/version.json') return req.respond({ status: 200, contentType: 'application/json', body: JSON.stringify({ build: 'version-nueva' }) });
    req.continue();
  });
  const comeBack = () => page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));
  await comeBack();
  const bar = await page.waitForSelector('.update-bar', { timeout: 5000 }).catch(() => null);
  check('con una versión nueva aparece «Hay una versión nueva» con el botón Actualizar', !!bar && (await page.$eval('.update-bar', (b) => b.textContent)).includes('Actualizar'));
  if (process.env.SHOTS_DIR) { await new Promise((r) => setTimeout(r, 500)); await page.screenshot({ path: `${process.env.SHOTS_DIR}/u-barra-actualizar.png` }); }

  // «Más tarde» la esconde; vuelve en la siguiente revisión
  await (await page.$('.update-bar ::-p-text(Más tarde)')).click();
  check('«Más tarde» la esconde', !(await page.$('.update-bar')));
  await comeBack();
  check('vuelve a salir en la siguiente revisión', !!(await page.waitForSelector('.update-bar', { timeout: 5000 }).catch(() => null)));

  // «Actualizar» recarga la app (ya con la versión publicada de verdad)
  fake = false;
  const reloaded = page.waitForNavigation({ timeout: 10000 }).then(() => true, () => false);
  await (await page.$('.update-bar ::-p-text(Actualizar)')).click();
  check('«Actualizar» recarga la app', await reloaded);
  await new Promise((r) => setTimeout(r, 800));
  check('después de actualizar ya no aparece la barra', !(await page.$('.update-bar')));
} finally {
  await Promise.race([browser.close(), new Promise((r) => setTimeout(r, 8000))]); // en Windows a veces no termina de cerrar
}
console.log(fails ? `\n${fails} FALLAS` : '\nTodo OK');
process.exit(fails ? 1 : 0);
