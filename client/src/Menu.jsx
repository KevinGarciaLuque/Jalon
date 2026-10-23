import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar, Stars } from './components.jsx';
import { money2, useInstall } from './lib.js';

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
  // Secciones del panel
  car: 'M5 17v-5l2-5h10l2 5v5M5 17h14M5 17v2M19 17v2M5 12h14M8 14.5h1M15 14.5h1',
  map: 'M9 4L3.5 6v14L9 18l6 2 5.5-2V4L15 6 9 4zM9 4v14M15 6v14',
  users: 'M9 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7zM2.5 20c.8-3.5 3.4-5.5 6.5-5.5s5.7 2 6.5 5.5M16 4.3a3.5 3.5 0 0 1 0 6.4M18 14.8c1.8.7 3 2.4 3.5 5.2',
  flag: 'M5 21V4M5 4h11l-2 4 2 4H5',
  wallet: 'M4 7.5A2.5 2.5 0 0 1 6.5 5H18v3M4 7.5V17a2 2 0 0 0 2 2h13a1 1 0 0 0 1-1v-9a1 1 0 0 0-1-1H6.5A2.5 2.5 0 0 1 4 7.5zM16 13.5h1',
  sliders: 'M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1M15 4v4M9 10v4M17 16v4',
  server: 'M4 5h16v6H4zM4 13h16v6H4zM8 8h.01M8 16h.01',
  badge: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3zM9 12l2 2 4-4',
  lock: 'M6 11h12v9H6zM8.5 11V8a3.5 3.5 0 0 1 7 0v3',
  list: 'M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01',
  help: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14a2 2 0 0 1 2-2h1v6H6a2 2 0 0 1-2-2v-2zM20 14a2 2 0 0 0-2-2h-1v6h1a2 2 0 0 0 2-2v-2zM17 18c0 1.7-1.8 3-5 3',
  shield: 'M12 3l7 3v5c0 4.5-3 8-7 10-4-2-7-5.5-7-10V6l7-3z',
  mail: 'M4 6h16v12H4zM4 7l8 6 8-6',
  chat: 'M5 19l1.5-3.5A7.5 7.5 0 1 1 9 18.6L5 19z',
  doc: 'M7 3h7l4 4v14H7zM14 3v4h4M10 12h5M10 16h5',
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
const BUILD_DATE = new Date(__BUILD_DATE__).toLocaleDateString('es-HN', { day: 'numeric', month: 'short', year: 'numeric' });

