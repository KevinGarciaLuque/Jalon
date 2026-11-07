// Animación al activar el modo conductor: el carro sale del aviso, cae sobre el mapa y aterriza en tu ubicación,
// donde se convierte en el carro del mapa. Va aparte (se descarga solo al cambiar de modo).
// Si algo falla, la promesa se rechaza y la app muestra el aviso normal. Nada de esto toca el mapa ni el GPS.
// Para que vaya fluida en cualquier celular: solo se animan transform y opacity (los mueve la tarjeta gráfica),
// y toda la secuencia se programa de una vez, así no se traba aunque el teléfono esté ocupado cargando el mapa.
import imgSide from './assets/drive-34.webp';
import imgFall from './assets/drive-fall.webp';
import imgTop from './assets/drive-top.webp';

import { playSfx, preloadSfx } from './sfx.js';

const SFX_KEY = 'ktracho:sfx';
export const sfxOn = () => { try { return localStorage.getItem(SFX_KEY) !== 'off'; } catch { return true; } };
const setSfx = (on) => { try { localStorage.setItem(SFX_KEY, on ? 'on' : 'off'); } catch { /* sin almacenamiento */ } };

// Las imágenes se bajan y se preparan antes de empezar (así no aparecen a medias)
export function preload() {
  const snd = preloadSfx();
  return Promise.all([imgSide, imgFall, imgTop].map((src) => {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    return img.decode().then(() => img);
  })).then(async (imgs) => {
    // Que los sonidos estén decodificados antes de empezar (si tardan más de 1,2 s, la animación sigue y usa los de repuesto)
    await Promise.race([snd, new Promise((r) => setTimeout(r, 1200))]);
    return imgs;
  });
}

// ---- Sonidos hechos en el momento (sin archivos): aire, golpe suave y un acelerón corto ----
// Cada uno se programa con el reloj del audio (`at` segundos desde ahora): suenan a tiempo aunque el teléfono esté ocupado
function sounds(ctx) {
  if (!ctx) return { whoosh() {}, thump() {}, rev() {}, mute() {}, close() {} };
  const master = ctx.createGain();
  master.gain.value = sfxOn() ? 0.9 : 0;
  master.connect(ctx.destination);
  // Los sonidos de archivo (carro, impacto) se cuentan: el audio se cierra cuando todos terminaron de sonar, no por un tiempo fijo
  // (antes se cerraba unos segundos después de la animación y podía cortar el final del impacto).
  let active = 0;
  let closing = false;
  const shut = () => { try { ctx.close?.().catch?.(() => {}); } catch { /* ya estaba cerrado */ } };
  const sample = (name, opts) => {
    active += 1;
    const ok = playSfx(ctx, name, { ...opts, gain: 1, dest: master, onEnd: () => { active -= 1; if (closing && active <= 0) shut(); } });
    if (!ok) active -= 1;
    return ok;
  };
  const noise = (secs) => {
    const buf = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * secs), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    return src;
  };
  const env = (g, t, peak, attack, release) => {
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + release);
  };
  return {
    // `fadeAt`: cuándo debe callar el sonido del carro (justo al tocar el mapa, para dejarle lugar al impacto)
    whoosh(at, dur = 1.1, fadeAt = null) {
      if (sample('carro', { at, fadeAt })) return; // el sonido «carro»; si no está listo, el aire sintético
      const t = ctx.currentTime + at;
      const src = noise(dur);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 1.2;
      bp.frequency.setValueAtTime(350, t);
      bp.frequency.exponentialRampToValueAtTime(2400, t + dur * 0.55);
      bp.frequency.exponentialRampToValueAtTime(500, t + dur);
      const g = ctx.createGain();
      env(g, t, 0.55, dur * 0.6, dur * 0.4);
      src.connect(bp).connect(g).connect(master);
      src.start(t);
      src.stop(t + dur);
    },
    thump(at) {
      if (sample('impacto', { at })) return; // el sonido «impacto»; si no está listo, el golpe sintético
      const t = ctx.currentTime + at;
      const o = ctx.createOscillator();
      o.type = 'sine';
      o.frequency.setValueAtTime(95, t);
      o.frequency.exponentialRampToValueAtTime(38, t + 0.35);
      const g = ctx.createGain();
      env(g, t, 0.9, 0.008, 0.38);
      o.connect(g).connect(master);
      o.start(t);
      o.stop(t + 0.45);
      // El roce de las llantas: un poco de ruido grave
      const n = noise(0.3);
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = 900;
      const gn = ctx.createGain();
      env(gn, t, 0.35, 0.005, 0.25);
      n.connect(lp).connect(gn).connect(master);
      n.start(t);
      n.stop(t + 0.3);
    },
    rev(at) {
      const t = ctx.currentTime + at;
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.setValueAtTime(500, t);
      lp.frequency.linearRampToValueAtTime(1500, t + 0.35);
      lp.frequency.linearRampToValueAtTime(600, t + 0.8);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.22, t + 0.08);
      g.gain.setValueAtTime(0.22, t + 0.45);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.85);
      lp.connect(g).connect(master);
      for (const [type, mult] of [['sawtooth', 1], ['square', 0.5]]) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(55 * mult, t);
        o.frequency.exponentialRampToValueAtTime(150 * mult, t + 0.35);
        o.frequency.exponentialRampToValueAtTime(80 * mult, t + 0.8);
        o.connect(lp);
        o.start(t);
        o.stop(t + 0.9);
      }
    },
    mute(off) { master.gain.setTargetAtTime(off ? 0 : 0.9, ctx.currentTime, 0.03); },
    // Se cierra cuando terminó de sonar el último sonido (el impacto dura unos 3 s); si algo falla, a los 10 s se cierra igual
    close() {
      closing = true;
      if (active <= 0) setTimeout(shut, 1500);
      else setTimeout(shut, 10000);
    },
  };
}

