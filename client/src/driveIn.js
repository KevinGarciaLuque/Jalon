// Animación al activar el modo conductor: el carro sale del aviso, cae sobre el mapa y aterriza en tu ubicación,
// donde se convierte en el carro del mapa. Va aparte (se descarga solo al cambiar de modo).
// Si algo falla, la promesa se rechaza y la app muestra el aviso normal. Nada de esto toca el mapa ni el GPS.
import imgSide from './assets/drive-34.webp';
import imgFall from './assets/drive-fall.webp';
import imgTop from './assets/drive-top.webp';

const SFX_KEY = 'ktracho:sfx';
export const sfxOn = () => { try { return localStorage.getItem(SFX_KEY) !== 'off'; } catch { return true; } };
const setSfx = (on) => { try { localStorage.setItem(SFX_KEY, on ? 'on' : 'off'); } catch { /* sin almacenamiento */ } };

// El audio del teléfono solo arranca dentro de un toque: se crea en el toque del menú y se pasa aquí
export function makeAudio() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return null;
    const ctx = new Ctx();
    ctx.resume?.();
    return ctx;
  } catch { return null; }
}

// Las imágenes se bajan y se preparan antes de empezar (así no aparecen a medias)
export function preload() {
  return Promise.all([imgSide, imgFall, imgTop].map((src) => {
    const img = new Image();
    img.src = src;
    return img.decode().then(() => img);
  }));
}

