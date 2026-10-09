import { useEffect, useState } from 'react';
import Auth from './Auth.jsx';
import Passenger from './Passenger.jsx';
import Driver from './Driver.jsx';
import Admin from './Admin.jsx';
import History from './History.jsx';
import Account from './Account.jsx';
import TwoFactorSetup from './TwoFactorSetup.jsx';
import { connectSocket } from './lib.js';

const STAFF = ['superadmin', 'admin', 'support'];
const ROLE_NAME = { passenger: 'Pasajero', driver: 'Conductor', superadmin: 'Superadministrador', admin: 'Administrador', support: 'Soporte' };

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
  const [accountStatus, setAccountStatus] = useState(() => loadSession()?.user.status);

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
    localStorage.setItem('jalon', JSON.stringify(data));
    setNotice('');
    setAccountStatus(data.user.status);
    setSession(data);
  }

  const save = (next) => { localStorage.setItem('jalon', JSON.stringify(next)); setSession(next); };

  // Al cambiar la contraseña (o cerrar las demás sesiones) el servidor entrega un token nuevo; se reemplaza para no cerrar esta sesión
  function updateToken(token) {
    save({ ...session, token, user: { ...session.user, mustChangePassword: false } });
  }

  // El servidor puede exigir pasos pendientes aunque la sesión guardada no lo sepa (p. ej. un superadmin que ya estaba conectado)
  function onGate(code) {
    if (code === 'MUST_ENROLL_2FA' && !session.user.mustEnrollTwoFactor) save({ ...session, user: { ...session.user, mustEnrollTwoFactor: true } });
    if (code === 'MUST_CHANGE_PASSWORD' && !session.user.mustChangePassword) save({ ...session, user: { ...session.user, mustChangePassword: true } });
  }

  const staff = STAFF.includes(session?.user.role);

  function logout(message = '') {
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
        <button className="link" onClick={() => setShowAccount(true)}>Cuenta</button>
        <button className="link" onClick={() => logout()}>Salir</button>
      </header>
      {connError && <div className="banner">{connError}</div>}
      {staff && !session.user.mustChangePassword && !session.user.mustEnrollTwoFactor && <Admin token={session.token} onGate={onGate} />}
      {socket && !session.user.mustChangePassword && (session.user.role === 'driver'
        ? <Driver socket={socket} token={session.token} userId={session.user.id} status={accountStatus} />
        : <Passenger socket={socket} token={session.token} userId={session.user.id} />)}
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
      {showHistory && <History token={session.token} role={session.user.role} onClose={() => setShowHistory(false)} />}
    </div>
  );
}
