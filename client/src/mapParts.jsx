// Piezas del mapa (Leaflet): íconos, el carro que se desliza, la ruta y el encuadre.
// Van aparte para que la pantalla de entrada y el panel sin mapa no descarguen Leaflet.
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { Marker, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';

// Íconos del mapa dibujados en SVG (no emojis): se ven nítidos y iguales en cualquier celular
const svgIcon = (html, size, anchor, cls) => L.divIcon({ html, className: `map-icon ${cls}`, iconSize: size, iconAnchor: anchor });

// Carro visto desde arriba, con el frente hacia el norte (CarMarker lo gira según hacia dónde va)
export const CAR_SVG = `<svg viewBox="0 0 28 48" width="22" height="38" aria-hidden="true">
  <rect x="1" y="14" width="3.5" height="5" rx="1.6" fill="#086640"/><rect x="23.5" y="14" width="3.5" height="5" rx="1.6" fill="#086640"/>
  <rect x="3" y="2" width="22" height="44" rx="8" fill="#0a7d4f" stroke="#fff" stroke-width="1.6"/>
  <path d="M6.5 14.5Q14 9.5 21.5 14.5L20.5 20.5H7.5Z" fill="#0d1f17" opacity=".88"/>
  <rect x="7.5" y="21.5" width="13" height="11" rx="3" fill="#13a36a"/>
  <path d="M7.5 34H20.5L21.5 39Q14 42 6.5 39Z" fill="#0d1f17" opacity=".78"/>
  <rect x="5.5" y="3.6" width="5" height="2.6" rx="1.3" fill="#fff6bf"/><rect x="17.5" y="3.6" width="5" height="2.6" rx="1.3" fill="#fff6bf"/>
  <rect x="5.5" y="42" width="4" height="2" rx="1" fill="#ff5c5c"/><rect x="18.5" y="42" width="4" height="2" rx="1" fill="#ff5c5c"/>
</svg>`;

// Pin con la punta abajo (marca el punto exacto) y un dibujo dentro
const pin = (fill, inner) => `<svg viewBox="0 0 34 44" width="34" height="44" aria-hidden="true">
  <path d="M17 43s-14-15.2-14-25.5a14 14 0 0 1 28 0C31 27.8 17 43 17 43z" fill="${fill}" stroke="#fff" stroke-width="2"/>
  <circle cx="17" cy="17.5" r="8.5" fill="#fff"/>${inner}</svg>`;
const checks = Array.from({ length: 12 }, (_, i) => ((i % 4) + Math.floor(i / 4)) % 2 ? '' : `<rect x="${14.8 + (i % 4) * 2}" y="${11.5 + Math.floor(i / 4) * 2}" width="2" height="2" fill="#14171c"/>`).join('');
const FLAG = `<rect x="13.2" y="11.5" width="1.6" height="12" rx=".8" fill="#14171c"/><rect x="14.8" y="11.5" width="8" height="6" fill="#fff" stroke="#14171c" stroke-width=".6"/>${checks}`;

export const icons = {
  car: svgIcon(`<div class="car-rot">${CAR_SVG}</div>`, [40, 40], [20, 20], 'car'),
  me: svgIcon(pin('#0a7d4f', '<circle cx="17" cy="17.5" r="4" fill="#0a7d4f"/>'), [34, 44], [17, 43], 'pin'),
  dest: svgIcon(pin('#14171c', FLAG), [34, 44], [17, 43], 'pin'),
};

// Rumbo en grados (0 = norte, 90 = este) para ir del punto a al b
function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return Math.atan2(y, x) / r;
}
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Carro en el mapa: cuando llega una posición nueva se desliza hasta ella (en vez de saltar) y gira hacia donde va.
// `duration` es cada cuánto llegan las posiciones (así termina de moverse justo cuando llega la siguiente).
export function CarMarker({ position, duration = 2800, draggable = false, eventHandlers }) {
  const ref = useRef(null);
  const [start] = useState(() => [position.lat, position.lng]); // la posición inicial queda fija: después la mueve la animación
  const anim = useRef({ angle: 0, frame: 0 });
  useEffect(() => {
    const m = ref.current;
    if (!m) return;
    const a = anim.current;
    cancelAnimationFrame(a.frame);
    const from = m.getLatLng();
    const to = L.latLng(position.lat, position.lng);
    const meters = from.distanceTo(to);
    // Solo gira si de verdad avanzó (el GPS quieto tiembla unos metros); por el camino más corto (de 350° a 10° son 20°)
    if (meters > 6) {
      a.angle += ((((bearing(from, to) - a.angle) % 360) + 540) % 360) - 180;
      const el = m.getElement()?.querySelector('.car-rot');
      if (el) el.style.transform = `rotate(${a.angle}deg)`;
    }
    // Un salto muy largo (se perdió la señal) o arrastrarlo a mano no se anima: atravesaría media ciudad
    if (meters < 0.5 || meters > 1500 || draggable || document.hidden || reducedMotion()) return void m.setLatLng(to);
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / duration);
      m.setLatLng([from.lat + (to.lat - from.lat) * k, from.lng + (to.lng - from.lng) * k]);
      if (k < 1) a.frame = requestAnimationFrame(step);
    };
    a.frame = requestAnimationFrame(step);
  }, [position.lat, position.lng]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelAnimationFrame(anim.current.frame), []);
  return <Marker ref={ref} position={start} icon={icons.car} draggable={draggable} eventHandlers={eventHandlers} zIndexOffset={500} />;
}