// El botón ☰ del encabezado y el menú que sale de la izquierda (como inDrive), con las secciones.
// `go(target)`: abre lo que se tocó. Novedades, Mi perfil y Cerrar sesión están en el encabezado (✨ y el avatar).
// Personal: `sections` son las secciones del panel que puede ver (con sus pendientes) y `current` la que está abierta.
// `pinned`: en computadora el menú del personal queda fijo a la izquierda, sin botón ☰.
// `wallet`: saldo del conductor ({ balance, low }) cuando la comisión está activa.
export default function Menu({ user, hasBell, go, sections, current, wallet, pinned = false }) {
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
    if (pinned) return then?.();
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
    user.role === 'driver' && wallet && { key: 'wallet', icon: 'wallet', label: 'Mi saldo y recargas', note: money2(wallet.balance), low: wallet.low },
    hasBell && { key: 'bell', icon: 'bell', label: 'Notificaciones' },
    user.role === 'driver' && user.status === 'active' && { key: 'earnings', icon: 'earnings', label: 'Mis ganancias' },
    user.role === 'driver' && user.status === 'active' && perms.includes('rent.offer') && { key: 'rental', icon: 'key', label: 'Alquiler de mi carro' },
  ].filter(Boolean);
  // Secciones del panel agrupadas (Operación, Crecimiento, Administración)
  const groups = [];
  for (const sct of sections || []) {
    const last = groups[groups.length - 1];
    if (last?.name === sct.group) last.list.push(sct); else groups.push({ name: sct.group, list: [sct] });
  }
  const pendingTotal = (sections || []).reduce((n, sct) => n + (sct.badge || 0), 0);

  const row = (it, active = false) => (
    <li key={it.key}>
      <button className={active ? 'on' : ''} aria-current={active ? 'page' : undefined} onClick={pick(it.target || it.key)}>
        <Icon name={it.icon} />
        <span>{it.label}</span>
        {it.note && <em className={`drawer-amount${it.low ? ' low' : ''}`} aria-label={`saldo ${it.note}${it.low ? ', por debajo del mínimo' : ''}`}>{it.note}</em>}
        {!!it.badge && <em className={`drawer-badge${typeof it.badge === 'number' ? ' count' : ''}`} aria-label={typeof it.badge === 'number' ? `${it.badge} pendiente(s)` : undefined}>{it.badge}</em>}
      </button>
    </li>
  );

  const content = (
    <>
      {!pinned && (
        <div className="drawer-top">
          <button className="drawer-close" aria-label="Cerrar menú" onClick={() => close()}><Icon name="close" /></button>
        </div>
      )}
      {/* Quién eres, al centro (tocarlo abre Mi perfil) */}
      <button className="drawer-profile" onClick={pick('account')} aria-label={`Mi perfil: ${user.name}`}>
        <span className="avatar-ring lg"><Avatar name={user.name} /></span>
        <b>{user.name}</b>
        <span className="drawer-role">{ROLE_NAME[user.role]}</span>
        {!staff && user.rating?.count > 0 && <span className="small"><Stars rating={user.rating} /></span>}
        <i className="drawer-rule" aria-hidden="true" />
      </button>
      {groups.map((g) => (
        <div key={g.name} className="drawer-group">
          <h3>{g.name}</h3>
          <ul className="drawer-list">{g.list.map((sct) => row({ ...sct, target: `section:${sct.key}` }, sct.key === current))}</ul>
        </div>
      ))}
      <div className="drawer-group plain">
        <h3>{staff ? 'General' : 'Mi cuenta'}</h3>
        <ul className="drawer-list">
          {items.map((it) => row(it))}
          {(install.canInstall || install.ios) && (
            <li>
              <button onClick={() => (install.canInstall ? close(install.prompt) : pick('account')())}>
                <Icon name="install" />
                <span>Instalar la app</span>
              </button>
            </li>
          )}
        </ul>
      </div>
      {/* Qué versión tiene este aparato (la fecha en que se publicó) */}
      <div className="drawer-foot">
        <Icon name="shield" size={16} />
        <span>Ktracho GO · versión del {BUILD_DATE}</span>
      </div>
    </>
  );

  if (pinned) return <nav className="sidebar" aria-label="Menú del panel">{content}</nav>;

  const label = pendingTotal ? `Menú (${pendingTotal} pendiente(s))` : 'Menú';
  return (
    <>
      <button ref={btn} className="menu-btn" aria-label={label} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        <Icon name="menu" />
        {pendingTotal > 0 && <b className="bell-count" aria-hidden="true">{pendingTotal > 99 ? '99+' : pendingTotal}</b>}
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
            {content}
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

// ✨ Novedades en el encabezado: brilla mientras haya algo nuevo sin ver
export function NewsButton({ unseen, onOpen }) {
  return (
    <button className={`news-btn${unseen ? ' fresh' : ''}`} aria-label={unseen ? 'Novedades (hay algo nuevo)' : 'Novedades'} title="Novedades" onClick={onOpen}>
      <Icon name="news" />
      {unseen && <i className="news-dot" />}
    </button>
  );
}

// El avatar del encabezado: abre tu tarjeta con Mi perfil, Ayuda y soporte y Cerrar sesión
export function ProfileMenu({ user, go, onLogout }) {
  const [open, setOpen] = useState(false);
  const btn = useRef(null);
  const box = useRef(null);
  const staff = STAFF.includes(user.role);

  useEffect(() => {
    if (!open) return;
    box.current?.querySelector('[role="menuitem"]')?.focus();
    const onKey = (e) => { if (e.key === 'Escape') { setOpen(false); btn.current?.focus(); } };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  const pick = (fn) => () => { setOpen(false); fn(); };
  const top = btn.current ? btn.current.getBoundingClientRect().bottom + 8 : 70;
  return (
    <>
      <button ref={btn} className="avatar-btn" aria-label={`Tu cuenta: ${user.name}`} aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="avatar-ring"><Avatar name={user.name} /></span>
      </button>
      {open && createPortal(
        <div className="pop-wrap" onClick={() => setOpen(false)}>
          <div ref={box} className="profile-pop" role="menu" aria-label="Tu cuenta" style={{ top }} onClick={(e) => e.stopPropagation()}>
            <div className="profile-card">
              <span className="avatar-ring"><Avatar name={user.name} /></span>
              <span className="profile-who">
                <b>{user.name}</b>
                <span className="muted small">{user.email || user.phone}</span>
                <span className="role-tag">{ROLE_NAME[user.role]}</span>
                {!staff && user.rating?.count > 0 && <span className="small"><Stars rating={user.rating} /></span>}
              </span>
            </div>
            <button role="menuitem" onClick={pick(() => go('account'))}><Icon name="user" /><span>Mi perfil</span></button>
            <button role="menuitem" onClick={pick(() => go('help'))}><Icon name="help" /><span>Ayuda y soporte</span></button>
            <hr />
            <button role="menuitem" className="danger-item" onClick={pick(onLogout)}><Icon name="logout" /><span>Cerrar sesión</span></button>
          </div>
        </div>,
        document.body
      )}
    </>
  );
}

// Ayuda y soporte: cómo contactarnos, los documentos legales y cómo reportar un problema de un viaje
const SUPPORT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL; // variables de Railway (se ponen al compilar)
const SUPPORT_WHATSAPP = (import.meta.env.VITE_SUPPORT_WHATSAPP || '').replace(/\D/g, '');
export function HelpPanel({ user, onClose, onHistory }) {
  const staff = STAFF.includes(user.role);
  const wa = SUPPORT_WHATSAPP && `https://wa.me/${SUPPORT_WHATSAPP.length === 8 ? `504${SUPPORT_WHATSAPP}` : SUPPORT_WHATSAPP}?text=${encodeURIComponent(`Hola, soy ${user.name} (${user.phone}) y necesito ayuda con Ktracho GO.`)}`;
  return (
    <Panel onClose={onClose} labelledBy="help-title">
      <div className="overlay-head">
        <b id="help-title">Ayuda y soporte</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        <div className="req">
          <b>Escríbenos</b>
          <p className="muted small">Te respondemos lo antes posible. Cuéntanos qué pasó y, si es de un viaje, qué día fue.</p>
          {wa && <a className="primary help-link" href={wa} target="_blank" rel="noreferrer"><Icon name="chat" /> WhatsApp de soporte</a>}
          {SUPPORT_EMAIL && <a className="help-link" href={`mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('Ayuda con Ktracho GO')}`}><Icon name="mail" /> {SUPPORT_EMAIL}</a>}
          {!wa && !SUPPORT_EMAIL && <p className="muted small">Pronto publicaremos aquí el correo y el WhatsApp de soporte.</p>}
        </div>
        {!staff && (
          <div className="req">
            <b>¿Problema con un viaje?</b>
            <p className="muted small">Abre <b>Historial de viajes</b>, toca el viaje y elige <b>«Reportar un problema»</b> (por ejemplo, si olvidaste algo en el carro). El equipo te responde ahí mismo.</p>
            <button onClick={onHistory}><Icon name="history" /> Ir a Historial de viajes</button>
          </div>
        )}
        <div className="req">
          <b>Documentos</b>
          <a className="help-link" href="/terminos" target="_blank" rel="noreferrer"><Icon name="doc" /> Términos de uso</a>
          <a className="help-link" href="/privacidad" target="_blank" rel="noreferrer"><Icon name="shield" /> Política de privacidad</a>
        </div>
        <p className="muted small">Ktracho GO · versión del {BUILD_DATE}</p>
      </div>
    </Panel>
  );
}
