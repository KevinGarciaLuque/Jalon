// Aviso al conductor cuando llega una solicitud nueva con la app abierta: un sonido corto (hecho en el momento, sin archivos)
// y una vibración. Con la app cerrada o en segundo plano, el aviso es la notificación del celular (lo manda el servidor).
// Los celulares solo dejan sonar audio después de un toque: `unlockRideAlert()` se llama en un toque (p. ej. «Ponerme disponible»)
// y además con el primer toque en cualquier parte de la pantalla.

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
