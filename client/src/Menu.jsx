import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar, Stars } from './components.jsx';
import { useInstall } from './lib.js';

// Íconos de línea (heredan el color del texto): se ven igual en todos los celulares, a diferencia de los emojis
const PATHS = {
  menu: 'M4 7h16M4 12h16M4 17h16',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15L6 16zM10 20.5a2 2 0 0 0 4 0',
  history: 'M3.5 12a8.5 8.5 0 1 0 2.5-6M3 4v4h4M12 8v4l3 2',
  news: 'M12 3l1.8 4.7L18.5 9l-4.7 1.8L12 15.5l-1.8-4.7L5.5 9l4.7-1.3L12 3zM18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8.8-2z',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20.5c1-4 4-6 7.5-6s6.5 2 7.5 6',
  earnings: 'M4 19V5M4 19h16M8 15l3.5-4 3 2.5L20 7',
  key: 'M14.5 9.5a4 4 0 1 0-1.4 3L20 19.5V22h-2.5v-2h-2v-2h-2',
  share: 'M16 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM8 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM16 22a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM10.6 13.5l2.8 1.8M13.4 6.7l-2.8 1.8',
  install: 'M12 3v12M7.5 10.5L12 15l4.5-4.5M5 20h14',
  logout: 'M15 4h3.5a1.5 1.5 0 0 1 1.5 1.5v13a1.5 1.5 0 0 1-1.5 1.5H15M10 16l-4-4 4-4M6 12h10',
  close: 'M6 6l12 12M18 6L6 18',
  chevron: 'M9 6l6 6-6 6',
};
export function Icon({ name, size = 22 }) {
  return (
    <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </svg>
  );
}

const ROLE_NAME = { passenger: 'Pasajero', driver: 'Conductor', superadmin: 'Superadministrador', admin: 'Administrador', support: 'Soporte' };
const STAFF = ['superadmin', 'admin', 'support'];
const CLOSE_MS = 220; // lo que dura la salida (igual que en el CSS)

// El botón ☰ del encabezado y el menú que sale de la izquierda (como inDrive).
// `go(target)`: abre lo que se tocó; `unseen`: hay novedades sin ver (punto verde).
export default function Menu({ user, unseen, hasBell, go, onLogout }) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [drag, setDrag] = useState(0); // cuánto se arrastró hacia la izquierda para cerrarlo (negativo)
  const btn = useRef(null);
  const panel = useRef(null);
  const touch = useRef(null);
  const install = useInstall();
  const staff = STAFF.includes(user.role);
  const perms = user.perms || [];

  function close(then) {
    if (closing) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setClosing(true);
    setTimeout(() => {
      setOpen(false);
      setClosing(false);
      setDrag(0);
      if (then) then(); else btn.current?.focus();
    }, reduced ? 0 : CLOSE_MS);
  }
  const pick = (target) => () => close(() => go(target));

  useEffect(() => {
    if (!open) return;
    panel.current?.querySelector('button')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  // Deslizar hacia la izquierda lo cierra
  const onTouchStart = (e) => { touch.current = { x: e.touches[0].clientX, y: e.touches[0].clientY, sideways: null }; };
  const onTouchMove = (e) => {
    const t = touch.current;
    if (!t) return;
    const dx = e.touches[0].clientX - t.x;
    const dy = e.touches[0].clientY - t.y;
    if (t.sideways === null && Math.abs(dx) + Math.abs(dy) > 8) t.sideways = Math.abs(dx) > Math.abs(dy);
    if (t.sideways) setDrag(Math.min(0, dx));
  };
  const onTouchEnd = () => {
    if (drag < -70) close(); else setDrag(0);
    touch.current = null;
  };

  const items = [
    !staff && { key: 'history', icon: 'history', label: 'Historial de viajes' },
    hasBell && { key: 'bell', icon: 'bell', label: 'Notificaciones' },
    user.role === 'driver' && user.status === 'active' && { key: 'earnings', icon: 'earnings', label: 'Mis ganancias' },
    user.role === 'driver' && user.status === 'active' && perms.includes('rent.offer') && { key: 'rental', icon: 'key', label: 'Alquiler de mi carro' },
    staff && perms.includes('share') && { key: 'share', icon: 'share', label: 'Compartir la app' },
    { key: 'news', icon: 'news', label: 'Novedades', badge: unseen ? 'Nuevo' : '' },
    { key: 'account', icon: 'user', label: 'Mi cuenta' },
  ].filter(Boolean);

  return (
    <>
      <button ref={btn} className="menu-btn" aria-label={unseen ? 'Menú (hay novedades)' : 'Menú'} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="menu" />
        {unseen && <i className="news-dot" />}
      </button>
      {open && createPortal(
        <div className={`drawer-wrap${closing ? ' closing' : ''}`}>
          <div className="scrim" onClick={() => close()} />
          <nav
            ref={panel}
            className="drawer"
            role="dialog"
            aria-modal="true"
            aria-label="Menú"
            style={drag ? { transform: `translateX(${drag}px)`, transition: 'none' } : undefined}
            onTouchStart={onTouchStart}
            onTouchMove={onTouchMove}
            onTouchEnd={onTouchEnd}
          >
            <div className="drawer-top">
              <button className="drawer-close" aria-label="Cerrar menú" onClick={() => close()}><Icon name="close" /></button>
            </div>
            <button className="drawer-profile" onClick={pick('account')}>
              <Avatar name={user.name} />
              <span className="drawer-who">
                <b>{user.name}</b>
                <span className="muted small">{ROLE_NAME[user.role]}</span>
                {!staff && user.rating?.count > 0 && <span className="small"><Stars rating={user.rating} /></span>}
              </span>
              <Icon name="chevron" size={18} />
            </button>
            <ul className="drawer-list">
              {items.map((it) => (
                <li key={it.key}>
                  <button onClick={pick(it.key)}>
                    <Icon name={it.icon} />
                    <span>{it.label}</span>
                    {it.badge && <em className="drawer-badge">{it.badge}</em>}
                  </button>
                </li>
              ))}
              {(install.canInstall || install.ios) && (
                <li>
                  <button onClick={() => (install.canInstall ? close(install.prompt) : pick('account')())}>
                    <Icon name="install" />
                    <span>Instalar la app</span>
                  </button>
                </li>
              )}
            </ul>
            <div className="drawer-foot">
              <button className="drawer-logout" onClick={() => close(onLogout)}><Icon name="logout" /><span>Cerrar sesión</span></button>
              <span className="muted small">Ktracho GO</span>
            </div>
          </nav>
        </div>,
        document.body
      )}
    </>
  );
}

// Las pantallas que se abren desde el menú entran desde la derecha; en computadora son un panel lateral
// con el fondo oscurecido (tocar fuera cierra). `onClose` vacío: no se puede cerrar (p. ej. contraseña obligatoria).
export function Panel({ onClose, children, labelledBy, className = '' }) {
  return (
    <>
      {onClose && <div className="scrim panel-scrim" onClick={onClose} />}
      <div className={`overlay slide ${className}`} role="dialog" aria-modal="true" aria-labelledby={labelledBy}>
        {children}
      </div>
    </>
  );
}
