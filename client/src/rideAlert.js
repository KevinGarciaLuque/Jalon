// Aviso al conductor cuando llega una solicitud nueva con la app abierta: un sonido corto (hecho en el momento, sin archivos)
// y una vibración. Con la app cerrada o en segundo plano, el aviso es la notificación del celular (lo manda el servidor).
// Los celulares solo dejan sonar audio después de un toque: `unlockRideAlert()` se llama en un toque (p. ej. «Ponerme disponible»)
// y además con el primer toque en cualquier parte de la pantalla.

import { playSfx } from './sfx.js';

const KEY = 'jalon-ride-sound';
let ctx = null;

export const rideSoundOn = () => { try { return localStorage.getItem(KEY) !== '0'; } catch { return true; } };
export const setRideSound = (on) => { try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* sin almacenamiento: solo por esta vez */ } };

export function unlockRideAlert() {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!ctx) ctx = new Ctx();
    if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  } catch { /* sin audio en este aparato */ }
}
if (typeof document !== 'undefined') {
  const first = () => { unlockRideAlert(); document.removeEventListener('pointerdown', first, true); };
  document.addEventListener('pointerdown', first, true);
}

// Tres notas que suben (tipo «¡din-din-din!»), claras pero no estridentes, ~0,6 s
function chime() {
  if (!ctx || ctx.state !== 'running') return false;
  if (playSfx(ctx, 'notificacion')) return true; // el sonido de notificación (si no está listo, el «din-din-din» de abajo)
  const t0 = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.value = 0.55;
  master.connect(ctx.destination);
  [[880, 0], [1175, 0.16], [1568, 0.32]].forEach(([freq, at]) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    const t = t0 + at;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.9, t + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.28);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + 0.3);
  });
  return true;
}

let last = 0;
// Devuelve qué se pudo hacer (para las pruebas): { sound, vibrate }
export function playRideAlert() {
  if (!rideSoundOn()) return { sound: false, vibrate: false };
  // Si llegan varias juntas, suena una sola vez
  if (Date.now() - last < 1500) return { sound: false, vibrate: false };
  last = Date.now();
  const sound = chime();
  let vibrate = false;
  try { vibrate = !!navigator.vibrate?.([180, 90, 180]); } catch { /* sin vibración (iPhone) */ }
  window.dispatchEvent(new CustomEvent('ktracho:ride-alert', { detail: { sound, vibrate } }));
  return { sound, vibrate };
}

// Propina recibida: un «cha-ching» de monedas (notas brillantes que suben y un destello), distinto al de las solicitudes.
// Respeta el mismo silencio que el aviso de solicitudes.
function coins() {
  if (!ctx || ctx.state !== 'running') return false;
  if (playSfx(ctx, 'propina')) return true; // el sonido de propina (si no está listo, el «cha-ching» de abajo)
  const t0 = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.value = 0.45;
  master.connect(ctx.destination);
  const ping = (freq, at, len, type = 'triangle', peak = 0.8) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.value = freq;
    const t = t0 + at;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(peak, t + 0.008);
    g.gain.exponentialRampToValueAtTime(0.0001, t + len);
    o.connect(g).connect(master);
    o.start(t);
    o.stop(t + len + 0.02);
  };
  // «cha»: dos golpecitos metálicos; «ching»: un acorde brillante que se apaga despacio
  ping(2093, 0, 0.09, 'square', 0.25);
  ping(2637, 0.07, 0.09, 'square', 0.25);
  [1568, 2093, 2637, 3136].forEach((f, i) => ping(f, 0.2 + i * 0.045, 0.7 - i * 0.08));
  return true;
}

export function playTipSound() {
  if (!rideSoundOn()) return { sound: false, vibrate: false };
  const sound = coins();
  let vibrate = false;
  try { vibrate = !!navigator.vibrate?.([60, 50, 60, 50, 160]); } catch { /* sin vibración */ }
  window.dispatchEvent(new CustomEvent('ktracho:tip-alert', { detail: { sound, vibrate } }));
  return { sound, vibrate };
}

