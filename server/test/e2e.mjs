import 'dotenv/config';
// Recorrido real en el navegador: conductor y pasajero (Chrome headless).
// Uso: npm run test:e2e   (servidor en :4000 y cliente de Vite corriendo; CLIENT_URL por defecto http://localhost:5174)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { registerUser } from './helpers.mjs';

const API = 'http://localhost:4000';
const CLIENT = process.env.CLIENT_URL || 'http://localhost:5174';
const SHOTS = process.env.SHOTS_DIR || path.join(process.cwd(), 'test', 'shots');
fs.mkdirSync(SHOTS, { recursive: true });

const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const FIXTURE_PATH = path.resolve(process.cwd(), 'test', 'fixtures', 'doc.jpg');
const rnd = String(Math.floor(Math.random() * 1e7)).padStart(7, '0');
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };

const post = async (p, b) => (await fetch(`${API}/api/${p}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b) })).json();
// El conductor se registra por API (con código); el pasajero lo hará por la pantalla, como un usuario real
const D = await registerUser({ name: 'E2E Driver', phone: `9${rnd}`, password: 'secreto1', role: 'driver', vehicle: 'Toyota Corolla blanco', plate: 'HCC9999' });
const passPhone = `8${rnd}`;

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];

async function openAs(session, geo, name) {
  const ctx = await browser.createBrowserContext();
  await ctx.overridePermissions(CLIENT, ['geolocation', 'clipboard-read', 'clipboard-write']);
  const page = await ctx.newPage();
  await page.setViewport({ width: 420, height: 860 });
  await page.setGeolocation(geo);
  // El menú nativo de compartir no se puede manejar en modo automático: se prueba la copia al portapapeles
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'share', { value: undefined });
    // El portapapeles real exige foco de la ventana; se captura el texto que la app intenta copiar
    navigator.clipboard.writeText = async (t) => { window.__copied = t; };
  });
  page.on('pageerror', (e) => errors.push(`[${name}] ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_/.test(m.text()) && errors.push(`[${name}] ${m.text()}`));
  page.on('dialog', (d) => d.accept()); // confirmaciones de "¿Cancelar?" etc.
  await page.goto(CLIENT, { waitUntil: 'domcontentloaded' });
  if (session) {
    await page.evaluate((s) => localStorage.setItem('jalon', JSON.stringify(s)), session);
    await page.reload({ waitUntil: 'domcontentloaded' });
  }
  return page;
}
const click = async (page, text, timeout = 15000) => {
  const el = await page.waitForSelector(`button::-p-text(${text}), a::-p-text(${text})`, { timeout });
  await el.click();
};
const see = (page, text, timeout = 15000) =>
  page.waitForSelector(`::-p-text(${text})`, { timeout }).then(() => true, () => false);
const shot = (page, name) => page.screenshot({ path: path.join(SHOTS, `${name}.png`) });