// ---- Sonidos hechos en el momento (sin archivos): aire, golpe suave y un acelerón corto ----
function sounds(ctx) {
  if (!ctx) return { whoosh() {}, thump() {}, rev() {}, mute() {}, close() {} };
  const master = ctx.createGain();
  master.gain.value = sfxOn() ? 0.9 : 0;
  master.connect(ctx.destination);
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
    whoosh(dur = 1.1) {
      const t = ctx.currentTime;
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
    thump() {
      const t = ctx.currentTime;
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
    rev() {
      const t = ctx.currentTime;
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
    close() { setTimeout(() => ctx.close?.().catch?.(() => {}), 1200); },
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

// Humo de las llantas: partículas blancas que crecen y se desvanecen (en un canvas, liviano para el celular)
function smoke(canvas, points, angleDeg) {
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  canvas.width = innerWidth * dpr;
  canvas.height = innerHeight * dpr;
  ctx.scale(dpr, dpr);
  const rad = (angleDeg * Math.PI) / 180;
  const parts = [];
  for (const p of points) {
    for (let i = 0; i < 9; i++) {
      // Hacia afuera del carro, con un poco de azar
      const out = Math.atan2(p.dy, p.dx) + rad + (Math.random() - 0.5) * 1.4;
      const speed = 22 + Math.random() * 40;
      parts.push({ x: p.x, y: p.y, vx: Math.cos(out) * speed, vy: Math.sin(out) * speed - 6, r0: 5 + Math.random() * 6, r1: 24 + Math.random() * 20, delay: Math.random() * 120, life: 700 + Math.random() * 400 });
    }
  }
  const t0 = performance.now();
  return new Promise((done) => {
    const frame = (now) => {
      const t = now - t0;
      ctx.clearRect(0, 0, innerWidth, innerHeight);
      let alive = false;
      for (const s of parts) {
        const k = (t - s.delay) / s.life;
        if (k < 0) { alive = true; continue; }
        if (k >= 1) continue;
        alive = true;
        const ease = 1 - (1 - k) ** 2;
        const x = s.x + s.vx * ease;
        const y = s.y + s.vy * ease;
        const r = s.r0 + (s.r1 - s.r0) * ease;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        // Blanco con un borde gris: así se ve también sobre las calles claras del mapa
        const a = 0.85 * (1 - k);
        g.addColorStop(0, `rgba(255,255,255,${a})`);
        g.addColorStop(0.55, `rgba(232,236,234,${a * 0.75})`);
        g.addColorStop(0.85, `rgba(170,178,174,${a * 0.3})`);
        g.addColorStop(1, 'rgba(170,178,174,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      }
      if (alive) requestAnimationFrame(frame); else done();
    };
    requestAnimationFrame(frame);
  });
}

// La caja del carro mide BOX × BOX px; cada imagen cabe dentro (contain). La vista de arriba ocupa todo el alto.
const BOX = 240;

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
  const layers = [side, fall, top].map((img, i) => { const c = img.cloneNode(); c.alt = ''; c.className = `drive-in-img l${i}`; car.appendChild(c); return c; });
  const streaks = el('div', 'drive-in-streaks', car, '<i></i><i></i><i></i><i></i><i></i>');

  const play = (node, frames, opts) => { const a = node.animate(frames, { fill: 'forwards', ...opts }); anims.push(a); return a; };
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
    // 1) El aviso con el carro adentro
    const h = hero.getBoundingClientRect();
    const start = { x: h.left + h.width / 2, y: h.top + h.height / 2 };
    const pos = (p, s, r = 0) => `translate(${p.x}px, ${p.y}px) translate(-50%, -50%) rotate(${r}deg) scale(${s})`;
    const s0 = (h.width * 0.95) / BOX;
    car.style.transform = pos(start, s0);
    play(card, [{ opacity: 0, transform: 'translateY(14px) scale(.92)' }, { opacity: 1, transform: 'none' }], { duration: 320, easing: 'cubic-bezier(.2,.8,.2,1)' });
    play(car, [{ opacity: 0, transform: pos({ ...start, y: start.y + 14 }, s0 * 0.9) }, { opacity: 1, transform: pos(start, s0) }], { duration: 380, easing: 'cubic-bezier(.2,.8,.2,1)' });
    play(scrim, [{ opacity: 0 }, { opacity: 1 }], { duration: 300 });
    await sleep(380);
    if (finished) return;
    // Flota un poco mientras se lee el aviso
    play(car, [{ transform: pos(start, s0) }, { transform: pos({ ...start, y: start.y - 5 }, s0 * 1.01) }, { transform: pos(start, s0) }], { duration: 620, easing: 'ease-in-out' });
    await sleep(620);
    if (finished) return;

    // 2) Sale del aviso hacia la cámara y empieza a caer
    marker = await waitFor(findMarker, 1200);
    let target = marker ? markerSpot(marker) : mapCenter();
    marker?.classList.add('drive-in-hide');
    sfx.whoosh(1.15);
    play(card, [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'scale(.9)' }], { duration: 300, easing: 'ease-in' });
    play(scrim, [{ opacity: 1 }, { opacity: 0 }], { duration: 700, easing: 'ease-out' });
    const lift = { x: start.x, y: start.y - 36 };
    const s1 = s0 * 1.12;
    play(car, [{ transform: pos(start, s0) }, { transform: pos(lift, s1, -4) }], { duration: 260, easing: 'cubic-bezier(.3,.7,.4,1)' });
    await sleep(260);
    if (finished) return;

    // 3) Caída con gravedad: se aleja de la cámara (se achica), cambia a la vista de arriba y gira hacia donde apunta el carro del mapa
    const landScale = 0.58;
    const FALL = 880;
    const mid = { x: lift.x + (target.x - lift.x) * 0.55, y: lift.y + (target.y - lift.y) * 0.5 };
    play(car, [
      { transform: pos(lift, s1, -4), filter: 'blur(0px)', offset: 0 },
      { transform: pos(mid, (s1 + landScale) / 2, target.angle * 0.4), filter: 'blur(1.5px)', offset: 0.55 },
      { transform: pos(target, landScale, target.angle), filter: 'blur(0px)', offset: 1 },
    ], { duration: FALL, easing: 'cubic-bezier(.55,0,.85,.45)' });
    play(layers[0], [{ opacity: 1 }, { opacity: 0 }], { duration: 260, delay: 60 });
    // (cada lista termina en offset 1: si no, al final vuelve a la opacidad del CSS)
    play(layers[1], [{ opacity: 0, offset: 0 }, { opacity: 1, offset: 0.25 }, { opacity: 1, offset: 0.6 }, { opacity: 0, offset: 0.9 }, { opacity: 0, offset: 1 }], { duration: FALL });
    play(layers[2], [{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 0.85 }, { opacity: 1, offset: 1 }], { duration: FALL });
    // Estelas de velocidad, apuntando hacia atrás del movimiento
    const dir = (Math.atan2(target.y - lift.y, target.x - lift.x) * 180) / Math.PI;
    streaks.style.transform = `translate(-50%, -50%) rotate(${dir - 90 - target.angle * 0.5}deg)`;
    play(streaks, [{ opacity: 0 }, { opacity: 0.9, offset: 0.3 }, { opacity: 0.9, offset: 0.7 }, { opacity: 0 }], { duration: FALL });
    shadow.style.left = `${target.x}px`;
    shadow.style.top = `${target.y}px`;
    play(shadow, [{ opacity: 0, transform: 'translate(-50%, -50%) scale(2.4)' }, { opacity: 0.55, transform: `translate(-50%, -50%) rotate(${target.angle}deg) scale(1)` }], { duration: FALL, easing: 'cubic-bezier(.55,0,.85,.45)' });
    await sleep(FALL);
    if (finished) return;

    // 4) Aterriza: golpe suave, la suspensión rebota, humo en las llantas y una onda verde
    sfx.thump();
    const sq = (sx, sy) => `${pos(target, landScale, target.angle)} scale(${sx}, ${sy})`;
    play(car, [
      { transform: sq(1, 1) },
      { transform: sq(1.06, 0.9), offset: 0.25 },
      { transform: sq(0.97, 1.04), offset: 0.55 },
      { transform: sq(1.01, 0.99), offset: 0.8 },
      { transform: sq(1, 1) },
    ], { duration: 380, easing: 'ease-out' });
    for (const [delay, size] of [[0, 3.2], [140, 2.4]]) {
      const ring = el('div', 'drive-in-ring', root);
      ring.style.left = `${target.x}px`;
      ring.style.top = `${target.y}px`;
      play(ring, [{ opacity: 0.95, transform: 'translate(-50%, -50%) scale(.25)' }, { opacity: 0, transform: `translate(-50%, -50%) scale(${size})` }], { duration: 700, delay, easing: 'cubic-bezier(.2,.7,.3,1)' });
    }
    // Las 4 llantas, según hacia dónde apunta el carro (la vista de arriba llena el alto de la caja)
    const topAspect = top.naturalWidth / top.naturalHeight || 0.46;
    const half = { w: BOX * landScale * topAspect * 0.42, h: BOX * landScale * 0.31 };
    const rad = (target.angle * Math.PI) / 180;
    const wheels = [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([sx, sy]) => {
      const dx = sx * half.w;
      const dy = sy * half.h;
      return { x: target.x + dx * Math.cos(rad) - dy * Math.sin(rad), y: target.y + dx * Math.sin(rad) + dy * Math.cos(rad), dx, dy };
    });
    smoke(canvas, wheels, target.angle);
    await sleep(420);
    if (finished) return;

    // 5) Acelerón corto y se encoge hasta ser el carro del mapa, justo en tu ubicación
    sfx.rev();
    const now = marker && document.contains(marker) ? markerSpot(marker) : target;
    const markerImg = marker?.querySelector('img');
    const endH = markerImg ? markerImg.getBoundingClientRect().height || 48 : 48;
    const endScale = endH / BOX;
    play(car, [{ transform: pos(target, landScale, target.angle) }, { transform: pos(now, endScale, now.angle) }], { duration: 620, delay: 120, easing: 'cubic-bezier(.6,0,.3,1)' });
    play(shadow, [{ opacity: 0.55 }, { opacity: 0 }], { duration: 500, delay: 160 });
    await sleep(740);
    if (finished) return;
    marker?.classList.remove('drive-in-hide');
    play(car, [{ opacity: 1 }, { opacity: 0 }], { duration: 200 });
    await sleep(220);
  } finally {
    clearTimeout(guard);
    finish();
  }
}
