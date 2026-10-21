import { useEffect, useState } from 'react';
import Auth from './Auth.jsx';
import Passenger from './Passenger.jsx';
import Driver from './Driver.jsx';
import Admin from './Admin.jsx';
import History from './History.jsx';
import Account from './Account.jsx';
import TwoFactorSetup from './TwoFactorSetup.jsx';
import News, { useNews } from './News.jsx';
import { connectSocket, apiGet, apiPost, authFetch, API } from './lib.js';

const STAFF = ['superadmin', 'admin', 'support'];
const ROLE_NAME = { passenger: 'Pasajero', driver: 'Conductor', superadmin: 'Superadministrador', admin: 'Administrador', support: 'Soporte' };

// En el teléfono solo queda quién es la persona (nombre, rol); la sesión misma está en la cookie, que JavaScript no puede leer.
// `token` aparece solo en sesiones guardadas antes de la cookie: al abrir la app se pasa a la cookie y se borra.
function loadSession() {
  try { return JSON.parse(localStorage.getItem('jalon')) || null; } catch { return null; }
}

export default function App() {
  const [session, setSession] = useState(loadSession);
  const [socket, setSocket] = useState(null);
  const [connError, setConnError] = useState('');
  const [notice, setNotice] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [showAccount, setShowAccount] = useState(false);
  const [showNews, setShowNews] = useState(false);
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
        const next = { ...cur, user: { ...cur.user, perms: user.perms } };
        localStorage.setItem('jalon', JSON.stringify(next));
        return next;
      }))
      .catch((e) => { if (e.message === 'No autorizado') logout('Tu sesión venció. Vuelve a entrar.'); });
  }, [session?.user.id, session?.token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    // El personal no usa sockets; y con contraseña temporal pendiente tampoco se conecta nadie
    if (!session || STAFF.includes(session.user.role) || session.user.mustChangePassword) return;
    const s = connectSocket(session.token);
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
    return () => s.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session]);

  function onAuth(data) {
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

  function logout(message = '') {
    apiPost('logout').catch(() => {}); // el servidor borra la cookie
    localStorage.removeItem('jalon');
    setNotice(typeof message === 'string' ? message : '');
    setSession(null);
    setSocket(null);
  }

  if (!session) return <Auth onAuth={onAuth} notice={notice} />;

  return (
    <div className="app">
      <header>
        <b>Jalón</b>
        <span>{session.user.name} · {ROLE_NAME[session.user.role]}</span>
        {!STAFF.includes(session.user.role) && !session.user.mustChangePassword && <button className="link" onClick={() => setShowHistory(true)}>Historial</button>}
        <button className="link news-btn" aria-label={unseen ? 'Novedades (hay algo nuevo)' : 'Novedades'} onClick={() => { setShowNews(true); markSeen(); }}>
          <span className="news-icon" aria-hidden="true">✨</span><span className="news-label">Novedades</span>{unseen && <i className="news-dot" />}
        </button>
        <button className="link" onClick={() => setShowAccount(true)}>Cuenta</button>
        <button className="link" onClick={() => logout()}>Salir</button>
      </header>
      {connError && <div className="banner">{connError}</div>}
      {staff && !session.user.mustChangePassword && !session.user.mustEnrollTwoFactor && <Admin token={session.token} onGate={onGate} />}
      {socket && !session.user.mustChangePassword && (session.user.role === 'driver'
        ? <Driver socket={socket} token={session.token} userId={session.user.id} status={accountStatus} perms={session.user.perms || []} />
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
      {showNews && <News news={news} onClose={() => setShowNews(false)} />}
      {showHistory && <History token={session.token} role={session.user.role} onClose={() => setShowHistory(false)} />}
    </div>
  );
}
