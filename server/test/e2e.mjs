import 'dotenv/config';
// Recorrido real en el navegador: conductor y pasajero (Chrome headless).
// Uso: npm run test:e2e   (servidor en :4000 y cliente de Vite corriendo; CLIENT_URL por defecto http://localhost:5174)
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { registerUser, createTestSuperadmin, totpNow } from './helpers.mjs';

const API = process.env.API_URL || 'http://localhost:4000';
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
  page.on('dialog', (d) => d.accept(page.promptText || '')); // confirmaciones y cuadros de texto; page.promptText = lo que se escribe
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
  const adm = await createTestSuperadmin(pool);
  const adminLogin = { token: jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' }), user: { ...adm, role: 'superadmin', status: 'active' } };
  const admin = await openAs(adminLogin, { latitude: 14.07, longitude: -87.19 }, 'admin');
  await admin.setViewport({ width: 1100, height: 800 });

  // La comisión se activa con la cuenta de Jalón para transferencias (como lo haría el superadmin desde Ajustes)
  const putSettings = (body) => fetch(`${API}/api/admin/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminLogin.token}` }, body: JSON.stringify(body) }).then((r) => r.json());
  const cfg = await putSettings({ commission_enabled: true, commission_percent: 10, welcome_credit: 0, min_balance: 0, topup_min: 100, topup_max: 1000, bank_name: 'Banco de prueba', bank_account_type: 'Ahorros', bank_account: '12-345-678', bank_holder: 'Jalón S. de R.L.' });
  check('la comisión queda activa con los datos bancarios', cfg.commission_enabled === '1' && cfg.bank_account === '12-345-678');

  // ---- Registro del pasajero por pantalla, con código por SMS ----
  await click(pass, '¿No tienes cuenta? Regístrate');
  await pass.type('input[placeholder="Nombre"]', 'E2E Pasajero');
  await pass.type('input[placeholder^="Teléfono"]', passPhone);
  await pass.type('input[placeholder="Correo electrónico"]', `e2e${passPhone}@prueba.jalon.test`);
  await pass.type('input[placeholder="Contraseña"]', 'secreto1');
  check('la contraseña se oculta por defecto', (await pass.$eval('input[placeholder="Contraseña"]', (el) => el.type)) === 'password');
  await pass.click('.pw-eye');
  check('con el ojo se puede ver lo que se escribió', (await pass.$eval('input[placeholder="Contraseña"]', (el) => el.type + ':' + el.value)) === 'text:secreto1');
  await shot(pass, '0u-ver-contrasena');
  await pass.click('.pw-eye');
  check('y se vuelve a ocultar', (await pass.$eval('input[placeholder="Contraseña"]', (el) => el.type)) === 'password');
  await click(pass, 'Enviar código a mi correo');
  check('sin aceptar los términos no se puede continuar', await see(pass, 'Debes aceptar los Términos'));
  await pass.click('.check.terms input');
  await click(pass, 'Enviar código a mi correo');
  check('la pantalla pide el código enviado al correo', await see(pass, 'Te enviamos un código de 6 dígitos'));
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
  await pass.type('input[placeholder^="Nombre (ej."]', 'Mamá');
  await pass.type('input[placeholder="Teléfono (8 dígitos)"]', `71${rnd.slice(0, 6)}`);
  await click(pass, 'Agregar');
  check('se agrega un contacto de confianza a quien llegará el enlace del viaje', await see(pass, `71${rnd.slice(0, 6)}`));
  check('Mi cuenta ofrece descargar los datos y eliminar la cuenta', (await see(pass, 'Descargar mis datos')) && (await see(pass, 'Eliminar mi cuenta')));
  check('y cerrar la sesión en los demás dispositivos', await see(pass, 'Cerrar sesión en los demás dispositivos'));
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
  pass.promptText = 'Trabajo';
  await click(pass, 'Guardar este lugar');
  check('el destino queda guardado como "Trabajo"', await pass.waitForFunction(() => ![...document.querySelectorAll('button')].some((b) => b.textContent.includes('Guardar este lugar')), { timeout: 10000 }).then(() => true, () => false));
  pass.promptText = '';
  const basePrice = Number(await pass.$eval('.price input', (el) => el.value));
  await click(pass, 'Pedir Jalón por');
  // El pasajero sube su oferta mientras nadie acepta: el conductor ve el precio nuevo
  await click(pass, '+ L5');
  check('al subir el precio, el conductor ve la solicitud con el precio nuevo', await see(driver, `Aceptar L ${basePrice + 5}`));

  check('conductor recibe la solicitud con el destino', await see(driver, 'Destino: Mall Multiplaza'));
  check('y la dirección donde debe recogerlo', await see(driver, 'Recoger en:'));
  await click(driver, 'Ver ruta en el mapa');
  check('al pedirlo, el mapa muestra la ruta de la solicitud y su destino', (await see(driver, 'Ocultar ruta')) && !!(await driver.waitForSelector('path[stroke="#f59e0b"]', { timeout: 8000 }).catch(() => null)) && (await driver.$$('.leaflet-marker-icon')).length >= 3);
  await shot(driver, '0s-solicitud-ruta');
  await shot(driver, '2-conductor-solicitud');
  await click(driver, 'Aceptar L');
  check('pasajero recibe la oferta con datos del conductor', await see(pass, 'Toyota Corolla blanco'));
  check('la oferta muestra cuánto tiempo vale (cuenta regresiva)', await see(pass, 'vence en'));
  await shot(pass, '3-pasajero-oferta');
  await pass.evaluate(() => [...document.querySelectorAll('.offer button.primary')][0].click());

  check('conductor ve el viaje aceptado', await see(driver, 'Ve a recoger al pasajero'));
  check('pasajero ve que el conductor va en camino', await see(pass, 'Tu conductor va en camino'));
  check('el pasajero ve en cuántos minutos llega su conductor', await see(pass, 'Tu conductor llega en', 25000));
  check('el conductor ve cuánto falta para llegar al pasajero', await see(driver, 'Al pasajero', 25000));
  const links = await driver.$$eval('.nav a', (as) => as.map((a) => a.href));
  check('el conductor tiene botones para navegar con Waze y Google Maps hacia el pasajero', links.length === 2 && links[0].startsWith('https://waze.com/ul?ll=14.07') && links[1].startsWith('https://www.google.com/maps/dir/?api=1&destination=14.07'), `(${links.map((l) => l.slice(0, 40)).join(' | ')})`);
  await shot(driver, '0m-conductor-eta');

  // ---- Chat entre pasajero y conductor (sin teléfonos) ----
  check('no hay teléfonos ni botones de llamada a la vista', (await pass.$$('a[href^="tel:"]')).length === 0 && (await driver.$$('a[href^="tel:"]')).length === 0);
  await click(pass, 'Chat');
  await pass.type('input[placeholder="Escribe un mensaje"]', 'Hola, ya salgo');
  await click(pass, 'Enviar');
  check('el conductor ve el aviso de mensaje nuevo en el botón del chat', await see(driver, 'Chat (1)'));
  await click(driver, 'Chat (1)');
  check('el conductor lee el mensaje', await see(driver, 'Hola, ya salgo'));
  await click(driver, 'Estoy afuera'); // respuesta rápida
  check('el pasajero recibe la respuesta rápida del conductor', await see(pass, 'Estoy afuera'));
  await pass.type('input[placeholder="Escribe un mensaje"]', '<b>negrita</b><img src=x onerror=alert(1)>');
  await click(pass, 'Enviar');
  check('un mensaje con código se ve como texto, no se ejecuta', await see(driver, '<b>negrita</b>'));
  check('y no creó elementos de verdad en la pantalla', (await driver.$$('.bubble b, .bubble img')).length === 0);
  await shot(driver, '0k-chat-conductor');
  await click(driver, 'Chat');
  await click(pass, 'Chat');

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

  // ---- Mapa en vivo: el superadmin ve al conductor conectado y su ficha de rendimiento ----
  await click(admin, 'Mapa en vivo');
  check('el mapa en vivo muestra al conductor conectado con su placa y en viaje', await admin.waitForSelector('.monmap .mk .plate', { timeout: 15000 }).then(() => true, () => false) && (await see(admin, 'HCC9999') && await see(admin, 'En viaje')));
  await shot(admin, '0q-mapa-en-vivo');
  await click(admin, 'E2E Driver');
  check('al elegirlo aparece su ficha con los viajes de los últimos 30 días', (await see(admin, 'Últimos 30 días')) && (await see(admin, 'Ofertas aceptadas')));
  await shot(admin, '0r-ficha-conductor');
  check('pasajero ve viaje en curso', await see(pass, 'Viaje en curso'));
  await click(driver, 'Finalizar viaje');

  check('pasajero puede calificar al terminar', await see(pass, '¿Cómo estuvo E2E Driver?'));
  await pass.evaluate(() => document.querySelectorAll('.starpick button')[4].click());
  await pass.type('input[placeholder^="Comentario"]', 'Muy buen servicio');
  await click(pass, 'Enviar calificación');
  check('calificación enviada', await see(pass, '¡Gracias por tu calificación!'));
  check('conductor puede calificar al pasajero', await see(driver, '¿Cómo estuvo E2E Pasajero?'));
  // ---- Saldo: se descontó la comisión del viaje y el conductor recarga con un comprobante ----
  const commission = ((basePrice + 5) * 0.1).toFixed(2);
  check('al terminar el viaje se descuenta la comisión (10%) del saldo del conductor', await see(driver, `Saldo: L -${commission}`, 20000));
  check('con el saldo bajo el mínimo, avisa que debe recargar', await see(driver, 'Tu saldo está por debajo del mínimo'));
  await click(driver, 'Recargar');
  check('el conductor ve a qué cuenta transferir', (await see(driver, 'Banco de prueba')) && (await see(driver, '12-345-678')) && (await see(driver, 'Jalón S. de R.L.')));
  await driver.type('input[placeholder^="Monto transferido"]', '200');
  await driver.type('input[placeholder^="Banco desde"]', 'BAC Credomatic');
  await driver.type('input[placeholder^="Número de referencia"]', `E2E-${rnd}`);
  await (await driver.$('.overlay input[type=file]')).uploadFile(FIXTURE_PATH);
  await shot(driver, '0o-recarga');
  await click(driver, 'Enviar para aprobación');
  check('el conductor envía su comprobante', await see(driver, 'Recibimos tu comprobante'));
  check('y lo ve "En revisión"', await see(driver, 'En revisión'));
  await click(driver, 'Cerrar ✕');

  check('el personal ve el aviso de una recarga esperando aprobación', await see(admin, 'esperando tu aprobación', 20000));
  await click(admin, 'Revisar');
  check('y el comprobante con los datos de la transferencia', (await see(admin, `E2E-${rnd}`)) && !!(await admin.waitForSelector('.docimg', { timeout: 15000 }).catch(() => null)));
  await shot(admin, '0p-admin-recarga');
  admin.promptText = '200';
  await click(admin, 'Aprobar y acreditar');
  check('la recarga sale de la lista de pendientes al aprobarla', await admin.waitForFunction(() => !document.body.innerText.includes('Aprobar y acreditar'), { timeout: 15000 }).then(() => true, () => false));
  admin.promptText = '';
  check('el conductor ve su saldo nuevo al instante (sin recargar la pantalla)', await see(driver, `Saldo: L ${(200 - Number(commission)).toFixed(2)}`, 15000));
  await click(admin, 'Viajes');

  // El pasajero reporta un objeto olvidado
  await click(pass, 'Reportar un problema con este viaje');
  await pass.select('select[aria-label="Tipo de problema"]', 'lost_item');
  await pass.type('textarea', 'Dejé mi celular negro en el asiento de atrás');
  await click(pass, 'Enviar reporte');
  check('el pasajero envía el reporte', await see(pass, 'Recibimos tu reporte'));
  await click(pass, 'Listo');
  await click(pass, 'Nuevo viaje');
  check('el lugar guardado aparece como atajo en el viaje siguiente', await see(pass, '⭐ Trabajo'));
  await click(pass, '⭐ Trabajo');
  check('al tocarlo se llena el destino y se calcula la ruta', await see(pass, 'sugerido', 20000));
  await shot(driver, '6-conductor-termino');

  // Historial
  await click(pass, 'Historial');
  check('historial muestra el viaje con la calificación', await see(pass, 'Mall Multiplaza') && (await see(pass, 'Tu calificación: ★★★★★')));
  await shot(pass, '7-historial');
  await click(pass, 'Recibo');
  check('el recibo muestra número, conductor y total', (await see(pass, 'Comprobante de viaje')) && (await see(pass, 'JAL-')) && (await see(pass, 'E2E Driver')));
  await shot(pass, '7b-recibo');
  await pass.click('.overlay.top .overlay-head .link'); // cierra el recibo (no el historial)

  // Admin: ve la emergencia (la página ya estaba abierta y se actualiza sola)
  check('admin ve la alerta de emergencia', await see(admin, 'EMERGENCIA', 20000));
  await click(admin, 'Ver chat del viaje');
  check('el personal lee el chat del viaje con la emergencia', await see(admin, 'Hola, ya salgo'));
  await shot(admin, '0l-admin-chat');
  await click(admin, 'Cerrar ✕');
  await shot(admin, '8-admin');

  // ---- El superadmin agrega a un pasajero desde Usuarios ----
  await click(admin, 'Usuarios');
  await click(admin, 'Agregar pasajero');
  await admin.type('input[placeholder="Nombre"]', 'P10 Creado');
  await admin.type('input[placeholder^="Teléfono"]', `6${rnd}`);
  await click(admin, 'Crear cuenta');
  check('al agregar un pasajero se muestra su contraseña temporal una sola vez', await see(admin, 'Solo se muestra ahora'));
  await shot(admin, '0t-pasajero-creado');
  await click(admin, 'Listo, ya la anoté');
  check('y el pasajero aparece en la lista de usuarios', await see(admin, 'P10 Creado'));

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

  // El personal debe activar la verificación en dos pasos antes de ver el panel
  check('el personal debe activar la verificación en dos pasos antes de usar el panel', await see(staffPage, 'Activa la verificación en dos pasos'));
  await staffPage.waitForSelector('img.qr', { timeout: 15000 });
  const secret = await staffPage.$eval('[data-testid="secret"]', (el) => el.textContent.trim());
  check('se muestra el código QR y la clave para escribirla a mano', /^[A-Z2-7]{32}$/.test(secret));
  await shot(staffPage, '0h-activar-2fa');
  await staffPage.type('input[placeholder="Código de 6 dígitos"]', totpNow(secret));
  await click(staffPage, 'Activar');
  check('se muestran los códigos de respaldo', await see(staffPage, 'Guarda tus códigos de respaldo'));
  const backupCodes = await staffPage.$$eval('[data-testid="backup-codes"] code', (els) => els.map((e) => e.textContent));
  check('son 10 códigos con el formato XXXX-XXXX', backupCodes.length === 10 && backupCodes.every((c) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(c)));
  check('no se puede continuar sin confirmar que se guardaron', await staffPage.$eval('button.primary', (b) => b.disabled));
  await staffPage.click('.overlay-body .check input');
  await shot(staffPage, '0i-codigos-respaldo');
  await click(staffPage, 'Continuar al panel');
  await staffPage.waitForSelector('.admin', { timeout: 15000 });
  check('después de activarla entra al panel', true);
  const tabs = await staffPage.$$eval('.seg button', (bs) => bs.map((b) => b.textContent));
  check('soporte ve Viajes, Usuarios y Reportes, pero no Personal, Registro, Recargas ni Ajustes', tabs[0] === 'Viajes' && tabs[1] === 'Usuarios' && tabs.some((t) => t.startsWith('Reportes')) && !tabs.some((t) => /Personal|Registro|Recargas|Ajustes/.test(t)), `(${tabs})`);
  await click(staffPage, 'Usuarios');
  await staffPage.waitForSelector('.ucard.click', { timeout: 15000 });
  await staffPage.click('.ucard.click');
  check('soporte abre la ficha de un usuario', await see(staffPage, 'Últimos viajes'));
  const supportActions = await staffPage.$$eval('.actions-bar button', (bs) => bs.map((b) => b.textContent)).catch(() => []);
  check('soporte no ve botones para editar, aprobar ni bloquear', supportActions.length === 0, `(${supportActions})`);
  await shot(staffPage, '0f-soporte-ficha');

  // Volver a entrar: ahora pide el segundo paso (se usa un código de respaldo porque el de la app ya se usó al activarla)
  await click(staffPage, 'Cerrar ✕'); // la ficha del usuario sigue abierta y tapa el botón Salir
  await click(staffPage, 'Salir');
  await staffPage.type('input[placeholder^="Teléfono"]', staffPhone);
  await staffPage.type('input[placeholder="Contraseña"]', 'soporte-clave-9');
  await click(staffPage, 'Entrar');
  check('al volver a entrar pide la verificación en dos pasos', await see(staffPage, 'Escribe el código de 6 dígitos de tu app'));
  await shot(staffPage, '0j-segundo-paso');
  await staffPage.type('input[placeholder="Código"]', 'AAAA-BBBB');
  await click(staffPage, 'Verificar');
  check('un código equivocado no deja entrar', await see(staffPage, 'Código incorrecto'));
  await staffPage.$eval('input[placeholder="Código"]', (el) => el.select()); // seleccionar lo escrito para reemplazarlo
  await staffPage.type('input[placeholder="Código"]', backupCodes[0]);
  await click(staffPage, 'Verificar');
  await staffPage.waitForSelector('.admin', { timeout: 15000 });
  check('con un código de respaldo entra al panel', true);

  // El superadmin puede restablecer la verificación de esa persona si pierde el teléfono
  await click(admin, 'Personal');
  await click(admin, 'P5B Soporte UI');
  check('el superadmin ve el botón para restablecer la verificación en dos pasos', await see(admin, 'Restablecer verificación en dos pasos'));
  await click(admin, 'Cerrar ✕');

  // El superadmin ve el movimiento en el registro
  await click(admin, 'Registro');
  check('el registro muestra que el superadmin creó la cuenta', await see(admin, 'Creó una cuenta del personal'));
  await shot(admin, '0g-registro');

  // ---- Reportes: el personal responde y la persona lo ve en su historial ----
  await click(admin, 'Reportes');
  check('el personal ve el reporte con el tipo y el texto', (await see(admin, 'Objeto olvidado')) && (await see(admin, 'Dejé mi celular negro')));
  await shot(admin, '0n-admin-reportes');
  admin.promptText = 'Ya hablamos con el conductor, te devolverá el celular hoy';
  await click(admin, 'Marcar como resuelto');
  check('al resolverlo sale de la lista de abiertos', await admin.waitForFunction(() => !document.body.innerText.includes('Dejé mi celular negro'), { timeout: 15000 }).then(() => true, () => false));
  admin.promptText = '';
  await click(pass, 'Cerrar ✕');
  await click(pass, 'Historial');
  check('la persona ve la respuesta del personal en "Mis reportes"', (await see(pass, 'Mis reportes')) && (await see(pass, 'te devolverá el celular hoy')));

  // ---- Recuperar contraseña por pantalla ----
  await click(pass, 'Cerrar ✕');
  await click(pass, 'Salir');
  await click(pass, '¿Olvidaste tu contraseña?');
  await pass.type('input[placeholder^="Teléfono"]', passPhone);
  await pass.type('input[placeholder="Nueva contraseña"]', 'clave-nueva-9');
  await click(pass, 'Enviar código a mi correo');
  check('recuperación: pide el código', await see(pass, 'enviamos un código al correo registrado'));
  await click(pass, 'Cambiar contraseña');
  check('recuperación: contraseña actualizada', await see(pass, 'Contraseña actualizada'));
  // El teléfono se conserva en el formulario tras cambiar la contraseña; solo falta escribir la nueva
  await pass.type('input[placeholder="Contraseña"]', 'clave-nueva-9');
  await click(pass, 'Entrar');
  check('puede entrar con la contraseña nueva', await see(pass, 'Historial'));
} catch (e) {
  check('recorrido completo', false, e.message);
} finally {
  await fetch(`${API}/api/admin/settings`, { method: 'PUT', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ id: (await pool.query("SELECT id FROM users WHERE name = 'T Superadmin' ORDER BY id DESC LIMIT 1"))[0][0]?.id || 0, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '5m' })}` }, body: JSON.stringify({ commission_enabled: false, welcome_credit: 0, min_balance: 0 }) }).catch(() => {});
  await browser.close();
  await pool.end();
}

// El 401 del código de verificación equivocado que la prueba escribe a propósito es esperado
const unexpected = errors.filter((e) => !/^\[soporte\] Failed to load resource: .*401/.test(e));
check('sin errores de JavaScript en el navegador', unexpected.length === 0, unexpected.slice(0, 3).join(' | '));
console.log(fails ? `\n${fails} fallos (capturas en ${SHOTS})` : '\nTodo OK');
process.exitCode = fails ? 1 : 0;
setTimeout(() => process.exit(process.exitCode), 300);
