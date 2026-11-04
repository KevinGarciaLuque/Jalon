// Errores en la pantalla: la app los reporta al servidor y, si una pantalla falla, muestra «Algo salió mal» con «Recargar».
// Uso: con la app compilada servida en CLIENT_URL (npm --prefix client run build y el servidor encendido)
import puppeteer from 'puppeteer-core';
import fs from 'fs';

const CLIENT = process.env.CLIENT_URL || 'http://localhost:4000';
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
try {
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844 });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
  const posts = [];
  page.on('request', (r) => r.url().includes('/api/client-errors') && posts.push(JSON.parse(r.postData())));
  await page.goto(CLIENT, { waitUntil: 'networkidle2' });

  // Un error suelto de la app (como si fallara un botón)
  // (los scripts que inyecta Puppeteer el navegador los trata como de otro sitio y oculta su mensaje: se simula el aviso como lo da la app)
  const fire = (kind, message) => page.evaluate((kind, message) => {
    const error = new Error(message);
    if (kind === 'promise') window.dispatchEvent(new PromiseRejectionEvent('unhandledrejection', { promise: Promise.resolve(), reason: error }));
    else window.dispatchEvent(new ErrorEvent('error', { error, message }));
  }, kind, message);
  await fire('error', 'Prueba de botón que falla');
  await fire('promise', 'Prueba de promesa sin atender');
  await fire('error', 'Prueba de botón que falla'); // repetido: no se manda otra vez
  await fire('error', 'Script error.'); // de otro sitio: no se manda
  await wait(800);
  check('reporta el error del botón', posts.some((p) => p.kind === 'error' && p.message === 'Prueba de botón que falla'));
  check('reporta la promesa sin atender', posts.some((p) => p.kind === 'promise' && p.message === 'Prueba de promesa sin atender'));
  check('el mismo error se manda una sola vez', posts.filter((p) => p.message === 'Prueba de botón que falla').length === 1);
  check('ignora los errores de otros sitios', !posts.some((p) => /Script error/.test(p.message)));
  check('lleva la versión y la página', posts.every((p) => p.version && p.page === '/'));

  // La pantalla de respaldo: se activa como lo haría React al fallar una pantalla
  await page.evaluate(() => {
    const el = document.querySelector('#root');
    let f = el[Object.keys(el).find((k) => k.startsWith('__reactContainer'))];
    while (f && !f.type?.getDerivedStateFromError) f = f.child;
    f.stateNode.setState({ failed: true });
  });
  await wait(500);
  const text = await page.evaluate(() => document.body.innerText);
  check('muestra «Algo salió mal» en vez de quedar en blanco', text.includes('Algo salió mal') && text.includes('Recargar'));
  if (process.env.SHOTS_DIR) await page.screenshot({ path: `${process.env.SHOTS_DIR}/crash${process.env.THEME ? `-${process.env.THEME}` : ''}.png` });
  await (await page.waitForSelector('.crash button')).click();
  await page.waitForNavigation({ waitUntil: 'networkidle2' });
  check('«Recargar» vuelve a abrir la app', !(await page.evaluate(() => document.body.innerText)).includes('Algo salió mal'));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
}
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
