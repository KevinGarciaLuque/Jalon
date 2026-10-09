import { useEffect, useRef, useState } from 'react';
import { useMap } from 'react-leaflet';
import { apiGet, apiPost, pushState, enablePush, disablePush } from './lib.js';

// Campo de contraseña con botón para verla u ocultarla
export function PasswordInput(props) {
  const [show, setShow] = useState(false);
  return (
    <div className="pw">
      <input {...props} type={show ? 'text' : 'password'} autoCapitalize="off" autoCorrect="off" spellCheck={false} />
      <button type="button" className="pw-eye" onClick={() => setShow(!show)} aria-label={show ? 'Ocultar contraseña' : 'Ver contraseña'} aria-pressed={show} title={show ? 'Ocultar contraseña' : 'Ver contraseña'}>
        {show ? '🙈' : '👁'}
      </button>
    </div>
  );
}

// ⭐ 4.8 (12)
export function Stars({ rating }) {
  if (!rating || !rating.count) return <span className="muted">Nuevo</span>;
  return <span className="stars">★ {rating.avg.toFixed(1)} <span className="muted">({rating.count})</span></span>;
}

// Ajusta el mapa para que se vean todos los puntos indicados
export function FitTo({ points }) {
  const map = useMap();
  const key = points.map((p) => `${p[0].toFixed(4)},${p[1].toFixed(4)}`).join('|');
  useEffect(() => {
    if (points.length > 1) map.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
    else if (points.length === 1) map.setView(points[0], Math.max(map.getZoom(), 15));
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
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
          placeholder={placeholder}
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
export function Rate({ token, rideId, who }) {
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

  if (state === 'done') return <div className="hint ok">¡Gracias por tu calificación!</div>;
  return (
    <div className="rate">
      <b>¿Cómo estuvo {who}?</b>
      <div className="starpick">
        {[1, 2, 3, 4, 5].map((n) => (
          <button key={n} type="button" className={n <= stars ? 'on' : ''} onClick={() => setStars(n)} aria-label={`${n} estrellas`}>★</button>
        ))}
      </div>
      {stars > 0 && (
        <>
          <input placeholder="Comentario (opcional)" maxLength={200} value={comment} onChange={(e) => setComment(e.target.value)} />
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
        await navigator.share({ title: 'Sigue mi viaje en Jalón', url }).catch(() => {});
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
            <input value={text} maxLength={500} placeholder="Escribe un mensaje" onChange={(e) => setText(e.target.value)} />
            <button className="primary sm" disabled={busy || !text.trim()}>Enviar</button>
          </form>
        </>
      )}
      {chat.error && <div className="error small">{chat.error}</div>}
    </div>
  );
}
