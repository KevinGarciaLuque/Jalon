import { Suspense, useEffect, useState } from 'react';
import News, { useNews } from './News.jsx';
import Bell from './Bell.jsx';
import Menu, { HelpPanel, NewsButton, ProfileMenu } from './Menu.jsx';
import { Brand, Loading } from './components.jsx';
import { apiGet, apiPost, authFetch, API, lazyPage } from './lib.js';

// Cada pantalla se descarga cuando se usa: el panel solo lo baja el personal; el mapa, pasajeros y conductores
const Auth = lazyPage(() => import('./Auth.jsx')); // quien ya tiene sesión no la necesita
const Passenger = lazyPage(() => import('./Passenger.jsx'));
const Driver = lazyPage(() => import('./Driver.jsx'));
const Admin = lazyPage(() => import('./Admin.jsx'));
const History = lazyPage(() => import('./History.jsx'));
const Account = lazyPage(() => import('./Account.jsx'));
const TwoFactorSetup = lazyPage(() => import('./TwoFactorSetup.jsx'));
const TermsUpdate = lazyPage(() => import('./TermsUpdate.jsx'));
const PasskeyOffer = lazyPage(() => import('./PasskeyParts.jsx').then((m) => ({ default: m.PasskeyOffer })));

const STAFF = ['superadmin', 'admin', 'support'];

// En el teléfono solo queda quién es la persona (nombre, rol); la sesión misma está en la cookie, que JavaScript no puede leer.
// `token` aparece solo en sesiones guardadas antes de la cookie: al abrir la app se pasa a la cookie y se borra.
function loadSession() {
  // Si lo guardado está dañado o incompleto (sin la persona), se vuelve a la pantalla de entrada en vez de quedar en blanco
  try { const s = JSON.parse(localStorage.getItem('jalon')); return s?.user?.id && s.user.role ? s : null; } catch { return null; }
}