// ---- Dónde está el carro del mapa en la pantalla (y hacia dónde apunta) ----
const findMarker = () => document.querySelector('.leaflet-marker-icon.car');
function markerSpot(el) {
  const r = el.getBoundingClientRect();
  let angle = 0;
  const rot = el.querySelector('.car-rot');
  const m = rot && getComputedStyle(rot).transform;
  if (m && m !== 'none') {
    const [a, b] = m.slice(m.indexOf('(') + 1, -1).split(',').map(Number);
    angle = (Math.atan2(b, a) * 180) / Math.PI;
  }
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, angle };
}
// Sin el carro todavía (el GPS no ha dado la posición): el centro de la parte del mapa que se ve
function mapCenter() {
  const map = document.querySelector('.screen .map');
  const sheet = document.querySelector('.screen .sheet');
  if (!map) return { x: innerWidth / 2, y: innerHeight * 0.4, angle: 0 };
  const r = map.getBoundingClientRect();
  const covered = sheet && getComputedStyle(sheet).position === 'absolute' ? sheet.offsetHeight : 0;
  return { x: r.left + r.width / 2, y: r.top + (r.height - covered) / 2, angle: 0 };
}
const waitFor = (fn, ms) => new Promise((res) => {
  const t0 = performance.now();
  const tick = () => { const v = fn(); if (v || performance.now() - t0 > ms) res(v || null); else requestAnimationFrame(tick); };
  tick();
});

