// Efectos de sonido de la app (archivos en assets/sfx). Se bajan y se decodifican una vez, con el primer toque en la pantalla,
// y suenan por el audio del navegador (así funcionan también en el iPhone, que solo deja sonar tras un toque).
// Si un sonido todavía no está listo, quien lo pide usa el sonido sintético de siempre: `playSfx` devuelve false.
import notificacion from './assets/sfx/notificacion.mp3';
import pagar from './assets/sfx/pagar.mp3';
import propina from './assets/sfx/propina.mp3';
import carro from './assets/sfx/carro2.mp3';
import impacto from './assets/sfx/impacto.mp3';

import impacto2 from './assets/sfx/impacto2.mp3';
import pop from './assets/sfx/pop.mp3';
import carrofuera from './assets/sfx/carrofuera.mp3';
import ding from './assets/sfx/ding.mp3';

const URLS = { notificacion, pagar, propina, carro, impacto, impacto2, pop, carrofuera, ding };
const buffers = {};
let loading = null;

function decoder() {
  try {
    const Offline = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    return new Offline(1, 1, 44100);
  } catch { return null; }
}

export function preloadSfx() {
  if (loading) return loading;
  loading = Promise.all(Object.entries(URLS).map(async ([name, url]) => {
    try {
      const data = await (await fetch(url)).arrayBuffer();
      const c = decoder();
      if (!c) return;
      buffers[name] = await new Promise((ok, fail) => c.decodeAudioData(data, ok, fail));
    } catch { /* sin este sonido: se usa el sintético */ }
  }));
  return loading;
}
// Se empiezan a bajar al abrir la app (sin esperar un toque), para que estén listos cuando hagan falta
if (typeof window !== 'undefined') setTimeout(preloadSfx, 1200);
if (typeof document !== 'undefined') {
  const first = () => { preloadSfx(); document.removeEventListener('pointerdown', first, true); };
  document.addEventListener('pointerdown', first, true);
}

// Cuánto dura un sonido ya decodificado (segundos); 0 si todavía no está listo
export const sfxDuration = (name) => buffers[name]?.duration || 0;

// `at`: segundos desde ahora · `gain`: volumen (0 a 1) · `fadeAt`: segundos desde ahora en que empieza a bajar hasta callar (0,12 s)
// `dest`: a dónde conectar el sonido (por defecto, la salida); la animación del carro usa su propio volumen general
// `onEnd`: se llama cuando el sonido terminó de sonar (o lo cortó `fadeAt`)
// `handle`: un objeto donde se deja `fade(seg)`, para callar el sonido más tarde si al empezar no se sabía cuándo
export function playSfx(ctx, name, { at = 0, gain = 0.9, fadeAt = null, dest = null, onEnd = null, handle = null } = {}) {
  const buffer = buffers[name];
  if (!ctx || !buffer || ctx.state !== 'running') return false;
  try {
    const t = ctx.currentTime + at;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    const g = ctx.createGain();
    g.gain.setValueAtTime(gain, t);
    if (fadeAt !== null) {
      const f = ctx.currentTime + fadeAt;
      g.gain.setValueAtTime(gain, f);
      g.gain.linearRampToValueAtTime(0.0001, f + 0.12);
    }
    if (onEnd) src.onended = onEnd;
    if (handle) {
      handle.fade = (secs) => {
        try {
          const f = Math.max(ctx.currentTime, ctx.currentTime + secs);
          g.gain.cancelScheduledValues(f);
          g.gain.setValueAtTime(gain, f);
          g.gain.linearRampToValueAtTime(0.0001, f + 0.12);
          src.stop(f + 0.2);
        } catch { /* ya terminó */ }
      };
    }
    src.connect(g).connect(dest || ctx.destination);
    src.start(t);
    if (fadeAt !== null) src.stop(ctx.currentTime + fadeAt + 0.2); // ya calló: se libera
    return true;
  } catch { return false; }
}

// ---- Sonidos de las animaciones al cambiar de modo ----
const SFX_KEY = 'ktracho:sfx';
export const sfxOn = () => { try { return localStorage.getItem(SFX_KEY) !== 'off'; } catch { return true; } };
export const setSfx = (on) => { try { localStorage.setItem(SFX_KEY, on ? 'on' : 'off'); } catch { /* sin almacenamiento */ } };

// Un reproductor con volumen general para una animación: cuenta los sonidos que están sonando y cierra el audio
// cuando todos terminaron (no por un tiempo fijo, para no cortar el final).
export function sfxPlayer(ctx) {
  if (!ctx) return { play: () => false, mute() {}, close() {}, ctx: null };
  const master = ctx.createGain();
  master.gain.value = sfxOn() ? 0.9 : 0;
  master.connect(ctx.destination);
  let active = 0;
  let closing = false;
  const shut = () => { try { ctx.close?.().catch?.(() => {}); } catch { /* ya estaba cerrado */ } };
  return {
    ctx,
    master,
    play(name, opts) {
      active += 1;
      const ok = playSfx(ctx, name, { gain: 1, ...opts, dest: master, onEnd: () => { active -= 1; if (closing && active <= 0) shut(); } });
      if (!ok) active -= 1;
      return ok;
    },
    mute(off) { master.gain.setTargetAtTime(off ? 0 : 0.9, ctx.currentTime, 0.03); },
    // Si algo falla, a los 10 s se cierra igual
    close() {
      closing = true;
      if (active <= 0) setTimeout(shut, 1500);
      else setTimeout(shut, 10000);
    },
  };
}
