import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiGet, apiPost } from './lib.js';
import { Empty, PushToggle } from './components.jsx';
import { Icon, Panel } from './Menu.jsx';
import { playSfx } from './sfx.js';

// La campanita: avisos de chat, ofertas, viajes, saldo, alquileres, reportes y emergencias (lo que corresponda a cada persona)
const ICON = { chat: '💬', offer: '💵', ride: '🚗', wallet: '💰', report: '📝', rental: '🔑', sos: '🆘', docs: '📄', rating: '⭐', account: '✅', info: '🔔' };
const STAFF_POLL_MS = 20000; // el personal no usa el tiempo real: se revisa cada 20 s

// ---- Sonido: dos notas cortas y suaves cuando llega un aviso con la app abierta ----
// (con la app cerrada o minimizada suena la notificación del propio celular). Se puede apagar desde la campanita.
const SOUND_KEY = 'ktracho:bell-sound';
const soundOn = () => { try { return localStorage.getItem(SOUND_KEY) !== 'off'; } catch { return true; } };
let audio = null;
// El navegador solo deja sonar después de que la persona toque algo: el primer toque en la app deja listo el sonido
if (typeof window !== 'undefined') {
  const unlock = () => {
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      audio.resume?.();
    } catch { /* sin audio en este navegador */ }
  };
  window.addEventListener('pointerdown', unlock, { once: true, capture: true });
  window.addEventListener('keydown', unlock, { once: true, capture: true });
}
export function chime() {
  if (!audio || !soundOn() || document.hidden) return;
  if (playSfx(audio, 'notificacion')) return; // el sonido de notificación (si no está listo, las dos notas de abajo)
  const now = audio.currentTime;
  [[880, 0], [1318.5, 0.13]].forEach(([freq, at]) => {
    const o = audio.createOscillator();
    const g = audio.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, now + at);
    g.gain.exponentialRampToValueAtTime(0.18, now + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.32);
    o.connect(g);
    g.connect(audio.destination);
    o.start(now + at);
    o.stop(now + at + 0.34);
  });
}

// El sonido propio de un aviso (si todavía no está listo, suena el de siempre)
function own(name) {
  if (!audio || !soundOn() || document.hidden) return;
  if (!playSfx(audio, name)) chime();
}

function ago(at) {
  const s = Math.max(0, (Date.now() - new Date(at).getTime()) / 1000);
  if (s < 60) return 'ahora';
  if (s < 3600) return `hace ${Math.floor(s / 60)} min`;
  if (s < 86400) return `hace ${Math.floor(s / 3600)} h`;
  return new Date(at).toLocaleDateString('es-HN', { day: 'numeric', month: 'short' });
}

