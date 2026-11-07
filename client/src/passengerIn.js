// Animación al activar el modo pasajero: aparece el aviso (suena «transicion») con el carro, que se va (suena «carrofuera»);
// en su lugar queda el pin, que sale del aviso, cae sobre el mapa y aterriza en tu ubicación (suena «ding»),
// donde se convierte en el pin del mapa. Va aparte (se descarga solo al cambiar de modo).
// Si algo falla, la promesa se rechaza y la app muestra el aviso normal. Nada de esto toca el mapa ni el GPS.
// Igual que la del conductor: solo se animan transform y opacity, y toda la secuencia se programa de una vez.
import imgSide from './assets/drive-34.webp';
import { preloadSfx, sfxOn, setSfx, sfxPlayer } from './sfx.js';

// La imagen del carro se baja y se prepara antes de empezar; los sonidos decodificados también
// (si tardan más de 1,2 s, la animación sigue sin ellos)
export function preload() {
  const img = new Image();
  img.decoding = 'async';
  img.src = imgSide;
  return Promise.all([img.decode().then(() => img), Promise.race([preloadSfx(), new Promise((r) => setTimeout(r, 1200))])]).then(([i]) => i);
}

// Si «transicion» o «ding» todavía no están listos, se usan estos sonidos hechos en el momento
function blip(player, at, from, to, dur, peak) {
  const ctx = player.ctx;
  if (!ctx) return;
  const t = ctx.currentTime + at;
  const o = ctx.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(player.master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

// El pin del pasajero, igual al del mapa (punta abajo)
const PIN_SVG = `<svg viewBox="0 0 34 44" width="34" height="44" aria-hidden="true">
  <path d="M17 43s-14-15.2-14-25.5a14 14 0 0 1 28 0C31 27.8 17 43 17 43z" fill="#14802f" stroke="#fff" stroke-width="2"/>
  <circle cx="17" cy="17.5" r="8.5" fill="#fff"/><circle cx="17" cy="17.5" r="4" fill="#14802f"/></svg>`;
const PIN_W = 34;
const PIN_H = 44;
const BOX = 240; // la caja del carro mide BOX × BOX px (la imagen cabe dentro)
const CAR_GO = 700; // cuándo arranca el carro, desde que aparece el aviso (ms)
const CAR_LEAVE = 650; // cuánto tarda en irse (ms)
const PIN_IN = CAR_GO + 350; // cuándo aparece el pin donde estaba el carro (ms)

// El pin del mapa (el del pasajero, con su aura): su punta es el punto exacto de tu ubicación
const findMarker = () => document.querySelector('.leaflet-marker-icon.pin[class*=" me-"]');
function markerTip(el) {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.bottom - 1 };
}
// Sin el pin todavía (el GPS no ha dado la posición): el centro de la parte del mapa que se ve
function mapCenter() {
  const map = document.querySelector('.screen .map');
  const sheet = document.querySelector('.screen .sheet');
  if (!map) return { x: innerWidth / 2, y: innerHeight * 0.45 };
  const r = map.getBoundingClientRect();
  const covered = sheet && getComputedStyle(sheet).position === 'absolute' ? sheet.offsetHeight : 0;
  return { x: r.left + r.width / 2, y: r.top + (r.height - covered) / 2 + PIN_H / 2 };
}
const waitFor = (fn, ms) => new Promise((res) => {
  const t0 = performance.now();
  const tick = () => { const v = fn(); if (v || performance.now() - t0 > ms) res(v || null); else requestAnimationFrame(tick); };
  tick();
});
const el = (tag, cls, parent, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; parent?.appendChild(e); return e; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const lerp = (a, b, k) => a + (b - a) * k;
// (x, y) es la PUNTA del pin; la escala crece/encoge alrededor de la punta
const pos = (p, s, sx = 1, sy = 1) => `translate3d(${p.x}px, ${p.y}px, 0) translate(-50%, -100%) scale(${s * sx}, ${s * sy})`;

/**
 * Corre la animación completa (unos 3 s). Resuelve al terminar (o si la persona toca para saltarla).
 * `audio`: el AudioContext creado en el toque
 */
export async function playPassengerIn({ audio }) {
  const side = await Promise.race([preload(), sleep(2500).then(() => { throw new Error('imagen lenta'); })]);
  const sfx = sfxPlayer(audio);
  const anims = [];
  let marker = null;
  let finished = false;
  const root = el('div', 'drive-in', document.body);
  root.setAttribute('role', 'status');
  const scrim = el('div', 'drive-in-scrim', root);
  const shadow = el('div', 'pass-in-shadow', root);
  const card = el('div', 'mode-card passenger drive-in-card', el('div', 'drive-in-cardwrap', root));
  const hero = el('div', 'drive-in-hero', card);
  el('h2', '', card, 'Modo pasajero activado');
  el('p', 'muted', card, 'Ya puedes pedir viajes. Mientras tanto no te llegan solicitudes.');
  el('div', 'mode-chips', card, '<span>Vuelve a conducir desde el menú</span>');
  const muteBtn = el('button', 'drive-in-mute', card);
  muteBtn.type = 'button';
  const paintMute = () => { const on = sfxOn(); muteBtn.textContent = on ? '🔊' : '🔇'; muteBtn.setAttribute('aria-label', on ? 'Silenciar los sonidos de la animación' : 'Activar los sonidos de la animación'); };
  paintMute();
  muteBtn.addEventListener('click', (e) => { e.stopPropagation(); setSfx(!sfxOn()); sfx.mute(!sfxOn()); paintMute(); });

  const car = el('div', 'drive-in-car', root);
  side.alt = '';
  side.className = 'drive-in-img';
  car.appendChild(side);
  const pin = el('div', 'pass-in-pin', root, PIN_SVG);
  const rings = [el('div', 'drive-in-ring', root), el('div', 'drive-in-ring', root)];

  const play = (node, frames, opts) => { const a = node.animate(frames, { fill: 'both', ...opts }); anims.push(a); return a; };
  const finish = () => {
    if (finished) return;
    finished = true;
    anims.forEach((a) => { try { a.cancel(); } catch { /* ya terminó */ } });
    marker?.classList.remove('drive-in-hide');
    root.remove();
    sfx.close();
  };
  // Tocar la pantalla la salta
  root.addEventListener('click', finish);
  // Pase lo que pase, a los 4,5 s se limpia
  const guard = setTimeout(finish, 4500);

  try {
    // 1) El aviso con el carro adentro. Al aparecer el aviso suena «transicion»; cuando el carro arranca, suena «carrofuera» (completo, ya trae su cola)
    if (!sfx.play('transicion')) blip(sfx, 0, 520, 900, 0.14, 0.5);
    sfx.play('carrofuera', { at: CAR_GO / 1000 });
    const h = hero.getBoundingClientRect();
    const s0 = (h.height * 0.78) / PIN_H;
    const start = { x: h.left + h.width / 2, y: h.top + h.height / 2 + (PIN_H * s0) / 2 };
    pin.style.transform = pos(start, s0);
    pin.style.opacity = '0';
    play(card, [{ opacity: 0, transform: 'translateY(14px) scale(.92)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
    play(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    // El carro (de lado) aparece, retrocede un poco y sale disparado hacia la derecha, fuera de la pantalla
    const c0 = (h.width * 0.95) / BOX;
    const cpos = (x, y, sc) => `translate3d(${x}px, ${y}px, 0) translate(-50%, -50%) scale(${sc})`;
    const cx = h.left + h.width / 2;
    const cy = h.top + h.height / 2;
    car.style.transform = cpos(cx, cy, c0);
    play(car, [{ opacity: 0, transform: cpos(cx, cy + 14, c0 * 0.9) }, { opacity: 1, transform: cpos(cx, cy, c0) }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
    play(car, [
      { opacity: 1, transform: cpos(cx, cy, c0) },
      { opacity: 1, transform: cpos(cx - 10, cy, c0), offset: 0.18, easing: 'ease-out' },
      { opacity: 1, transform: cpos(cx + innerWidth * 0.5 + BOX, cy, c0), offset: 1 },
    ], { duration: CAR_LEAVE, delay: CAR_GO, easing: 'cubic-bezier(.6,0,.9,.5)', fill: 'forwards' });
    // El pin aparece donde estaba el carro, con un saltito
    play(pin, [{ opacity: 0, transform: pos(start, s0 * 0.5) }, { opacity: 1, transform: pos(start, s0) }], { duration: 300, delay: PIN_IN, easing: 'cubic-bezier(.2,1.4,.4,1)', fill: 'both' });
    const t0 = performance.now();
    marker = await waitFor(findMarker, 1700);
    if (finished) return;
    const target = marker ? markerTip(marker) : mapCenter();
    // Lo que falte para que el carro se vaya y el pin se vea un momento
    const wait0 = Math.max(0, PIN_IN + 450 - (performance.now() - t0));

    // ---- Desde aquí todo se programa de una vez (cada parte con su retraso) ----
    const D = wait0; // cuándo empieza a salir del aviso
    const LIFT = 240;
    const FALL = 720;
    const IMPACT = D + LIFT + FALL; // toca el mapa
    const SQUASH = 380;
    const SHOW_AT = IMPACT + 520; // aparece el pin real del mapa
    const END = SHOW_AT + 200;
    const ms = (x) => x / 1000;
    marker?.classList.add('drive-in-hide');

    // «ding» al caer el pin en el mapa
    if (!sfx.play('ding', { at: ms(IMPACT) })) { blip(sfx, ms(IMPACT), 1318, 1318, 0.7, 0.45); blip(sfx, ms(IMPACT) + 0.09, 1760, 1760, 0.9, 0.35); }

    // El aviso se va y el mapa queda a la vista
    play(card, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 300, delay: D, easing: 'ease-in', fill: 'forwards' });
    play(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: 700, delay: D, easing: 'ease-out', fill: 'forwards' });

    // Sube un poco y cae con gravedad en curva hasta tu ubicación, achicándose hasta el tamaño del pin del mapa
    const lift = { x: start.x, y: start.y - 40 };
    const s1 = s0 * 1.12;
    const sEnd = 1;
    const ctrl = { x: lerp(lift.x, target.x, 0.15) + (target.x < lift.x ? 36 : -36), y: lerp(lift.y, target.y, 0.2) };
    const total = LIFT + FALL;
    const frames = [];
    const N = 24;
    for (let i = 0; i <= N; i++) {
      const tt = (i / N) * total;
      let p; let s;
      if (tt <= LIFT) {
        const k = tt / LIFT;
        const e = 1 - (1 - k) ** 2; // sube y frena
        p = { x: lerp(start.x, lift.x, e), y: lerp(start.y, lift.y, e) };
        s = lerp(s0, s1, e);
      } else {
        const k = (tt - LIFT) / FALL;
        const e = k * k * (1.35 - 0.35 * k); // gravedad: arranca lento y llega rápido
        const u = 1 - e;
        p = { x: u * u * lift.x + 2 * u * e * ctrl.x + e * e * target.x, y: u * u * lift.y + 2 * u * e * ctrl.y + e * e * target.y };
        s = lerp(s1, sEnd, e);
      }
      frames.push({ transform: pos(p, s), offset: i / N });
    }
    // (fill 'forwards': mientras espera su turno no tapa el flotar del aviso)
    play(pin, frames, { duration: total, delay: D, easing: 'linear', fill: 'forwards' });

    // La sombra se forma en el suelo mientras se acerca
    shadow.style.left = `${target.x}px`;
    shadow.style.top = `${target.y}px`;
    play(shadow, [
      { opacity: 0, transform: 'translate(-50%, -50%) scale(.2)' },
      { opacity: 0.5, transform: 'translate(-50%, -50%) scale(1)', offset: 0.7 },
      { opacity: 0.5, transform: 'translate(-50%, -50%) scale(1)', offset: 0.8 },
      { opacity: 0, transform: 'translate(-50%, -50%) scale(.6)' },
    ], { duration: SHOW_AT - (D + LIFT), delay: D + LIFT, easing: 'linear', fill: 'both' });

    // Aterriza: el pin se aplasta y se recupera, y salen dos ondas verdes
    const at = (sx, sy) => pos(target, sEnd, sx, sy);
    play(pin, [
      { transform: at(1, 1) },
      { transform: at(1.18, 0.78), offset: 0.2 },
      { transform: at(0.94, 1.1), offset: 0.48 },
      { transform: at(1.03, 0.97), offset: 0.74 },
      { transform: at(1, 1) },
    ], { duration: SQUASH, delay: IMPACT, easing: 'ease-out', fill: 'forwards' });
    rings.forEach((ring, i) => {
      ring.style.left = `${target.x}px`;
      ring.style.top = `${target.y - 2}px`;
      play(ring, [{ opacity: 0.95, transform: 'translate(-50%, -50%) scale(.25)' }, { opacity: 0, transform: `translate(-50%, -50%) scale(${i ? 1.9 : 2.7})` }], { duration: 700, delay: IMPACT + i * 140, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
    });

    // Al final se cambia por el pin real del mapa, en el mismo lugar
    play(pin, [{ opacity: 1 }, { opacity: 0 }], { duration: 160, delay: SHOW_AT, fill: 'forwards' });
    setTimeout(() => marker?.classList.remove('drive-in-hide'), SHOW_AT - 20);
    await sleep(END + 150);
  } finally {
    clearTimeout(guard);
    finish();
  }
}