try {
  const driver = await openAs(D, { latitude: 14.073, longitude: -87.1925 }, 'conductor');
  const pass = await openAs(null, { latitude: 14.0723, longitude: -87.1921 }, 'pasajero');
  // Sesión de admin firmada con el JWT_SECRET del .env (así no hay contraseñas escritas en el código)
  const [[adm]] = await pool.query("SELECT id, name, phone FROM users WHERE role = 'superadmin' LIMIT 1");
  const adminLogin = { token: jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' }), user: { ...adm, role: 'superadmin', status: 'active' } };
  const admin = await openAs(adminLogin, { latitude: 14.07, longitude: -87.19 }, 'admin');
  await admin.setViewport({ width: 1100, height: 800 });

  // ---- Registro del pasajero por pantalla, con código por SMS ----
  await click(pass, '¿No tienes cuenta? Regístrate');
  await pass.type('input[placeholder="Nombre"]', 'E2E Pasajero');
  await pass.type('input[placeholder^="Teléfono"]', passPhone);
  await pass.type('input[placeholder="Contraseña"]', 'secreto1');
  await click(pass, 'Enviar código por SMS');
  check('sin aceptar los términos no se puede continuar', await see(pass, 'Debes aceptar los Términos'));
  await pass.click('.check.terms input');
  await click(pass, 'Enviar código por SMS');
  check('la pantalla pide el código del SMS', await see(pass, 'Te enviamos un código por SMS'));
  check('en desarrollo se muestra el código de prueba', await see(pass, 'Modo desarrollo'));
  await shot(pass, '0-codigo-sms');
  await click(pass, 'Verificar y crear cuenta');
  check('el pasajero queda registrado y entra', await see(pass, 'Historial'));

  // ---- Páginas legales y datos de la app instalable ----
  const legal = await browser.newPage();
  await legal.goto(`${CLIENT}/terminos`, { waitUntil: 'domcontentloaded' });
  check('página de términos de uso', await see(legal, '1. Qué es Jalón'));
  await legal.goto(`${CLIENT}/privacidad`, { waitUntil: 'domcontentloaded' });
  check('página de política de privacidad', await see(legal, '3. Con quién se comparten'));
  const manifest = await legal.evaluate(async () => {
    const link = document.querySelector('link[rel=manifest]');
    const m = await (await fetch(link.href)).json();
    const icons = await Promise.all(m.icons.map((i) => fetch(i.src).then((r) => r.status)));
    return { name: m.name, display: m.display, icons };
  });
  check('el manifiesto de la app es válido y sus íconos existen', manifest.name === 'Jalón' && manifest.display === 'standalone' && manifest.icons.length === 3 && manifest.icons.every((c) => c === 200));
  if (process.env.E2E_EXPECT_SW) {
    const sw = await legal.evaluate(async () => !!(await navigator.serviceWorker.ready).active);
    check('el service worker queda activo (app instalable)', sw);
  }
  await legal.close();

  // ---- Cambiar la contraseña desde Mi cuenta ----
  await click(pass, 'Cuenta');
  check('se abre Mi cuenta', await see(pass, 'Mi cuenta'));
  await pass.type('input[placeholder="Contraseña actual"]', 'secreto1');
  await pass.type('input[placeholder="Contraseña nueva"]', 'secreto2-nueva');
  await pass.type('input[placeholder="Repite la contraseña nueva"]', 'secreto2-nueva');
  await click(pass, 'Cambiar contraseña');
  check('contraseña cambiada desde la cuenta', await see(pass, 'Contraseña actualizada. Se cerraron tus otras sesiones.'));
  await shot(pass, '0d-mi-cuenta');
  await click(pass, 'Cerrar ✕');

  // ---- El conductor sube sus documentos y el admin lo aprueba ----
  check('conductor pendiente ve que debe subir documentos', await see(driver, 'Documentos para aprobar tu cuenta (0 de 3)'));
  const inputs = await driver.$$('.doc input[type=file]');
  check('hay 3 espacios para documentos', inputs.length === 3);
  for (let i = 0; i < 3; i++) {
    await (await driver.$$('.doc input[type=file]'))[i].uploadFile(FIXTURE_PATH);
    check(`documento ${i + 1} subido`, await see(driver, `(${i + 1} de 3)`, 20000));
  }
  await shot(driver, '0b-conductor-documentos');
  check('conductor ve el aviso de revisión', await see(driver, 'Listo: un administrador revisará'));

  // La solicitud aparece arriba, sin buscarla en ninguna pestaña
  check('el admin ve la solicitud del conductor en el panel de pendientes', await see(admin, 'Solicitudes de conductores por aprobar', 20000));
  await shot(admin, '0b2-admin-pendientes');
  await click(admin, 'Revisar documentos', 20000);
  check('admin ve las imágenes de los documentos', await admin.waitForSelector('.docimg', { timeout: 15000 }).then(() => true, () => false));
  await shot(admin, '0c-admin-documentos');
  await click(admin, 'Aprobar conductor');
  await driver.waitForFunction(() => [...document.querySelectorAll('button')].some((b) => b.textContent.includes('Ponerme disponible') && !b.disabled), { timeout: 15000 });
  check('al aprobarlo, el conductor ya puede ponerse disponible', true);
  check('al aprobarlo, la solicitud sale del panel', await admin.waitForFunction(() => !document.body.innerText.includes('Solicitudes de conductores por aprobar'), { timeout: 15000 }).then(() => true, () => false));

  check('conductor ve su pantalla', await see(driver, 'Ponerme disponible'));
  await click(driver, 'Ponerme disponible');
  check('conductor queda en línea', await see(driver, 'Solicitudes cercanas'));

  check('pasajero ve al conductor libre en el mapa', await see(pass, '1 conductor libre cerca', 20000));

  // Buscar el destino por nombre
  await pass.type('input[placeholder^="¿A dónde vas?"]', 'Mall Multiplaza Tegucigalpa');
  check('aparecen sugerencias de direcciones', await see(pass, 'Mall Multiplaza', 15000));
  await click(pass, 'Mall Multiplaza');
  check('muestra distancia, tiempo y precio sugerido', await see(pass, 'sugerido', 20000));
  check('muestra el botón para pedir', await see(pass, 'Pedir Jalón por'));
  await shot(pass, '1-pasajero-ruta');
  await click(pass, 'Pedir Jalón por');

  check('conductor recibe la solicitud con el destino', await see(driver, 'Destino: Mall Multiplaza'));
  await shot(driver, '2-conductor-solicitud');
  await click(driver, 'Aceptar L');
  check('pasajero recibe la oferta con datos del conductor', await see(pass, 'Toyota Corolla blanco'));
  await shot(pass, '3-pasajero-oferta');
  await pass.evaluate(() => [...document.querySelectorAll('.offer button.primary')][0].click());

  check('conductor ve el viaje aceptado', await see(driver, 'Ve a recoger al pasajero'));
  check('pasajero ve que el conductor va en camino', await see(pass, 'Tu conductor va en camino'));

  // Compartir viaje: se genera el enlace y se abre la página pública
  await click(pass, 'Compartir viaje');
  await see(pass, 'Enlace copiado');
  const clip = (await pass.evaluate(() => window.__copied)) || '';
  check('se copia el enlace para compartir', /\/t\/[\w-]{16,}$/.test(clip), clip);
  const tracker = await browser.newPage();
  await tracker.setViewport({ width: 420, height: 860 });
  await tracker.goto(clip.replace(/^https?:\/\/[^/]+/, CLIENT), { waitUntil: 'domcontentloaded' });
  check('familiar ve el viaje sin tener cuenta', await see(tracker, 'El conductor va en camino', 15000));
  check('familiar ve la placa del conductor', await see(tracker, 'HCC9999'));
  await shot(tracker, '4-seguimiento-publico');
  await tracker.close();

  // Emergencia
  await click(pass, 'Emergencia');
  check('pasajero recibe aviso de emergencia con el 911', await see(pass, 'Alerta enviada a soporte'));
  await shot(pass, '5-pasajero-sos');

  await click(driver, 'Ya llegué');
  await click(driver, 'Iniciar viaje');
  check('pasajero ve viaje en curso', await see(pass, 'Viaje en curso'));
  await click(driver, 'Finalizar viaje');

  check('pasajero puede calificar al terminar', await see(pass, '¿Cómo estuvo E2E Driver?'));
  await pass.evaluate(() => document.querySelectorAll('.starpick button')[4].click());
  await pass.type('input[placeholder^="Comentario"]', 'Muy buen servicio');
  await click(pass, 'Enviar calificación');
  check('calificación enviada', await see(pass, '¡Gracias por tu calificación!'));
  check('conductor puede calificar al pasajero', await see(driver, '¿Cómo estuvo E2E Pasajero?'));
  await shot(driver, '6-conductor-termino');

  // Historial
  await click(pass, 'Historial');
  check('historial muestra el viaje con la calificación', await see(pass, 'Mall Multiplaza') && (await see(pass, 'Tu calificación: ★★★★★')));
  await shot(pass, '7-historial');

  // Admin: ve la emergencia (la página ya estaba abierta y se actualiza sola)
  check('admin ve la alerta de emergencia', await see(admin, 'EMERGENCIA', 20000));
  await shot(admin, '8-admin');

  // ---- Personal: el superadmin crea a alguien de soporte y esa persona debe cambiar la contraseña temporal ----
  const staffPhone = `7${rnd}`;
  await click(admin, 'Personal');
  await admin.type('input[placeholder="Nombre"]', 'P5B Soporte UI');
  await admin.type('input[placeholder^="Teléfono"]', staffPhone);
  await click(admin, 'Crear cuenta');
  check('se muestra la contraseña temporal una sola vez', await see(admin, 'Solo se muestra ahora'));
  const tempPass = await admin.$eval('.temp', (el) => el.textContent.trim());
  check('la contraseña temporal tiene 10 caracteres', tempPass.length === 10);
  await shot(admin, '0e-contrasena-temporal');
  await click(admin, 'Listo, ya la anoté');

  const staffPage = await openAs(null, { latitude: 14.07, longitude: -87.19 }, 'soporte');
  await staffPage.type('input[placeholder^="Teléfono"]', staffPhone);
  await staffPage.type('input[placeholder="Contraseña"]', tempPass);
  await click(staffPage, 'Entrar');
  check('el personal nuevo debe cambiar la contraseña antes de entrar', await see(staffPage, 'Cambia tu contraseña para continuar'));
  await staffPage.type('input[placeholder="Contraseña actual"]', tempPass);
  await staffPage.type('input[placeholder="Contraseña nueva"]', 'soporte-clave-9');
  await staffPage.type('input[placeholder="Repite la contraseña nueva"]', 'soporte-clave-9');
  await click(staffPage, 'Cambiar contraseña');
  await staffPage.waitForSelector('.admin', { timeout: 15000 });
  check('después de cambiarla entra al panel', true);
  const tabs = await staffPage.$$eval('.seg button', (bs) => bs.map((b) => b.textContent));
  check('soporte solo ve Viajes y Usuarios (sin Personal ni Registro)', tabs.join(',') === 'Viajes,Usuarios', `(${tabs})`);
  await click(staffPage, 'Usuarios');
  await staffPage.waitForSelector('.ucard.click', { timeout: 15000 });
  await staffPage.click('.ucard.click');
  check('soporte abre la ficha de un usuario', await see(staffPage, 'Últimos viajes'));
  const supportActions = await staffPage.$$eval('.actions-bar button', (bs) => bs.map((b) => b.textContent)).catch(() => []);
  check('soporte no ve botones para editar, aprobar ni bloquear', supportActions.length === 0, `(${supportActions})`);
  await shot(staffPage, '0f-soporte-ficha');

  // El superadmin ve el movimiento en el registro
  await click(admin, 'Registro');
  check('el registro muestra que el superadmin creó la cuenta', await see(admin, 'Creó una cuenta del personal'));
  await shot(admin, '0g-registro');

  // ---- Recuperar contraseña por pantalla ----
  await click(pass, 'Cerrar ✕');
  await click(pass, 'Salir');
  await click(pass, '¿Olvidaste tu contraseña?');
  await pass.type('input[placeholder^="Teléfono"]', passPhone);
  await pass.type('input[placeholder="Nueva contraseña"]', 'clave-nueva-9');
  await click(pass, 'Enviar código por SMS');
  check('recuperación: pide el código', await see(pass, 'Te enviamos un código por SMS'));
  await click(pass, 'Cambiar contraseña');
  check('recuperación: contraseña actualizada', await see(pass, 'Contraseña actualizada'));
  // El teléfono se conserva en el formulario tras cambiar la contraseña; solo falta escribir la nueva
  await pass.type('input[placeholder="Contraseña"]', 'clave-nueva-9');
  await click(pass, 'Entrar');
  check('puede entrar con la contraseña nueva', await see(pass, 'Historial'));
} catch (e) {
  check('recorrido completo', false, e.message);
} finally {
  await browser.close();
  await pool.end();
}

check('sin errores de JavaScript en el navegador', errors.length === 0, errors.slice(0, 3).join(' | '));
console.log(fails ? `\n${fails} fallos (capturas en ${SHOTS})` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 300);
