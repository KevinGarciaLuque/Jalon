import { useState } from 'react';
import { apiPost, useInstall } from './lib.js';

const ROLE = { passenger: 'Pasajero', driver: 'Conductor', admin: 'Administrador', superadmin: 'Superadministrador', support: 'Soporte' };

export default function Account({ user, token, onToken, onClose, onLogout, forced = false }) {
  const install = useInstall();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [msg, setMsg] = useState({ ok: false, text: '' });
  const [busy, setBusy] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  async function changePassword(e) {
    e.preventDefault();
    if (f.next.length < 6) return setMsg({ ok: false, text: 'La contraseña nueva debe tener al menos 6 caracteres' });
    if (f.next !== f.again) return setMsg({ ok: false, text: 'La confirmación no coincide' });
    setBusy(true);
    try {
      const { token: fresh } = await apiPost('password/change', token, { current: f.current, password: f.next });
      onToken(fresh); // las demás sesiones se cierran; esta sigue con el token nuevo
      setF({ current: '', next: '', again: '' });
      setMsg({ ok: true, text: 'Contraseña actualizada. Se cerraron tus otras sesiones.' });
    } catch (err) {
      setMsg({ ok: false, text: err.message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="overlay">
      <div className="overlay-head">
        <b>{forced ? 'Cambia tu contraseña para continuar' : 'Mi cuenta'}</b>
        {!forced && <button className="link" onClick={onClose}>Cerrar ✕</button>}
      </div>
      <div className="overlay-body">
        {forced && <div className="hint">Entraste con una contraseña temporal. Elige una nueva que solo tú conozcas; después podrás usar la app.</div>}
        <div className="req">
          <b>{user.name}</b>
          <div className="muted">{ROLE[user.role]} · {user.phone}</div>
          {user.vehicle && <div className="muted">{user.vehicle} · {user.plate}</div>}
        </div>

        {!forced && (install.canInstall || install.ios) && (
          <div className="req">
            <b>📲 Instalar Jalón en tu celular</b>
            {install.canInstall ? (
              <button className="primary" onClick={install.prompt}>Instalar la app</button>
            ) : (
              <p className="muted">En iPhone: toca el botón Compartir de Safari y elige &quot;Agregar a inicio&quot;.</p>
            )}
          </div>
        )}

        <form className="req" onSubmit={changePassword}>
          <b>Cambiar contraseña</b>
          <input type="password" autoComplete="current-password" placeholder="Contraseña actual" value={f.current} onChange={set('current')} required />
          <input type="password" autoComplete="new-password" placeholder="Contraseña nueva" value={f.next} onChange={set('next')} required />
          <input type="password" autoComplete="new-password" placeholder="Repite la contraseña nueva" value={f.again} onChange={set('again')} required />
          {msg.text && <div className={msg.ok ? 'hint ok' : 'error'}>{msg.text}</div>}
          <button className="primary" disabled={busy}>{busy ? 'Un momento…' : 'Cambiar contraseña'}</button>
        </form>

        <p className="muted small">
          <a href="/terminos" target="_blank" rel="noreferrer">Términos de uso</a> · <a href="/privacidad" target="_blank" rel="noreferrer">Política de privacidad</a>
        </p>
        <button className="danger" onClick={onLogout}>Cerrar sesión</button>
      </div>
    </div>
  );
}
