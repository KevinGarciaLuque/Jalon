import { CATEGORIES, distanceKm, lempiras } from './lib.js';

// Piezas de la pantalla para pedir viaje: conductores cerca, tipos de viaje con precio y tiempo,
// el medidor de precio y los destinos rápidos.

// Minutos aproximados hasta que llegue el conductor más cercano (ciudad: ~22 km/h, más un minuto para arrancar)
export function etaMinutes(from, list) {
  if (!from || !list.length) return null;
  const km = Math.min(...list.map((d) => distanceKm(from, d)));
  return Math.max(1, Math.round((km / 22) * 60 + 1));
}

// «5 conductores de carro cerca · el más cercano a 3 min» (en vivo)
export function NearbyLine({ count, capped, label, eta }) {
  return (
    <div className="nearby-line" role="status">
      <span className={`live-dot${count ? '' : ' off'}`} aria-hidden="true" />
      <span>
        <b>{count}{capped ? '+' : ''} conductor{count === 1 ? '' : 'es'} de {label.toLowerCase()} cerca</b>
        {eta != null ? <span className="muted"> · el primero llega en {eta} min</span> : <span className="muted"> · por ahora ninguno</span>}
      </span>
    </div>
  );
}

// Tipos de viaje en tarjetas: cuántos hay cerca, en cuánto llega el primero y (con destino) el precio sugerido
export function CategoryCards({ value, onChange, drivers, from, prices }) {
  return (
    <div className="cat-cards" role="radiogroup" aria-label="Tipo de vehículo">
      {CATEGORIES.map(([k, label]) => {
        const list = drivers.filter((d) => (d.category || 'car') === k);
        const eta = etaMinutes(from, list);
        const on = value === k;
        return (
          <button type="button" key={k} role="radio" aria-checked={on} className={on ? 'on' : ''} onClick={() => onChange(k)}>
            <span className="cat-ico" aria-hidden="true">{k === 'moto' ? '🛵' : k === 'xl' ? '🚐' : '🚗'}</span>
            <b>{label}</b>
            {prices && <span className="cat-price">{lempiras(prices[k])}</span>}
            <span className={`cat-eta${eta == null ? ' none' : ''}`}>{eta == null ? 'Sin conductores' : `${eta} min`}</span>
          </button>
        );
      })}
    </div>
  );
}

// ¿Qué tan rápido aceptarán esta oferta? Se compara con el precio sugerido y se ajusta por cuántos conductores hay cerca:
// con pocos, hace falta ofrecer un poco más; con muchos, alcanza con un poco menos. Es una guía, no una promesa.
export function priceLevel(price, suggested, nearCount) {
  if (!price || !suggested) return null;
  if (!nearCount) return { key: 'none', pos: Math.min(1, Math.max(0, (price / suggested - 0.7) / 0.6)) };
  const shift = nearCount <= 2 ? 0.08 : nearCount >= 6 ? -0.05 : 0;
  const ratio = price / suggested;
  const pos = Math.min(1, Math.max(0, (ratio - 0.7) / 0.6)); // de 70 % a 130 % del sugerido
  const key = ratio < 0.92 + shift ? 'slow' : ratio < 1.08 + shift ? 'fair' : 'fast';
  return { key, pos };
}
const LEVEL_TEXT = {
  slow: ['Puede tardar', 'Pocos conductores aceptan este precio. Súbelo un poco para que te acepten antes.'],
  fair: ['Precio justo', 'Es parecido a lo que se paga por este viaje. Lo normal es que te acepten en pocos minutos.'],
  fast: ['Te aceptan rápido', 'Tu oferta está por encima de lo normal: los conductores cercanos la verán primero.'],
  none: ['Sin conductores cerca', 'Ahora no hay conductores de este tipo cerca. Puedes pedir igual: te avisamos cuando alguien oferte.'],
};

export function PriceMeter({ price, suggested, nearCount }) {
  const lvl = priceLevel(Number(price), Number(suggested), nearCount);
  if (!lvl) return null;
  const [title, text] = LEVEL_TEXT[lvl.key];
  return (
    // Una sola línea para no tapar el resto de la hoja: «Precio justo  [====●====]  Sugerido L 75»
    <div className={`price-meter lvl-${lvl.key}`} role="status" aria-live="polite" title={text}>
      <b className="pm-title">{title}</b>
      <span className="pm-track" aria-hidden="true">
        <i className="pm-slow" /><i className="pm-fair" /><i className="pm-fast" />
        <span className="pm-mark" style={{ left: `${lvl.pos * 100}%` }} />
      </span>
      <span className="pm-sug muted small">Sugerido {lempiras(suggested)}</span>
      <span className="sr-only">{text}</span>
    </div>
  );
}

// Destinos rápidos: lugares guardados y recientes. Según la hora sugiere primero Casa (tarde y noche) o Trabajo (mañana).
const PLACE_ICON = { casa: '🏠', trabajo: '💼', escuela: '🎒', universidad: '🎓', gimnasio: '🏋', iglesia: '⛪' };
export function QuickPlaces({ favs, recent, onPick, hour = new Date().getHours() }) {
  const first = hour >= 5 && hour < 11 ? 'trabajo' : hour >= 16 || hour < 2 ? 'casa' : null;
  const sorted = [...favs].sort((a, b) => (b.label.toLowerCase() === first) - (a.label.toLowerCase() === first));
  const others = recent.filter((r) => !favs.some((f) => Math.abs(f.lat - r.lat) < 1e-4 && Math.abs(f.lng - r.lng) < 1e-4));
  if (!sorted.length && !others.length) return null;
  return (
    <div className="quick quick-places" aria-label="Destinos rápidos">
      {sorted.map((f, i) => {
        const suggested = i === 0 && f.label.toLowerCase() === first;
        return (
          <button key={f.id} className={`sm${suggested ? ' suggested' : ''}`} title={f.text} onClick={() => onPick({ lat: f.lat, lng: f.lng, text: f.text })}>
            {PLACE_ICON[f.label.toLowerCase()] || '⭐'} {suggested ? `¿${f.label}?` : f.label}
          </button>
        );
      })}
      {others.map((r) => (
        <button key={`${r.lat},${r.lng}`} className="sm recent" title={r.text} onClick={() => onPick(r)}>🕘 {r.text.split(',')[0]}</button>
      ))}
    </div>
  );
}
