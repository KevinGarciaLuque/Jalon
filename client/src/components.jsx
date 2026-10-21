import markImg from './assets/logo-marca.webp';
import arrivedImg from './assets/valoracion.webp';
import { useEffect, useRef, useState } from 'react';
import { apiGet, apiPost, pushState, enablePush, disablePush, CATEGORIES } from './lib.js';

// Mientras llegan los datos: líneas que brillan en lugar de un texto suelto. `label` lo leen los lectores de pantalla.
export function Loading({ label = 'Cargando…' }) {
  return (
    <div className="loading" role="status" aria-live="polite">
      <span className="sr">{label}</span>
      <i /><i /><i />
    </div>
  );
}

// Lista vacía: qué falta y, si se puede, qué hacer para que aparezca algo
export function Empty({ title, children }) {
  return (
    <div className="empty">
      <svg viewBox="0 0 64 64" aria-hidden="true">
        <circle cx="32" cy="32" r="30" fill="var(--brand-soft)" />
        <path d="M18 39h28l-3.5-11a3 3 0 0 0-2.9-2H24.4a3 3 0 0 0-2.9 2z" fill="var(--brand)" />
        <circle cx="24" cy="41" r="3.5" fill="var(--text)" />
        <circle cx="40" cy="41" r="3.5" fill="var(--text)" />
      </svg>
      <b>{title}</b>
      {children && <span>{children}</span>}
    </div>
  );
}

// Campo de contraseña con botón para verla u ocultarla
export function PasswordInput(props) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw">
      <input {...props} type={show ? 'text' : 'password'} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <button type="button" className="pw-eye" onClick={() => setShow(!show)} aria-label={show ? 'Ocultar contraseña' : 'Ver contraseña'} aria-pressed={show} title={show ? 'Ocultar contraseña' : 'Ver contraseña'}>
        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          {show ? (
            <>
              <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
              <path d="M1 1l22 22" />
            </>
          ) : (
            <>
              <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
              <circle cx="12" cy="12" r="3" />
            </>
          )}
        </svg>
      </button>
    </div>
  );
}

// ⭐ 4.8 (12)
export function Stars({ rating }) {
  if (!rating || !rating.count) return <span className="muted">Nuevo</span>;
  return <span className="stars">★ {rating.avg.toFixed(1)} <span className="muted">({rating.count})</span></span>;
}

// Datos del vehículo: categoría, marca, modelo, color, año y placa. `value` es un objeto con esos campos.
export function VehicleFields({ value, onChange }) {
  const set = (k) => (e) => onChange({ ...value, [k]: e.target.value });
  return (
    <>
      <div className="seg" role="radiogroup" aria-label="Tipo de vehículo">
        {CATEGORIES.map(([k, label]) => (
          <button type="button" key={k} role="radio" aria-checked={value.category === k} className={value.category === k ? 'on' : ''} onClick={() => onChange({ ...value, category: k })}>{label}</button>
        ))}
      </div>
      <div className="row">
        <input aria-label="Marca" placeholder="Marca" maxLength={40} value={value.make || ''} onChange={set('make')} />
        <input aria-label="Modelo" placeholder="Modelo" maxLength={100} value={value.model || ''} onChange={set('model')} required />
      </div>
      <div className="row">
        <input aria-label="Color" placeholder="Color" maxLength={30} value={value.color || ''} onChange={set('color')} />
        <input aria-label="Año" placeholder="Año" inputMode="numeric" maxLength={4} value={value.year || ''} onChange={(e) => onChange({ ...value, year: e.target.value.replace(/\D/g, '') })} />
      </div>
      <input aria-label="Placa" placeholder="Placa (ej. HAA 1234)" maxLength={20} value={value.plate || ''} onChange={set('plate')} required />
    </>
  );
}

// Iniciales para el círculo de cada persona (no guardamos fotos de pasajeros)
const initials = (name = '') => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
export function Avatar({ name }) {
  return <span className="avatar" aria-hidden="true">{initials(name)}</span>;
}

// Cuánto le queda a una oferta: un anillo que se vacía (rojo en los últimos 15 s) en lugar de un número que cambia
export function TimeRing({ left, total }) {
  const r = 15;
  const len = 2 * Math.PI * r;
  const k = Math.max(0, Math.min(1, left / total));
  const secs = Math.max(0, Math.ceil(left));
  return (
    <svg className={`ring${secs <= 15 ? ' late' : ''}`} viewBox="0 0 38 38" role="img" aria-label={`Quedan ${secs} segundos`}>
      <circle className="bg" cx="19" cy="19" r={r} />
      <circle className="fg" cx="19" cy="19" r={r} strokeDasharray={len} strokeDashoffset={len * (1 - k)} />
      <text x="19" y="23" textAnchor="middle">{secs}</text>
    </svg>
  );
}