// `socket`: pasajeros y conductores (avisos al momento). `onGo(target)`: llevar a la pantalla del aviso al tocarlo.
export default function Bell({ socket, onGo }) {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState(null);
  const [error, setError] = useState('');
  const [sound, setSound] = useState(soundOn);
  const lastCount = useRef(null); // para el personal: suena si el número sube entre una revisión y otra

  const loadList = useCallback(() => apiGet('notifications').then((r) => { setItems(r.items); setUnread(r.unread); }).catch((e) => setError(e.message)), []);
  const loadCount = useCallback(() => apiGet('notifications/unread').then((r) => setUnread(r.unread)).catch(() => {}), []);

  const lastId = useRef(null); // el aviso más nuevo que ya se conocía (personal): para saber de qué es lo que llegó
  useEffect(() => {
    loadCount();
    if (!socket) apiGet('notifications').then((r) => { lastId.current = Math.max(0, ...r.items.map((i) => i.id)); }).catch(() => {});
  }, [loadCount, socket]);
  useEffect(() => { window.__ktUnread = unread; window.dispatchEvent(new CustomEvent('ktracho:unread', { detail: unread })); }, [unread]);
  // El panel del personal revisa cada 20 s: si hay más avisos sin leer que antes, suena
  useEffect(() => {
    if (socket) return;
    if (lastCount.current !== null && unread > lastCount.current) staffSound();
    lastCount.current = unread;
  }, [unread, socket]);

  // Personal: llegó un aviso nuevo. Si es una solicitud de recarga suena «propina»; si no, el sonido de siempre.
  async function staffSound() {
    try {
      const r = await apiGet('notifications');
      const before = lastId.current ?? Infinity;
      lastId.current = Math.max(before === Infinity ? 0 : before, ...r.items.map((i) => i.id));
      if (r.items.some((i) => !i.read && i.id > before && i.kind === 'wallet' && String(i.tag || '').startsWith('topup-'))) return own('propina');
    } catch { /* sin conexión: suena el de siempre */ }
    chime();
  }

  function toggleSound() {
    const next = !sound;
    setSound(next);
    try { localStorage.setItem(SOUND_KEY, next ? 'on' : 'off'); } catch { /* sin almacenamiento: dura hasta recargar */ }
    if (next) chime();
  }
  useEffect(() => {
    if (socket) {
      // Los avisos del viaje (aceptado, llegó, empezó, terminó, cancelado) y las propinas ya tienen su propio sonido: la campanita no suena encima
      // Si el aviso trae su propio sonido (p. ej. «Recarga aprobada» → cobrar), suena ese en vez del de la campanita
      const fresh = ({ unread: n, kind, tag, sound }) => { setUnread(n); if (sound) own(sound); else if (kind !== 'ride' && !String(tag || '').startsWith('tip-') && !(kind === 'chat' && window.__ktChatOpen)) chime(); if (open) loadList(); };
      const read = ({ unread: n }) => setUnread(n);
      socket.on('notify:new', fresh);
      socket.on('notify:read', read);
      return () => { socket.off('notify:new', fresh); socket.off('notify:read', read); };
    }
    const t = setInterval(() => { if (!document.hidden) (open ? loadList : loadCount)(); }, STAFF_POLL_MS);
    return () => clearInterval(t);
  }, [socket, open, loadList, loadCount]);

  function show() {
    setOpen(true);
    setError('');
    loadList();
  }
  // «Notificaciones» en el menú abre esta misma lista
  useEffect(() => {
    window.addEventListener('ktracho:bell', show);
    return () => window.removeEventListener('ktracho:bell', show);
  });
  async function go(n) {
    if (!n.read) {
      setItems((list) => list.map((x) => (x.id === n.id ? { ...x, read: true } : x)));
      apiPost('notifications/read', null, { ids: [n.id] }).then((r) => setUnread(r.unread)).catch(() => {});
    }
    setOpen(false);
    onGo?.(n.target, n.kind);
  }
  async function readAll() {
    try {
      const r = await apiPost('notifications/read');
      setUnread(r.unread);
      setItems((list) => list.map((x) => ({ ...x, read: true })));
    } catch (e) {
      setError(e.message);
    }
  }

  const label = unread ? `Notificaciones (${unread} sin leer)` : 'Notificaciones';
  return (
    <>
      <button className="link bell-btn" aria-label={label} title={label} onClick={show}>
        <Icon name="bell" />
        {unread > 0 && <b className="bell-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</b>}
      </button>
      {/* El panel va fuera del encabezado (portal): si no, heredaría sus estilos */}
      {open && createPortal(
        <Panel onClose={() => setOpen(false)} labelledBy="bell-title">
          <div className="overlay-head">
            <b id="bell-title">Notificaciones</b>
            {unread > 0 && <button className="link" onClick={readAll}>Marcar todo como leído</button>}
            <button className="link" onClick={() => setOpen(false)}>Cerrar ✕</button>
          </div>
          <div className="overlay-body">
            <PushToggle why="Actívalas para que te lleguen al celular aunque tengas la app cerrada." />
            <label className="check switch-line">
              <span>{sound ? '🔊' : '🔇'} Sonido de los avisos</span>
              <input type="checkbox" role="switch" className="switch" checked={sound} onChange={toggleSound} />
            </label>
            {error && <div className="error">{error}</div>}
            {items === null && !error && <p className="muted">Cargando…</p>}
            {items?.length === 0 && <Empty title="No tienes notificaciones">Aquí te avisamos de mensajes, ofertas, tus viajes y tu cuenta.</Empty>}
            {items?.length > 0 && (
              <ul className="bell-list">
                {items.map((n) => (
                  <li key={n.id}>
                    <button className={`bell-item${n.read ? '' : ' unread'}`} onClick={() => go(n)}>
                      <span className="bell-icon" aria-hidden="true">{ICON[n.kind] || ICON.info}</span>
                      <span className="bell-text">
                        <b>{n.title}{n.count > 1 ? ` (${n.count})` : ''}</b>
                        {n.body && <span>{n.body}</span>}
                        <span className="muted small">{ago(n.at)}{n.read ? '' : ' · nueva'}</span>
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <p className="muted small">Se guardan 30 días.</p>
          </div>
        </Panel>,
        document.body
      )}
    </>
  );
}