// Ruta con borde blanco y sombra suave para que resalte sobre cualquier calle del mapa
export function RouteLine({ positions, color = '#0a7d4f', dashed = false }) {
  const base = { lineCap: 'round', lineJoin: 'round' };
  return (
    <>
      <Polyline positions={positions} interactive={false} pathOptions={{ ...base, color: '#000', opacity: 0.16, weight: 11 }} />
      <Polyline positions={positions} interactive={false} pathOptions={{ ...base, color: '#fff', opacity: 0.95, weight: 8 }} />
      <Polyline positions={positions} interactive={false} pathOptions={{ ...base, color, opacity: 1, weight: 5, dashArray: dashed ? '2 10' : undefined }} />
    </>
  );
}

// Ajusta el mapa para que se vean todos los puntos indicados.
// En el celular la hoja de abajo tapa parte del mapa: se deja ese espacio libre para que la ruta no quede debajo.
export function FitTo({ points }) {
  const map = useMap();
  const key = points.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join('|');
  useEffect(() => {
    const sheet = map.getContainer().closest('.screen')?.querySelector('.sheet');
    const fit = () => {
      const covered = sheet && getComputedStyle(sheet).position === 'absolute' ? sheet.offsetHeight : 0;
      // Arriba hay más margen: el pin se dibuja hacia arriba desde su punto
      if (points.length > 1) map.fitBounds(points, { paddingTopLeft: [40, 64], paddingBottomRight: [40, 40 + covered], maxZoom: 16 });
      else if (points.length === 1) map.setView(points[0], Math.max(map.getZoom(), 15));
    };
    fit();
    if (!sheet || points.length < 2 || typeof ResizeObserver === 'undefined') return;
    // Si la hoja cambia de alto (aparece un aviso, se achica o se agranda) se vuelve a encuadrar, salvo que la persona ya haya movido el mapa
    let moved = false;
    let lastHeight = sheet.offsetHeight;
    let timer;
    const onDrag = () => { moved = true; };
    map.on('dragstart', onDrag);
    const observer = new ResizeObserver(() => {
      if (moved || Math.abs(sheet.offsetHeight - lastHeight) < 24) return;
      lastHeight = sheet.offsetHeight;
      clearTimeout(timer);
      timer = setTimeout(fit, 150);
    });
    observer.observe(sheet);
    return () => { observer.disconnect(); map.off('dragstart', onDrag); clearTimeout(timer); };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}
