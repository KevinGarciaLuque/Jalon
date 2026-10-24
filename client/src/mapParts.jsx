// Piezas del mapa (Leaflet): íconos, el carro que se desliza, la ruta y el encuadre.
// Van aparte para que la pantalla de entrada y el panel sin mapa no descarguen Leaflet.
import 'leaflet/dist/leaflet.css';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Marker, Polyline, useMap } from 'react-leaflet';
import L from 'leaflet';
import './leafletGlobal.js';
import 'leaflet-rotate'; // el mapa puede girar (como Waze)
import { mapPrefs } from './lib.js';

// Opciones de MapContainer para que el mapa pueda girar (si el superadmin no lo apagó). El giro lo manejan MapControls.
export const rotateOptions = () => (mapPrefs.rotation ? { rotate: true, bearing: 0, touchRotate: true, rotateControl: false } : {});
const mapBearing = (map) => (map.options.rotate && map.getBearing ? map.getBearing() || 0 : 0);
import carImg from './assets/carro.png';

// Íconos del mapa dibujados en SVG (no emojis): se ven nítidos y iguales en cualquier celular
const svgIcon = (html, size, anchor, cls) => L.divIcon({ html, className: `map-icon ${cls}`, iconSize: size, iconAnchor: anchor });

// Carro visto desde arriba (verde Ktracho GO, con las 5 estrellas en el techo), con el frente hacia el norte: CarMarker lo gira según hacia dónde va
export const CAR_HTML = `<img src="${carImg}" alt="" width="22" height="48">`;

// Pin con la punta abajo (marca el punto exacto) y un dibujo dentro
const pin = (fill, inner) => `<svg viewBox="0 0 34 44" width="34" height="44" aria-hidden="true">
  <path d="M17 43s-14-15.2-14-25.5a14 14 0 0 1 28 0C31 27.8 17 43 17 43z" fill="${fill}" stroke="#fff" stroke-width="2"/>
  <circle cx="17" cy="17.5" r="8.5" fill="#fff"/>${inner}</svg>`;
const checks = Array.from({ length: 12 }, (_, i) => ((i % 4) + Math.floor(i / 4)) % 2 ? '' : `<rect x="${14.8 + (i % 4) * 2}" y="${11.5 + Math.floor(i / 4) * 2}" width="2" height="2" fill="#14171c"/>`).join('');
const FLAG = `<rect x="13.2" y="11.5" width="1.6" height="12" rx=".8" fill="#14171c"/><rect x="14.8" y="11.5" width="8" height="6" fill="#fff" stroke="#14171c" stroke-width=".6"/>${checks}`;

export const icons = {
  car: svgIcon(`<div class="car-rot">${CAR_HTML}</div>`, [48, 48], [24, 24], 'car'),
  me: svgIcon(pin('#14802f', '<circle cx="17" cy="17.5" r="4" fill="#14802f"/>'), [34, 44], [17, 43], 'pin'),
  dest: svgIcon(pin('#14171c', FLAG), [34, 44], [17, 43], 'pin'),
  // Paradas en el camino, con su número
  stop: (n) => svgIcon(pin('#f59e0b', `<text x="17" y="21.5" text-anchor="middle" font-size="11" font-weight="800" font-family="sans-serif" fill="#7a4a00">${n}</text>`), [34, 44], [17, 43], 'pin'),
};

// Rumbo en grados (0 = norte, 90 = este) para ir del punto a al b
export function bearing(a, b) {
  const r = Math.PI / 180;
  const y = Math.sin((b.lng - a.lng) * r) * Math.cos(b.lat * r);
  const x = Math.cos(a.lat * r) * Math.sin(b.lat * r) - Math.sin(a.lat * r) * Math.cos(b.lat * r) * Math.cos((b.lng - a.lng) * r);
  return Math.atan2(y, x) / r;
}
const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

// Carro en el mapa: cuando llega una posición nueva se desliza hasta ella (en vez de saltar) y gira hacia donde va.
// `duration` es cada cuánto llegan las posiciones (así termina de moverse justo cuando llega la siguiente).
export function CarMarker({ position, duration = 2800, draggable = false, eventHandlers }) {
  const map = useMap();
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
      turnCar();
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
  // Al girar el mapa, el carro gira con él (así sigue apuntando a la calle por donde va)
  function turnCar() {
    const el = ref.current?.getElement()?.querySelector('.car-rot');
    if (el) el.style.transform = `rotate(${anim.current.angle + mapBearing(map)}deg)`;
  }
  useEffect(() => {
    map.on('rotate', turnCar);
    return () => map.off('rotate', turnCar);
  }, [map]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => cancelAnimationFrame(anim.current.frame), []);
  return <Marker ref={ref} position={start} icon={icons.car} draggable={draggable} eventHandlers={eventHandlers} zIndexOffset={500} />;
}

