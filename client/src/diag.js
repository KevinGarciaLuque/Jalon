// Diagnóstico de pantalla (para soporte): toca 7 veces seguidas el logo «Ktracho GO» del encabezado (o abre la app con ?diag=1).
// Muestra el tamaño de la pantalla y qué reglas del diseño de celular se están aplicando. Tocar el cuadro lo cierra.
const q = (s) => document.querySelector(s);
const mm = (s) => { try { return window.matchMedia(s).matches; } catch { return 'error'; } };
const css = (s, p) => { const e = q(s); return e ? getComputedStyle(e)[p] : '—'; };
const box = (s) => { const e = q(s); if (!e) return '—'; const r = e.getBoundingClientRect(); return `${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}×${Math.round(r.height)}`; };

function lines() {
  return [
    `pantalla ${innerWidth}×${innerHeight} · screen ${screen.width}×${screen.height} · dpr ${devicePixelRatio}`,
    `instalada: ${navigator.standalone === true || mm('(display-mode: standalone)')}`,
    `ancho<700: ${mm('(max-width: 699px)')} · vertical: ${mm('(orientation: portrait)')} · ambas: ${mm('(max-width: 699px) and (orientation: portrait)')}`,
    `ancho≥700: ${mm('(min-width: 700px)')} · reducir mov.: ${mm('(prefers-reduced-motion: reduce)')}`,
    `.screen flex-dir: ${css('.screen', 'flexDirection')} · pos: ${css('.screen', 'position')}`,
    `.map pos: ${css('.screen .map', 'position')} · ${box('.screen .map')}`,
    `.sheet pos: ${css('.screen .sheet', 'position')} · max-h: ${css('.screen .sheet', 'maxHeight')} · ${box('.screen .sheet')}`,
    `.grab display: ${css('.grab', 'display')} · ${box('.grab')}`,
    `créditos mapa top: ${css('.leaflet-bottom.leaflet-right', 'top')}`,
    navigator.userAgent.replace(/Mozilla\/5.0 /, '').slice(0, 120),
  ].join('\n');
}

function show() {
  let d = q('#ktracho-diag');
  if (d) { d.remove(); return; }
  d = document.createElement('pre');
  d.id = 'ktracho-diag';
  d.style.cssText = 'position:fixed;left:6px;right:6px;top:70px;z-index:99999;margin:0;padding:10px;border-radius:10px;background:rgba(0,0,0,.92);color:#7CFC9A;font:11px/1.45 monospace;white-space:pre-wrap;word-break:break-word';
  d.addEventListener('click', () => d.remove());
  const paint = () => { d.textContent = `${lines()}\n\n(toca para cerrar)`; };
  paint();
  document.body.appendChild(d);
}

export function setupDiag() {
  if (/[?&]diag=1/.test(location.search)) window.addEventListener('load', () => setTimeout(show, 1500));
  let taps = 0;
  let last = 0;
  document.addEventListener('click', (e) => {
    if (!e.target.closest?.('.brand')) { taps = 0; return; }
    const now = Date.now();
    taps = now - last < 900 ? taps + 1 : 1;
    last = now;
    if (taps >= 7) { taps = 0; show(); }
  }, true);
}