const el = (tag, cls, parent, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; parent?.appendChild(e); return e; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Una bocanada de humo dibujada una sola vez; después cada partícula es solo copiar esa imagen (rápido en el celular)
function puffSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  // Blanco con un borde gris: así se ve también sobre las calles claras del mapa
  grad.addColorStop(0, 'rgba(255,255,255,0.95)');
  grad.addColorStop(0.55, 'rgba(232,236,234,0.7)');
  grad.addColorStop(0.85, 'rgba(170,178,174,0.28)');
  grad.addColorStop(1, 'rgba(170,178,174,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

// Humo de las llantas en un canvas chico alrededor del carro (no de toda la pantalla)
function smoke(canvas, center, points, angleDeg, startAt) {
  const SIZE = 360;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.style.left = `${center.x - SIZE / 2}px`;
  canvas.style.top = `${center.y - SIZE / 2}px`;
  canvas.style.width = canvas.style.height = `${SIZE}px`;
  canvas.width = canvas.height = SIZE * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  const puff = puffSprite();
  const rad = (angleDeg * Math.PI) / 180;
  const parts = [];
  for (const p of points) {
    for (let i = 0; i < 9; i++) {
      // Hacia afuera del carro, con un poco de azar
      const out = Math.atan2(p.dy, p.dx) + rad + (Math.random() - 0.5) * 1.4;
      const speed = 22 + Math.random() * 40;
      parts.push({
        x: p.x - center.x + SIZE / 2, y: p.y - center.y + SIZE / 2,
        vx: Math.cos(out) * speed, vy: Math.sin(out) * speed - 6,
        r0: 5 + Math.random() * 6, r1: 24 + Math.random() * 20, delay: Math.random() * 120, life: 700 + Math.random() * 400,
      });
    }
  }
  let stop = false;
  const frame = (now) => {
    if (stop) return;
    const t = now - startAt;
    if (t < 0) { requestAnimationFrame(frame); return; }
    ctx.clearRect(0, 0, SIZE, SIZE);
    let alive = false;
    for (const s of parts) {
      const k = (t - s.delay) / s.life;
      if (k < 0) { alive = true; continue; }
      if (k >= 1) continue;
      alive = true;
      const ease = 1 - (1 - k) ** 2;
      const r = s.r0 + (s.r1 - s.r0) * ease;
      ctx.globalAlpha = 0.9 * (1 - k);
      ctx.drawImage(puff, s.x + s.vx * ease - r, s.y + s.vy * ease - r, r * 2, r * 2);
    }
    if (alive) requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  return () => { stop = true; };
}

// La caja del carro mide BOX × BOX px; cada imagen cabe dentro (contain). La vista de arriba ocupa todo el alto.
const BOX = 240;
const pos = (p, s, r = 0, sx = 1, sy = 1) => `translate3d(${p.x}px, ${p.y}px, 0) translate(-50%, -50%) rotate(${r}deg) scale(${s * sx}, ${s * sy})`;
const lerp = (a, b, k) => a + (b - a) * k;

/**
 * Corre la animación completa (unos 3,3 s). Resuelve al terminar (o si la persona toca para saltarla).
 * `audio`: el AudioContext creado en el toque · `info`: { vehicle, plate } para el aviso
 */
export async function playDriveIn({ audio, info = {} }) {
  const [side, fall, top] = await Promise.race([preload(), sleep(2500).then(() => { throw new Error('imágenes lentas'); })]);
  const sfx = sounds(audio);
  const anims = [];
  let marker = null;
  let finished = false;
  let stopSmoke = () => {};
  const root = el('div', 'drive-in', document.body);
  root.setAttribute('role', 'status');
  const scrim = el('div', 'drive-in-scrim', root);
  const canvas = el('canvas', 'drive-in-smoke', root);
  const shadow = el('div', 'drive-in-shadow', root);
  const card = el('div', 'mode-card driver drive-in-card', el('div', 'drive-in-cardwrap', root));
  const hero = el('div', 'drive-in-hero', card);
  el('h2', '', card, 'Modo conductor activado');
  el('p', 'muted', card, 'Ponte disponible para empezar a recibir solicitudes.');
  if (info.vehicle) el('div', 'mode-chips', card).appendChild(el('span', '', null)).textContent = info.plate ? `${info.vehicle} · ${info.plate}` : info.vehicle;
  const muteBtn = el('button', 'drive-in-mute', card);
  muteBtn.type = 'button';
  const paintMute = () => { const on = sfxOn(); muteBtn.textContent = on ? '🔊' : '🔇'; muteBtn.setAttribute('aria-label', on ? 'Silenciar los sonidos de la animación' : 'Activar los sonidos de la animación'); };
  paintMute();
  muteBtn.addEventListener('click', (e) => { e.stopPropagation(); setSfx(!sfxOn()); sfx.mute(!sfxOn()); paintMute(); });

  const car = el('div', 'drive-in-car', root);
  // Las mismas imágenes ya preparadas (sin copiarlas: así no se vuelven a decodificar)
  const layers = [side, fall, top].map((img, i) => { img.alt = ''; img.className = `drive-in-img l${i}`; car.appendChild(img); return img; });
  const streaks = el('div', 'drive-in-streaks', car, '<i></i><i></i><i></i><i></i><i></i>');
  const rings = [el('div', 'drive-in-ring', root), el('div', 'drive-in-ring', root)];

  const play = (node, frames, opts) => { const a = node.animate(frames, { fill: 'both', ...opts }); anims.push(a); return a; };
  const finish = () => {
    if (finished) return;
    finished = true;
    stopSmoke();
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
    // 1) El aviso con el carro adentro (mientras tanto se busca el carro del mapa)
    const h = hero.getBoundingClientRect();
    const start = { x: h.left + h.width / 2, y: h.top + h.height / 2 };
    const s0 = (h.width * 0.95) / BOX;
    car.style.transform = pos(start, s0);
    play(card, [{ opacity: 0, transform: 'translateY(14px) scale(.92)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
    play(car, [{ opacity: 0, transform: pos({ ...start, y: start.y + 14 }, s0 * 0.9) }, { opacity: 1, transform: pos(start, s0) }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
    play(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    play(car, [{ transform: pos(start, s0) }, { transform: pos({ ...start, y: start.y - 5 }, s0 * 1.01) }, { transform: pos(start, s0) }], { duration: 620, delay: 380, easing: 'ease-in-out', fill: 'none', composite: 'replace' });
    const t0 = performance.now();
    marker = await waitFor(findMarker, 1700);
    if (finished) return;
    const target = marker ? markerSpot(marker) : mapCenter();
    // Lo que falte para completar el segundo del aviso
    const wait0 = Math.max(0, 1000 - (performance.now() - t0));

    // ---- Desde aquí todo se programa de una vez (cada parte con su retraso) ----
    const D = wait0; // cuándo empieza a salir del aviso
    const LIFT = 260;
    const FALL = 880;
    const IMPACT = D + LIFT + FALL; // toca el mapa
    const SQUASH = 380;
    const SHRINK_AT = IMPACT + 540;
    const SHRINK = 620;
    const END = SHRINK_AT + SHRINK;
    const startAt = performance.now();
    const ms = (x) => x / 1000;
    marker?.classList.add('drive-in-hide');

    // Sonidos con el reloj del audio
    sfx.whoosh(ms(D), 1.15, ms(IMPACT) - 0.05);
    sfx.thump(ms(IMPACT));

    // El aviso se va y el mapa queda a la vista
    play(card, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 300, delay: D, easing: 'ease-in', fill: 'forwards' });
    play(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: 700, delay: D, easing: 'ease-out', fill: 'forwards' });

    // Salida + caída en un solo movimiento: sube hacia la cámara (frena arriba) y cae con gravedad en curva hasta tu ubicación,
    // achicándose y girando hacia donde apunta el carro del mapa. Se calculan muchos puntos para que la curva sea suave.
    const lift = { x: start.x, y: start.y - 36 };
    const s1 = s0 * 1.12;
    const landScale = 0.58;
    // La curva de caída: un punto de control a un lado le da un arco natural
    const ctrl = { x: lerp(lift.x, target.x, 0.15) + (target.x < lift.x ? 40 : -40), y: lerp(lift.y, target.y, 0.2) };
    const total = LIFT + FALL;
    const frames = [];
    const N = 24;
    for (let i = 0; i <= N; i++) {
      const tt = (i / N) * total;
      let p; let s; let r;
      if (tt <= LIFT) {
        const k = tt / LIFT;
        const e = 1 - (1 - k) ** 2; // sube y frena
        p = { x: lerp(start.x, lift.x, e), y: lerp(start.y, lift.y, e) };
        s = lerp(s0, s1, e);
        r = -4 * e;
      } else {
        const k = (tt - LIFT) / FALL;
        const e = k * k * (1.35 - 0.35 * k); // gravedad: arranca lento y llega rápido
        const u = 1 - e;
        p = { x: u * u * lift.x + 2 * u * e * ctrl.x + e * e * target.x, y: u * u * lift.y + 2 * u * e * ctrl.y + e * e * target.y };
        s = lerp(s1, landScale, e);
        const turn = Math.min(1, Math.max(0, (k - 0.45) / 0.5));
        r = lerp(-4, target.angle, turn * turn * (3 - 2 * turn));
      }
      frames.push({ transform: pos(p, s, r), offset: i / N });
    }
    // (fill 'forwards': mientras espera su turno no tapa el flotar del aviso)
    play(car, frames, { duration: total, delay: D, easing: 'linear', fill: 'forwards' });
    // Las vistas del carro cambian solas mientras cae (cada lista termina en 1 para que no vuelva a la opacidad del CSS)
    const F0 = D + LIFT;
    play(layers[0], [{ opacity: 1 }, { opacity: 0 }], { duration: 280, delay: F0 + 40, fill: 'both' });
    play(layers[1], [{ opacity: 0, offset: 0 }, { opacity: 1, offset: 0.28 }, { opacity: 1, offset: 0.6 }, { opacity: 0, offset: 0.88 }, { opacity: 0, offset: 1 }], { duration: FALL, delay: F0, fill: 'both' });
    play(layers[2], [{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 0.85 }, { opacity: 1, offset: 1 }], { duration: FALL, delay: F0, fill: 'both' });
    // Estelas de velocidad, apuntando hacia atrás del movimiento
    const dir = (Math.atan2(target.y - lift.y, target.x - lift.x) * 180) / Math.PI;
    streaks.style.transform = `translate(-50%, -50%) rotate(${dir - 90 - target.angle * 0.5}deg)`;
    play(streaks, [{ opacity: 0 }, { opacity: 0.9, offset: 0.3 }, { opacity: 0.9, offset: 0.7 }, { opacity: 0 }], { duration: FALL, delay: F0, fill: 'both' });
    // La sombra se forma en el suelo mientras se acerca
    shadow.style.left = `${target.x}px`;
    shadow.style.top = `${target.y}px`;
    play(shadow, [
      { opacity: 0, transform: `translate(-50%, -50%) rotate(${target.angle}deg) scale(2.4)` },
      { opacity: 0.55, transform: `translate(-50%, -50%) rotate(${target.angle}deg) scale(1)`, offset: 0.62 },
      { opacity: 0.55, transform: `translate(-50%, -50%) rotate(${target.angle}deg) scale(1)`, offset: 0.78 },
      { opacity: 0, transform: `translate(-50%, -50%) rotate(${target.angle}deg) scale(.35)` },
    ], { duration: END - F0, delay: F0, easing: 'linear', fill: 'both' });

    // Aterriza: la suspensión rebota (aplastarse y recuperarse) y dos ondas verdes
    const at = (sx, sy) => pos(target, landScale, target.angle, sx, sy);
    play(car, [
      { transform: at(1, 1) },
      { transform: at(1.06, 0.9), offset: 0.22 },
      { transform: at(0.97, 1.04), offset: 0.5 },
      { transform: at(1.01, 0.99), offset: 0.78 },
      { transform: at(1, 1) },
    ], { duration: SQUASH, delay: IMPACT, easing: 'ease-out', fill: 'forwards' });
    rings.forEach((ring, i) => {
      ring.style.left = `${target.x}px`;
      ring.style.top = `${target.y}px`;
      play(ring, [{ opacity: 0.95, transform: 'translate(-50%, -50%) scale(.25)' }, { opacity: 0, transform: `translate(-50%, -50%) scale(${i ? 2.4 : 3.2})` }], { duration: 700, delay: IMPACT + i * 140, easing: 'cubic-bezier(.2,.7,.3,1)', fill: 'forwards' });
    });
    // Humo de las 4 llantas, según hacia dónde apunta el carro (la vista de arriba llena el alto de la caja)
    const topAspect = top.naturalWidth / top.naturalHeight || 0.46;
    const half = { w: BOX * landScale * topAspect * 0.42, h: BOX * landScale * 0.31 };
    const rad = (target.angle * Math.PI) / 180;
    const wheels = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => {
      const dx = sx * half.w;
      const dy = sy * half.h;
      return { x: target.x + dx * Math.cos(rad) - dy * Math.sin(rad), y: target.y + dx * Math.sin(rad) + dy * Math.cos(rad), dx, dy };
    });
    stopSmoke = smoke(canvas, target, wheels, target.angle, startAt + IMPACT);

    // Se encoge hasta ser el carro del mapa, justo en tu ubicación, y al final aparece el carro real
    const markerImg = marker?.querySelector('img');
    const endH = markerImg ? markerImg.getBoundingClientRect().height || 48 : 48;
    const endScale = endH / BOX;
    play(car, [{ transform: at(1, 1), opacity: 1 }, { transform: pos(target, endScale, target.angle), opacity: 1, offset: 0.85 }, { transform: pos(target, endScale, target.angle), opacity: 0 }], { duration: SHRINK + 160, delay: SHRINK_AT, easing: 'cubic-bezier(.6,0,.3,1)', fill: 'forwards' });
    setTimeout(() => marker?.classList.remove('drive-in-hide'), END - 40);
    await sleep(END + 180);
  } finally {
    clearTimeout(guard);
    finish();
  }
}