// Precio en lempiras: se ajusta de 5 en 5 con los botones (o se escribe) y se ve grande en mango
export function PriceStepper({ value, onChange, step = 5, min = 10, label = 'Precio en lempiras' }) {
  const n = Number(value) || 0;
  return (
    <div className="price">
      <button type="button" aria-label={`Bajar ${step} lempiras`} onClick={() => onChange(String(Math.max(min, n - step)))}>−{step}</button>
      <label className="amt">
        <span aria-hidden="true">L</span>
        <input aria-label={label} inputMode="numeric" value={value} style={{ width: `${Math.max(2, String(value).length) + 0.6}ch` }} onChange={(e) => onChange(e.target.value.replace(/\D/g, ''))} />
      </label>
      <button type="button" aria-label={`Subir ${step} lempiras`} onClick={() => onChange(String(n + step))}>+{step}</button>
    </div>
  );
}

// Campo para buscar una dirección por nombre (Honduras)
export function AddressSearch({ token, near, placeholder, value, onPick, icon }) {
  const [q, setQ] = useState(value || '');
  const [results, setResults] = useState([]);
  const [msg, setMsg] = useState('');
  const typed = useRef(false);

  // Si el punto se elige desde el mapa, se refleja en el campo
  useEffect(() => { typed.current = false; setQ(value || ''); setResults([]); }, [value]);

  useEffect(() => {
    if (!typed.current) return;
    if (q.trim().length < 3) { setResults([]); setMsg(''); return; }
    const t = setTimeout(async () => {
      try {
        const near_ = near ? `&lat=${near.lat}&lng=${near.lng}` : '';
        const { results } = await apiGet(`places?q=${encodeURIComponent(q.trim())}${near_}`, token);
        setResults(results);
        setMsg(results.length ? '' : 'Sin resultados. Prueba otro nombre o toca el mapa.');
      } catch (e) {
        setResults([]);
        setMsg(e.message);
      }
    }, 450);
    return () => clearTimeout(t);
  }, [q]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="search">
      <div className="field">
        <span>{icon}</span>
        <input
          aria-label={placeholder} placeholder={placeholder}
          value={q}
          onChange={(e) => { typed.current = true; setQ(e.target.value); }}
          onFocus={(e) => e.target.select()}
        />
      </div>
      {msg && <div className="muted small">{msg}</div>}
      {results.length > 0 && (
        <ul className="suggest">
          {results.map((r, i) => (
            <li key={i}>
              <button type="button" onClick={() => { typed.current = false; setResults([]); setQ(r.text); onPick(r); }}>{r.text}</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// Calificar al otro participante después del viaje
// Marca: el símbolo del logo y el nombre (el nombre va como texto: se lee bien en modo oscuro y lo leen los lectores de pantalla)
export function Brand({ size = 'sm' }) {
  return <span className={`brand ${size}`}><img src={markImg} alt="" /><b>Ktracho <i>GO</i></b></span>;
}

// Calificar al terminar el viaje, con el carro y sus 5 estrellas
export function Rate({ token, rideId, who, title }) {
  const [stars, setStars] = useState(0);
  const [comment, setComment] = useState('');
  const [state, setState] = useState('idle'); // idle | sending | done
  const [error, setError] = useState('');

  async function send() {
    setState('sending');
    try {
      await apiPost(`rides/${rideId}/rate`, token, { stars, comment });
      setState('done');
    } catch (e) {
      if (e.message === 'Ya calificaste este viaje') return setState('done');
      setError(e.message);
      setState('idle');
    }
  }

  const art = <img className="rate-art" src={arrivedImg} alt="" width="240" height="169" />;
  if (state === 'done') return <div className="rate">{art}<div className="hint ok">¡Gracias por tu calificación!</div></div>;
  return (
    <div className="rate">
      {art}
      {title && <b className="rate-title">{title}</b>}
      <b>¿Cómo estuvo {who}?</b>
      <div className="starpick">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className={n <= stars ? 'on' : ''} onClick={() => setStars(n)} aria-label={`${n} estrellas`}>★</button>
        ))}
      </div>
      {stars > 0 && (
        <>
          <input aria-label="Comentario (opcional)" placeholder="Comentario (opcional)" maxLength={200} value={comment} onChange={(e) => setComment(e.target.value)} />
          {error && <div className="error">{error}</div>}
          <button className="primary" disabled={state === 'sending'} onClick={send}>Enviar calificación</button>
        </>
      )}
    </div>
  );
}

// Compartir viaje y botón de emergencia durante un viaje activo
export function SafetyBar({ token, rideId, socket, getPos }) {
  const [note, setNote] = useState('');
  const [sos, setSos] = useState(false);

  async function share() {
    try {
      const { token: t } = await apiPost(`rides/${rideId}/share`, token);
      const url = `${window.location.origin}/t/${t}`;
      if (navigator.share) {
        await navigator.share({ title: 'Sigue mi viaje en Ktracho GO', url }).catch(() => {});
      } else if (navigator.clipboard) {
        await navigator.clipboard.writeText(url);
        setNote('Enlace copiado. Envíalo a un familiar.');
      } else {
        window.prompt('Copia este enlace y envíalo a un familiar:', url);
      }
    } catch (e) {
      setNote(e.message);
    }
  }

  function emergency() {
    if (!window.confirm('¿Enviar una alerta de emergencia a soporte con tu ubicación?')) return;
    socket.emit('ride:sos', getPos?.() || null, (res) => {
      if (res?.ok) setSos(true);
      else setNote(res?.error || 'No se pudo enviar la alerta');
    });
  }

  return (
    <div className="safety">
      <div className="row">
        <button className="sm" onClick={share}>📤 Compartir viaje</button>
        <button className="sos sm" onClick={emergency}>🆘 Emergencia</button>
      </div>
      {note && <div className="muted small">{note}</div>}
      {sos && (
        <div className="hint danger">
          Alerta enviada a soporte. Si estás en peligro, llama al <a href="tel:911"><b>911</b></a> ahora.
        </div>
      )}
    </div>
  );
}

// Botón para activar o desactivar las notificaciones en este dispositivo
export function PushToggle({ token, why }) {
  const [state, setState] = useState(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => { pushState().then(setState).catch(() => setState('unsupported')); }, []);

  async function toggle() {
    setBusy(true);
    setError('');
    try {
      if (state === 'on') await disablePush(token); else await enablePush(token);
      setState(await pushState());
    } catch (e) {
      setError(e.message);
      setState(await pushState().catch(() => 'off'));
    } finally {
      setBusy(false);
    }
  }

  if (state === null) return null;
  if (state === 'unsupported') return <p className="muted small">Las notificaciones funcionan en la app instalada o en el sitio publicado (en iPhone, primero agrégala a la pantalla de inicio).</p>;
  return (
    <div className="push">
      {why && state !== 'on' && <p className="muted small">{why}</p>}
      {state === 'denied' ? (
        <div className="error small">Bloqueaste las notificaciones de este sitio. Actívalas en la configuración del navegador.</div>
      ) : (
        <button className={state === 'on' ? '' : 'primary'} disabled={busy} onClick={toggle}>
          {state === 'on' ? '🔔 Notificaciones activadas (tocar para desactivar)' : '🔔 Activar notificaciones'}
        </button>
      )}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

// Ventana del chat del viaje. React escapa el texto: aunque alguien escriba código, se ve como texto y no se ejecuta.
export function Chat({ chat, meId, quick = [] }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const end = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [chat.messages.length, chat.open]);

  async function send(t) {
    const body = (t ?? text).trim();
    if (!body || busy) return;
    setBusy(true);
    const r = await chat.send(body);
    if (r?.ok && t === undefined) setText('');
    setBusy(false);
  }
  const time = (d) => new Date(d).toLocaleTimeString('es-HN', { hour: '2-digit', minute: '2-digit' });

  return (
    <div className="chat" data-testid="chat">
      <div className="chat-list">
        {chat.messages.length === 0 && <p className="muted small center">Escribe para coordinar la recogida. Los teléfonos no se comparten.</p>}
        {chat.messages.map((m) => (
          <div key={m.id} className={`bubble ${m.senderId === meId ? 'mine' : 'theirs'}`}>
            <span>{m.text}</span>
            <small>{time(m.at)}{m.senderId === meId && (m.read ? ' ✓✓' : ' ✓')}</small>
          </div>
        ))}
        <div ref={end} />
      </div>
      {chat.closed ? (
        <p className="muted small center">El chat de este viaje ya está cerrado.</p>
      ) : (
        <>
          <div className="quick">
            {quick.map((q) => <button key={q} type="button" className="sm" disabled={busy} onClick={() => send(q)}>{q}</button>)}
          </div>
          <form className="chat-input" onSubmit={(e) => { e.preventDefault(); send(); }}>
            <input value={text} maxLength={500} aria-label="Escribe un mensaje" placeholder="Escribe un mensaje" onChange={(e) => setText(e.target.value)} />
            <button className="primary sm" disabled={busy || !text.trim()}>Enviar</button>
          </form>
        </>
      )}
      {chat.error && <div className="error small">{chat.error}</div>}
    </div>
  );
}