// Ruta con borde blanco y sombra suave para que resalte sobre cualquier calle del mapa
export function RouteLine({ positions, color = '#14802f', dashed = false }) {
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
// Cuánto del mapa tapa la hoja de abajo (en el celular la hoja va encima del mapa)
function coveredHeight(map) {
  const sheet = map.getContainer().closest('.screen')?.querySelector('.sheet');
  return sheet && getComputedStyle(sheet).position === 'absolute' ? Math.min(sheet.offsetHeight, map.getSize().y * 0.7) : 0;
}

// El centro del mapa para que `latlng` quede en medio de la parte que se ve (no debajo de la hoja)
function visibleCenter(map, latlng) {
  const size = map.getSize();
  const p = map.latLngToContainerPoint(latlng);
  const want = L.point(size.x / 2, (size.y - coveredHeight(map)) / 2);
  return map.containerPointToLatLng(L.point(size.x / 2 + p.x - want.x, size.y / 2 + p.y - want.y));
}

// Muestra `latlng` con ese acercamiento, en medio de la parte visible del mapa
export function showAt(map, latlng, zoom = map.getZoom()) {
  map.setView(latlng, zoom, { animate: false });
  map.panTo(visibleCenter(map, latlng), { animate: false });
}

export function fitPoints(map, points) {
  const covered = coveredHeight(map);
  if (!points.length) return;
  if (mapBearing(map)) map.setBearing(0); // la ruta completa se ve mejor con el norte arriba
  map.fire('kt:fit');
  // Arriba hay más margen: el pin se dibuja hacia arriba desde su punto
  if (points.length > 1) map.fitBounds(points, { paddingTopLeft: [40, 64], paddingBottomRight: [40, 40 + covered], maxZoom: 16 });
  else map.setView(points[0], Math.max(map.getZoom(), 15));
}

export function FitTo({ points }) {
  const map = useMap();
  const key = points.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join('|');
  useEffect(() => {
    const sheet = map.getContainer().closest('.screen')?.querySelector('.sheet');
    const fit = () => fitPoints(map, points);
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

// ---- Botones del mapa (arriba a la derecha): brújula, «Mi ubicación» y «Ver todo el viaje» ----
// `me`: tu posición (o la del carro en el seguimiento) · `course`: rumbo y velocidad del GPS · `route`: puntos del viaje
// `modeKey`: cada pantalla recuerda en este aparato si el mapa va con el norte arriba o según hacia dónde vas
// `defaultMode`: 'north' | 'heading' · `follow`: si al abrir sigue a `me` · `meLabel`: cómo se llama el botón de centrar
const MOVING = 1.4; // m/s (unos 5 km/h): más lento no gira el mapa (parado en un semáforo, el GPS tiembla)
const ICON = {
  me: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>',
  route: '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 4h5M4 4v5M20 20h-5M20 20v-5M20 4h-5M20 4v5M4 20h5M4 20v-5"/></svg>',
};
const readMode = (key, fallback) => { try { return localStorage.getItem(`ktracho:map-mode:${key}`) || fallback; } catch { return fallback; } };

export function MapControls({ me, course, route, modeKey = 'map', defaultMode = 'north', follow: startFollowing = false, meLabel = 'Mi ubicación', resumeOn = null }) {
  const map = useMap();
  const canRotate = !!map.options.rotate;
  const [box, setBox] = useState(null);
  const [mode, setMode] = useState(() => (canRotate ? readMode(modeKey, defaultMode) : 'north'));
  const [follow, setFollow] = useState(startFollowing);
  const [angle, setAngle] = useState(0); // giro del mapa en pantalla
  const [toast, setToast] = useState('');
  const last = useRef(null); // última posición con la que se calculó el rumbo
  const heading = useRef(null); // rumbo actual (grados desde el norte)
  const tween = useRef({ frame: 0, ours: false });
  const toastTimer = useRef(0);
  const headingMode = canRotate && mode === 'heading';

  // El contenedor de los botones es un control de Leaflet; tocarlos no marca puntos en el mapa
  useEffect(() => {
    const control = L.control({ position: 'topright' });
    control.onAdd = () => {
      const el = L.DomUtil.create('div', 'map-tools leaflet-control');
      L.DomEvent.disableClickPropagation(el);
      L.DomEvent.disableScrollPropagation(el);
      return el;
    };
    control.addTo(map);
    setBox(control.getContainer());
    return () => control.remove();
  }, [map]);

  // Girar el mapa suave (por el camino más corto) hasta `target` grados
  function rotateTo(target) {
    if (!canRotate) return;
    const t = tween.current;
    cancelAnimationFrame(t.frame);
    const from = mapBearing(map);
    const delta = ((((target - from) % 360) + 540) % 360) - 180;
    if (Math.abs(delta) < 1) return;
    const t0 = performance.now();
    const step = (now) => {
      const k = Math.min(1, (now - t0) / 450);
      t.ours = true;
      map.setBearing(from + delta * (1 - (1 - k) ** 2));
      t.ours = false;
      if (k < 1) t.frame = requestAnimationFrame(step);
    };
    t.frame = requestAnimationFrame(step);
  }

  useEffect(() => {
    const onRotate = () => {
      setAngle(mapBearing(map));
      // Si la persona giró el mapa con dos dedos, deja de girar solo
      if (!tween.current.ours && mode === 'heading') { setMode('north'); setFollow(false); }
    };
    const stop = () => setFollow(false);
    map.on('rotate', onRotate);
    map.on('dragstart', stop);
    map.on('kt:fit', stop);
    return () => { map.off('rotate', onRotate); map.off('dragstart', stop); map.off('kt:fit', stop); };
  }, [map, mode]);
  useEffect(() => () => cancelAnimationFrame(tween.current.frame), []);
  // `resumeOn` cambia (p. ej. empezó el viaje): el mapa vuelve a seguirte
  useEffect(() => { if (resumeOn) centerOnMe(); }, [resumeOn]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cada posición nueva: se calcula hacia dónde vas y, si el mapa te sigue, se mueve (y gira si corresponde)
  useEffect(() => {
    if (!me) return;
    const now = Date.now();
    const prev = last.current;
    if (!prev) last.current = { ...me, t: now };
    else {
      const meters = map.distance([prev.lat, prev.lng], [me.lat, me.lng]);
      if (meters > 8) {
        const speed = course?.speed ?? meters / Math.max(1, (now - prev.t) / 1000);
        if (speed >= MOVING) heading.current = course?.heading ?? bearing(prev, me);
        last.current = { ...me, t: now };
      }
    }
    if (!follow) return;
    if (headingMode && heading.current != null) rotateTo(-heading.current);
    map.panTo(visibleCenter(map, [me.lat, me.lng]), { animate: true, duration: 0.6 });
  }, [me?.lat, me?.lng]); // eslint-disable-line react-hooks/exhaustive-deps

  const say = (text) => { setToast(text); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast(''), 1800); };
  function centerOnMe() {
    if (!me) return;
    setFollow(true);
    showAt(map, [me.lat, me.lng], Math.max(map.getZoom(), 16));
    if (headingMode && heading.current != null) rotateTo(-heading.current);
  }
  function setModeSaved(next) {
    setMode(next);
    try { localStorage.setItem(`ktracho:map-mode:${modeKey}`, next); } catch { /* sin almacenamiento: dura hasta cerrar */ }
  }
  // La brújula: gira el mapa según hacia dónde vas ↔ norte arriba (si el giro está apagado, solo te centra)
  function onCompass() {
    if (!canRotate) return centerOnMe();
    if (headingMode) {
      setModeSaved('north');
      rotateTo(0);
      return say('Norte arriba');
    }
    if (Math.abs(angle) > 1) { rotateTo(0); return say('Norte arriba'); }
    setModeSaved('heading');
    say('El mapa gira según hacia dónde vas');
    centerOnMe();
  }

  if (!box) return null;
  const compassLabel = !canRotate ? 'El norte está arriba. Tocar para ir a tu ubicación'
    : headingMode ? 'El mapa gira según hacia dónde vas. Tocar para poner el norte arriba'
    : 'Norte arriba. Tocar para que el mapa gire según hacia dónde vas';
  return createPortal(
    <>
      <button type="button" className={`map-btn compass${headingMode ? ' on' : ''}`} aria-label={compassLabel} title={compassLabel} onClick={onCompass}>
        <svg viewBox="0 0 24 24" aria-hidden="true" style={{ transform: `rotate(${angle}deg)` }}>
          <path d="M12 1.5l5 10.5H7z" fill="#d93025" /><path d="M12 22.5l-5-10.5h10z" fill="#9aa5a0" />
        </svg>
        <b aria-hidden="true" style={{ transform: `rotate(${angle}deg)` }}>N</b>
      </button>
      {me && (
        <button type="button" className={`map-btn${follow ? ' on' : ''}`} aria-label={meLabel} aria-pressed={follow} title={meLabel} onClick={centerOnMe}
          dangerouslySetInnerHTML={{ __html: ICON.me }} />
      )}
      {route?.length > 1 && (
        <button type="button" className="map-btn" aria-label="Ver todo el viaje" title="Ver todo el viaje" onClick={() => fitPoints(map, route)}
          dangerouslySetInnerHTML={{ __html: ICON.route }} />
      )}
      {toast && <span className="map-toast" role="status">{toast}</span>}
    </>,
    box
  );
}
