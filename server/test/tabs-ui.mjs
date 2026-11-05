import 'dotenv/config';
// Pantallas por pestañas: la ficha de usuario del panel, Mi cuenta y Referidos.
// Uso: web en CLIENT_URL y API_URL (servidor de pruebas). VIEW_W/VIEW_H cambian el tamaño (por defecto, celular).
import puppeteer from 'puppeteer-core';
import fs from 'fs';
import path from 'path';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { http, registerUser, uploadDocs, createTestSuperadmin } from './helpers.mjs';

const CLIENT = process.env.CLIENT_URL || 'http://localhost:4000';
const SHOTS = process.env.SHOTS_DIR || '';
const W = Number(process.env.VIEW_W) || 390;
const H = Number(process.env.VIEW_H) || 844;
const chrome = ['C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const tag = `${W < 700 ? 'cel' : 'pc'}${process.env.THEME ? `-${process.env.THEME}` : ''}`;
const shot = (page, name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `${name}-${tag}.png`) });

const adm = await createTestSuperadmin(pool);
const SA = jwt.sign({ id: adm.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
const P = await registerUser({ name: 'Tania Tabs', phone: `85${rnd}1`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
const D = await registerUser({ name: 'Diego Tabs', phone: `95${rnd}2`.slice(0, 8), password: 'Cielo-azul-77', role: 'driver', vehicle: 'Yaris', plate: `HT${rnd.slice(0, 4)}` });
await uploadDocs(D.token);
await http('POST', `admin/users/${D.user.id}/status`, SA, { status: 'active' });
const staff = await http('POST', 'admin/staff', SA, { name: 'Sofi Tabs', phone: `94${rnd}3`.slice(0, 8), role: 'support' });

const browser = await puppeteer.launch({ executablePath: chrome, headless: true, args: ['--no-sandbox'] });
const errors = [];
async function open(session) {
  const ctx = await browser.createBrowserContext();
  const page = await ctx.newPage();
  await page.setViewport({ width: W, height: H });
  if (process.env.THEME) await page.emulateMediaFeatures([{ name: 'prefers-color-scheme', value: process.env.THEME }]);
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
const visible = (page, t) => page.evaluate((x) => document.body.innerText.includes(x), t);
const tabs = (page) => page.$$eval('.page-tabs [role="tab"]', (b) => b.map((x) => x.textContent.trim()));
const tabTo = async (page, text) => { await (await page.waitForSelector(`.page-tabs [role="tab"]::-p-text(${text})`)).click(); await wait(250); };
const wide = (page) => page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1);
async function adminSection(page, label) {
  await page.waitForSelector('nav.sidebar, button.menu-btn', { timeout: 20000 });
  if (!(await page.$('nav.sidebar'))) { await (await page.$('button.menu-btn')).evaluate((b) => b.click()); await page.waitForSelector('.drawer'); await wait(400); }
  await (await page.waitForSelector(`:is(.drawer, nav.sidebar) button ::-p-text(${label}), :is(.drawer, nav.sidebar) button::-p-text(${label})`, { timeout: 15000 })).evaluate((b) => b.closest("button").click());
  await wait(500);
}
async function openUser(page, name, where = 'Usuarios') {
  await adminSection(page, where);
  const q = where === 'Usuarios' && await page.waitForSelector('input[aria-label^="Buscar"]', { timeout: 15000 });
  if (q) { await q.click({ clickCount: 3 }); await q.type(name); }
  await wait(900);
  await (await page.waitForSelector(`.ucard.click ::-p-text(${name})`, { timeout: 15000 })).evaluate((e) => e.closest('.ucard').click());
  await page.waitForSelector('.overlay .page-tabs', { timeout: 15000 });
  await wait(300);
}

try {
  // ---------- Ficha de un conductor ----------
  const admin = await open({ token: SA, user: { ...adm, role: 'superadmin', status: 'active' } });
  await openUser(admin, 'Diego Tabs');
  const dt = await tabs(admin);
  check('la ficha de un conductor tiene Resumen, Vehículo, Saldo, Viajes e Historial', ['Resumen', 'Vehículo', 'Saldo', 'Viajes', 'Historial'].every((t) => dt.some((x) => x.includes(t))) && !dt.some((x) => x.includes('Permisos')), dt.join(' | '));
  check('empieza en Resumen con las acciones', (await visible(admin, 'Restablecer contraseña')) && !(await visible(admin, 'Últimos viajes')));
  await shot(admin, 'tabs-ficha-resumen');
  await tabTo(admin, 'Vehículo');
  check('Vehículo muestra la placa y el botón para editar', (await visible(admin, `HT${rnd.slice(0, 4)}`)) && (await visible(admin, 'Editar vehículo')));
  await tabTo(admin, 'Saldo');
  check('Saldo muestra el saldo y el ajuste', (await visible(admin, 'Saldo: L')) && (await visible(admin, 'Ajustar saldo')));
  await tabTo(admin, 'Viajes');
  check('Viajes muestra sus últimos viajes', await visible(admin, 'Últimos viajes'));
  await tabTo(admin, 'Historial');
  check('Historial muestra lo que hizo el personal', (await visible(admin, 'Movimientos del personal')) && (await visible(admin, 'Aprobó al conductor')));
  await shot(admin, 'tabs-ficha-historial');
  check('la ficha no se sale de la pantalla', !(await wide(admin)));
  await (await admin.$('.overlay button.link::-p-text(Cerrar)')).click();
  await wait(400);

  // ---------- Ficha de alguien del personal: Permisos ----------
  check('se creó la cuenta del personal', !!staff.id, JSON.stringify(staff.error || ''));
  await openUser(admin, 'Sofi Tabs', 'Personal');
  const st = await tabs(admin);
  check('la ficha del personal tiene Permisos y no Vehículo', st.some((x) => x.includes('Permisos')) && !st.some((x) => x.includes('Vehículo')), st.join(' | '));
  await tabTo(admin, 'Permisos');
  check('Permisos muestra los módulos de esa persona', await visible(admin, 'Permisos de esta persona'));
  await shot(admin, 'tabs-ficha-permisos');
  await (await admin.$('.overlay button.link::-p-text(Cerrar)')).click();
  await wait(400);

  // ---------- Referidos ----------
  await adminSection(admin, 'Referidos');
  await admin.waitForSelector('.page-tabs');
  const rt = await tabs(admin);
  check('Referidos tiene Invitaciones y Reglas', rt.some((x) => x.includes('Invitaciones')) && rt.some((x) => x.includes('Reglas')), rt.join(' | '));
  check('empieza en Invitaciones', (await visible(admin, 'Invitaciones')) && !(await visible(admin, 'Premio para quien invita')));
  await tabTo(admin, 'Reglas');
  check('Reglas tiene el formulario', await visible(admin, 'Premio para quien invita'));
  await shot(admin, 'tabs-referidos-reglas');

  // ---------- Mi cuenta: pasajero ----------
  const pp = await open({ token: P.token, user: P.user });
  await (await pp.waitForSelector('button.avatar-btn', { timeout: 20000 })).evaluate((b) => b.click());
  await (await pp.waitForSelector('.profile-pop [role="menuitem"]::-p-text(Mi perfil)')).click();
  await pp.waitForSelector('.page-tabs');
  await wait(500);
  const pt = await tabs(pp);
  check('Mi cuenta del pasajero tiene Perfil, Mis viajes, Seguridad y Mis datos', ['Perfil', 'Mis viajes', 'Seguridad', 'Mis datos'].every((t) => pt.some((x) => x.includes(t))), pt.join(' | '));
  check('Perfil tiene el sexo y las notificaciones', (await visible(pp, 'Sexo (opcional)')) && (await visible(pp, 'Notificaciones')) && !(await visible(pp, 'Cambiar contraseña')));
  await shot(pp, 'tabs-cuenta-perfil');
  await tabTo(pp, 'Mis viajes');
  check('Mis viajes tiene el PIN, los contactos y los lugares', await visible(pp, 'Usar PIN en mis viajes'));
  await tabTo(pp, 'Seguridad');
  check('Seguridad tiene la contraseña y las sesiones', (await visible(pp, 'Cambiar contraseña')) && (await visible(pp, 'Cerrar sesión en los demás dispositivos')));
  await shot(pp, 'tabs-cuenta-seguridad');
  await tabTo(pp, 'Mis datos');
  check('Mis datos tiene descargar y eliminar', (await visible(pp, 'Descargar mis datos')) && (await visible(pp, 'Eliminar mi cuenta')));
  check('Cerrar sesión sigue a la vista en cualquier pestaña', await visible(pp, 'Cerrar sesión'));
  check('Mi cuenta no se sale de la pantalla', !(await wide(pp)));

  // ---------- Mi cuenta: conductor (sin «Mis viajes») ----------
  const pd = await open({ token: D.token, user: D.user });
  await (await pd.waitForSelector('button.avatar-btn', { timeout: 20000 })).evaluate((b) => b.click());
  await (await pd.waitForSelector('.profile-pop [role="menuitem"]::-p-text(Mi perfil)')).click();
  await pd.waitForSelector('.page-tabs');
  const ct = await tabs(pd);
  check('Mi cuenta del conductor no tiene «Mis viajes»', !ct.some((x) => x.includes('Mis viajes')) && ct.some((x) => x.includes('Seguridad')), ct.join(' | '));
  check('sin errores de JavaScript', !errors.length, errors.join(' | '));
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
} finally {
  await browser.close();
}
await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
