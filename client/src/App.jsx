import { useEffect, useState } from 'react';
import Auth from './Auth.jsx';
import Passenger from './Passenger.jsx';
import Driver from './Driver.jsx';
import Admin from './Admin.jsx';
import History from './History.jsx';
import Account from './Account.jsx';
import { connectSocket } from './lib.js';

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
    if (!session || session.user.role === 'admin') return;
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

  // Al cambiar la contraseña el servidor entrega un token nuevo; se reemplaza para no cerrar esta sesión
  function updateToken(token) {
    const next = { ...session, token };
    localStorage.setItem('jalon', JSON.stringify(next));
    setSession(next);
  }

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
        <span>{session.user.name} · {{ driver: 'Conductor', admin: 'Administrador' }[session.user.role] || 'Pasajero'}</span>
        {session.user.role !== 'admin' && <button className="link" onClick={() => setShowHistory(true)}>Historial</button>}
        <button className="link" onClick={() => setShowAccount(true)}>Cuenta</button>
        <button className="link" onClick={() => logout()}>Salir</button>
      </header>
      {connError && <div className="banner">{connError}</div>}
      {session.user.role === 'admin' && <Admin token={session.token} />}
      {socket && (session.user.role === 'driver'
        ? <Driver socket={socket} token={session.token} status={accountStatus} />
        : <Passenger socket={socket} token={session.token} />)}
      {showAccount && (
        <Account
          user={session.user}
          token={session.token}
          onToken={updateToken}
          onClose={() => setShowAccount(false)}
          onLogout={() => { setShowAccount(false); logout(); }}
        />
      )}
      {showHistory && <History token={session.token} role={session.user.role} onClose={() => setShowHistory(false)} />}
    </div>
  );
}
