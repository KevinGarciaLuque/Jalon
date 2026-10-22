import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiGet, apiPost } from './lib.js';
import { Empty, PushToggle } from './components.jsx';

// La campanita: avisos de chat, ofertas, viajes, saldo, alquileres, reportes y emergencias (lo que corresponda a cada persona)
const ICON = { chat: '💬', offer: '💵', ride: '🚗', wallet: '💰', report: '📝', rental: '🔑', sos: '🆘', docs: '📄', rating: '⭐', account: '✅', info: '🔔' };
const STAFF_POLL_MS = 20000; // el personal no usa el tiempo real: se revisa cada 20 s

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

  const loadList = useCallback(() => apiGet('notifications').then((r) => { setItems(r.items); setUnread(r.unread); }).catch((e) => setError(e.message)), []);
  const loadCount = useCallback(() => apiGet('notifications/unread').then((r) => setUnread(r.unread)).catch(() => {}), []);

  useEffect(() => { loadCount(); }, [loadCount]);
  useEffect(() => {
    if (socket) {
      const fresh = ({ unread: n }) => { setUnread(n); if (open) loadList(); };
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
        <span aria-hidden="true">🔔</span>
        {unread > 0 && <b className="bell-count" aria-hidden="true">{unread > 99 ? '99+' : unread}</b>}
      </button>
      {/* El panel va fuera del encabezado (portal): si no, heredaría sus estilos */}
      {open && createPortal(
        <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="bell-title">
          <div className="overlay-head">
            <b id="bell-title">Notificaciones</b>
            {unread > 0 && <button className="link" onClick={readAll}>Marcar todo como leído</button>}
            <button className="link" onClick={() => setOpen(false)}>Cerrar ✕</button>
          </div>
          <div className="overlay-body">
            <PushToggle why="Actívalas para que te lleguen al celular aunque tengas la app cerrada." />
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
        </div>,
        document.body
      )}
    </>
  );
}