// ---- Sonidos al cambiar el precio ----
// Respetan el interruptor «Sonido de los avisos» de la campana (mismo para pasajero y conductor).
const BELL_KEY = 'ktracho:bell-sound';
export const appSoundOn = () => { try { return localStorage.getItem(BELL_KEY) !== 'off'; } catch { return true; } };

function ping(freq, at, len, { type = 'triangle', peak = 0.6, glide = 0, gain = 0.3 } = {}) {
  const t = ctx.currentTime + 0.01 + at;
  const master = ctx.createGain();
  master.gain.value = gain;
  master.connect(ctx.destination);
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (glide) o.frequency.exponentialRampToValueAtTime(freq * glide, t + len);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(peak, t + 0.005);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + len + 0.02);
}

// −5 / +5: una monedita corta («tic» metálico). Subiendo, el tono sube un poco; bajando, baja.
// Si se toca muy seguido no se amontonan (como mucho uno cada 70 ms).
let lastTick = 0;
export function playPriceTick(up) {
  let sound = false;
  let vibrate = false;
  if (appSoundOn() && Date.now() - lastTick >= 70) {
    lastTick = Date.now();
    unlockRideAlert();
    if (ctx && ctx.state === 'running') {
      const base = up ? 2350 : 1980;
      ping(base, 0, 0.07, { glide: up ? 1.12 : 0.89, peak: 0.7, gain: 0.22 });
      ping(base * 1.5, 0.012, 0.05, { type: 'sine', peak: 0.35, gain: 0.22 }); // brillo de la moneda
      sound = true;
    }
    try { vibrate = !!navigator.vibrate?.(8); } catch { /* sin vibración (iPhone) */ }
  }
  window.dispatchEvent(new CustomEvent('ktracho:price-tick', { detail: { up: !!up, sound, vibrate } }));
  return { sound, vibrate };
}

// «Subir oferta» mientras busca conductor: una moneda más clara (dos notas que suben), más corta que el «cha-ching» de las propinas
export function playRaiseCoin() {
  let sound = false;
  let vibrate = false;
  if (appSoundOn()) {
    unlockRideAlert();
    if (ctx && ctx.state === 'running') {
      ping(1568, 0, 0.12, { type: 'square', peak: 0.25, gain: 0.3 });
      ping(2349, 0.08, 0.32, { peak: 0.8, gain: 0.3 });
      ping(3136, 0.12, 0.28, { type: 'sine', peak: 0.4, gain: 0.3 });
      sound = true;
    }
    try { vibrate = !!navigator.vibrate?.([20, 40, 20]); } catch { /* sin vibración */ }
  }
  window.dispatchEvent(new CustomEvent('ktracho:raise-coin', { detail: { sound, vibrate } }));
  return { sound, vibrate };
}

// Un efecto de sonido suelto (pagar, propina…) que respeta el interruptor «Sonido de los avisos». Devuelve si sonó.
export function playSound(name, opts) {
  if (!appSoundOn()) return false;
  unlockRideAlert();
  return playSfx(ctx, name, opts);
}

// Sonido al cambiar el estado del viaje (`before` → `now`). Sin `before` (se abrió la app con el viaje ya en curso) no suena nada.
// Pasajero: el conductor llegó (ding_dong). (Al aceptar la oferta suena «pop» en el botón, así que el estado «aceptado» no suena otra vez.) Ambos: el viaje empezó (carrofuera, completo),
// terminó (final) o se canceló (cancelo).
export function playRideTransition(before, now, role) {
  if (!before || before === now) return false;
  if (now === 'cancelled') return playSound('cancelo');
  if (now === 'completed') return playSound('final');
  if (now === 'started') return playSound('carrofuera');
  if (role === 'passenger' && now === 'arrived') {
    try { navigator.vibrate?.([140, 70, 140, 70, 260]); } catch { /* sin vibración (iPhone) */ }
    return playSound('ding_dong');
  }
  return false;
}