// Pantalla ancha (computadora): el menú del panel se queda fijo
function useWide() {
  const query = '(min-width: 1024px)';
  const [wide, setWide] = useState(() => window.matchMedia?.(query).matches ?? false);
  useEffect(() => {
    const m = window.matchMedia?.(query);
    if (!m) return;
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

export default function App() {
  const [session, setSession] = useState(loadSession);
  const [socket, setSocket] = useState(null);
  const [connError, setConnError] = useState('');
  const [notice, setNotice] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [showNews, setShowNews] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [adminNav, setAdminNav] = useState({ sections: null, current: null }); // secciones del panel para el menú
  const [pkOffer, setPkOffer] = useState(false); // tras entrar con la contraseña se ofrece Face ID / huella
  const [wallet, setWallet] = useState(null); // saldo del conductor para el menú (si la comisión está activa)
  const wide = useWide();
  const { news, unseen, markSeen } = useNews(session?.user.role);
  const [accountStatus, setAccountStatus] = useState(() => loadSession()?.user.status);

  // Sesión de antes de la cookie: se pasa a la cookie una vez y el token se borra del teléfono.
  // Si no hay conexión, se sigue usando el token y se intenta la próxima vez que se abra la app.
  useEffect(() => {
    if (!session?.token) return;
    authFetch(`${API}/api/session/cookie`, { method: 'POST', headers: { Authorization: `Bearer ${session.token}` } })
      .then((res) => {
        if (res.ok) save({ user: session.user });
        else if (res.status === 401) logout();
      })
      .catch(() => {});
  }, [session?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  // Al abrir la app: los datos de la sesión (p. ej. los módulos que el superadmin dio o quitó). Si la sesión venció, se sale.
  useEffect(() => {
    if (!session || session.token || session.user.mustChangePassword) return;
    apiGet('me')
      .then(({ user }) => setSession((cur) => {
        if (!cur || cur.user.id !== user.id) return cur;
        const next = { ...cur, user: { ...cur.user, perms: user.perms, mustAcceptTerms: user.mustAcceptTerms, termsVersion: user.termsVersion, rating: user.rating } };
        localStorage.setItem('jalon', JSON.stringify(next));
        return next;
      }))
      .catch((e) => { if (e.message === 'No autorizado') logout('Tu sesión venció. Vuelve a entrar.'); });
  }, [session?.user.id, session?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // El personal no usa sockets; y con contraseña temporal pendiente tampoco se conecta nadie
    if (!session || STAFF.includes(session.user.role) || session.user.mustChangePassword) return;
    let s = null;
    let closed = false;
    import('./socket.js').then(({ connectSocket }) => {
      if (closed) return;
      s = connectSocket(session.token);
      listen(s);
      s.on('connect', reportVisible);
    }).catch(() => setConnError('Sin conexión con el servidor…'));
    // Si la app pasa a segundo plano o se bloquea la pantalla, el servidor manda los avisos al celular
    const reportVisible = () => s?.emit('app:visible', document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', reportVisible);
    return () => { closed = true; document.removeEventListener('visibilitychange', reportVisible); s?.close(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  function listen(s) {
    s.on('connect', () => setConnError(''));
    s.on('account:status', ({ status }) => {
      setAccountStatus(status);
      if (status === 'blocked') logout('Tu cuenta fue bloqueada. Contacta a soporte.');
    });
    s.on('connect_error', (e) => {
      if (e.message === 'Cuenta bloqueada') logout('Tu cuenta fue bloqueada. Contacta a soporte.');
      else if (e.message === 'No autorizado' || e.message === 'Usuario no existe') logout();
      else setConnError('Sin conexión con el servidor…');
    });
    setSocket(s);
  }

  function onAuth(data, via) {
    setPkOffer(via === 'password');
    const next = { user: data.user }; // la sesión llegó en la cookie
    localStorage.setItem('jalon', JSON.stringify(next));
    setNotice('');
    setAccountStatus(data.user.status);
    setSession(next);
  }

  const save = (next) => { localStorage.setItem('jalon', JSON.stringify(next)); setSession(next); };

  // Al cambiar la contraseña (o cerrar las demás sesiones) el servidor renueva la cookie de esta sesión; un token viejo ya no sirve
  function updateToken() {
    save({ user: { ...session.user, mustChangePassword: false } });
  }

  // El servidor puede exigir pasos pendientes aunque la sesión guardada no lo sepa (p. ej. un superadmin que ya estaba conectado)
  function onGate(code) {
    if (code === 'MUST_ENROLL_2FA' && !session.user.mustEnrollTwoFactor) save({ ...session, user: { ...session.user, mustEnrollTwoFactor: true } });
    if (code === 'MUST_CHANGE_PASSWORD' && !session.user.mustChangePassword) save({ ...session, user: { ...session.user, mustChangePassword: true } });
  }

  const staff = STAFF.includes(session?.user.role);
  const hasBell = !!session && !session.user.mustChangePassword && !session.token;
  const panelOpen = staff && !!session && !session.user.mustChangePassword && !session.user.mustEnrollTwoFactor;
  const pinned = panelOpen && wide; // en computadora, el menú del panel queda fijo a la izquierda

  // Lo que se toca en el menú: aquí se abren historial, cuenta, novedades y la campanita; lo demás lo atiende su pantalla
  function openFromMenu(target) {
    if (target === 'account') return setShowAccount(true);
    if (target === 'help') return setShowHelp(true);
    if (target === 'news') { setShowNews(true); markSeen(); return; }
    if (target === 'bell') return window.dispatchEvent(new Event('ktracho:bell'));
    goTo(target.replace(/^section:/, '')); // una sección del panel

  }

  // Al tocar un aviso de la campanita: el historial se abre aquí; lo demás lo atiende su pantalla (pestaña del panel, saldo del conductor)
  function goTo(target) {
    setShowNews(false);
    setShowAccount(false);
    setShowHelp(false);
    if (target === 'history') return setShowHistory(true);
    setShowHistory(false);
    if (target) window.dispatchEvent(new CustomEvent('ktracho:go', { detail: target }));
  }

  function logout(message = '') {
    apiPost('logout').catch(() => {}); // el servidor borra la cookie
    localStorage.removeItem('jalon');
    setNotice(typeof message === 'string' ? message : '');
    setSession(null);
    setSocket(null);
  }

  const menuProps = session && { user: { ...session.user, status: accountStatus }, unseen, hasBell, go: openFromMenu, onLogout: () => logout(), sections: adminNav.sections, current: adminNav.current, wallet };
  const locked = !!session?.user.mustChangePassword; // con contraseña temporal solo se puede cambiarla o salir

  if (!session) return <Suspense fallback={<Loading />}><Auth onAuth={onAuth} notice={notice} /></Suspense>;

  return (
    <div className="app">
      {/* Encabezado: ☰ y la marca a la izquierda; ✨ Novedades, la campanita y tu avatar (Mi perfil, Ayuda, Cerrar sesión) a la derecha */}
      <header>
        {!locked && !pinned && <Menu {...menuProps} />}
        <Brand />
        <span className="hdr-space" />
        {/* La campanita espera a que la sesión esté en la cookie (las de antes de la cookie se pasan al abrir la app) */}
        {!locked && <NewsButton unseen={unseen} onOpen={() => openFromMenu('news')} />}
        {hasBell && <Bell socket={staff ? null : socket} onGo={goTo} />}
        {locked
          ? <button className="link" onClick={() => logout()}>Salir</button>
          : <ProfileMenu user={menuProps.user} go={openFromMenu} onLogout={() => logout()} />}
      </header>
      {connError && <div className="banner">{connError}</div>}
      <Suspense fallback={<Loading />}>
      {panelOpen && (
        <div className="staff-layout">
          {pinned && <Menu {...menuProps} pinned />}
          <Admin token={session.token} onGate={onGate} onSections={(sections, current) => setAdminNav({ sections, current })} />
        </div>
      )}
      {socket && !session.user.mustChangePassword && (session.user.role === 'driver'
        ? <Driver socket={socket} token={session.token} userId={session.user.id} status={accountStatus} perms={session.user.perms || []} onWallet={setWallet} />
        : <Passenger socket={socket} token={session.token} userId={session.user.id} perms={session.user.perms || []} />)}
      {(showAccount || session.user.mustChangePassword) && (
        <Account
          forced={!!session.user.mustChangePassword}
          user={session.user}
          token={session.token}
          onToken={updateToken}
          onClose={() => setShowAccount(false)}
          onLogout={() => { setShowAccount(false); logout(); }}
        />
      )}
      {!session.user.mustChangePassword && session.user.mustEnrollTwoFactor && (
        <TwoFactorSetup
          token={session.token}
          onLogout={() => logout()}
          onDone={() => save({ ...session, user: { ...session.user, mustEnrollTwoFactor: false, twoFactorEnabled: true } })}
        />
      )}
      {session.user.mustAcceptTerms && !session.user.mustChangePassword && !showAccount && (
        <TermsUpdate
          version={session.user.termsVersion}
          onAccepted={() => save({ ...session, user: { ...session.user, mustAcceptTerms: false } })}
          onAccount={() => setShowAccount(true)}
          onLogout={() => logout()}
        />
      )}
      {pkOffer && !session.token && !session.user.mustChangePassword && !session.user.mustEnrollTwoFactor && !session.user.mustAcceptTerms && (
        <PasskeyOffer userId={session.user.id} onClose={() => setPkOffer(false)} />
      )}
      {showNews && <News news={news} onClose={() => setShowNews(false)} />}
      {showHelp && <HelpPanel user={session.user} onClose={() => setShowHelp(false)} onHistory={() => goTo('history')} />}
      {showHistory && <History token={session.token} role={session.user.role} onClose={() => setShowHistory(false)} />}
      </Suspense>
    </div>
  );
}
