import { useState } from 'react';
import { apiGet, apiPost, useInstall } from './lib.js';

const ROLE = { passenger: 'Pasajero', driver: 'Conductor', admin: 'Administrador', superadmin: 'Superadministrador', support: 'Soporte' };
const STAFF = ['superadmin', 'admin', 'support'];

export default function Account({ user, token, onToken, onClose, onLogout, forced = false }) {
  const install = useInstall();
  const [f, setF] = useState({ current: '', next: '', again: '' });
  const [msg, setMsg] = useState({ ok: false, text: '' });
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState({ ok: true, text: '' });
  const [codes, setCodes] = useState(null); // códigos de respaldo nuevos
  const isStaff = STAFF.includes(user.role);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const min = isStaff ? 10 : 8;

  async function changePassword(e) {
    e.preventDefault();
    if (f.next.length < min) return setMsg({ ok: false, text: `La contraseña nueva debe tener al menos ${min} caracteres` });
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

  async function logoutAll() {
    if (!window.confirm('¿Cerrar tu sesión en todos los demás dispositivos? Esta sesión seguirá abierta.')) return;
    try {
      const { token: fresh } = await apiPost('logout-all', token);
      onToken(fresh);
      setNote({ ok: true, text: 'Listo: se cerraron las sesiones en los demás dispositivos.' });
    } catch (err) {
      setNote({ ok: false, text: err.message });
    }
  }

  // Descargar todo lo que la plataforma guarda de ti (archivo JSON)
  async function exportData() {
    try {
      const data = await apiGet('me/export', token);
      const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'mis-datos-jalon.json';
      a.click();
      URL.revokeObjectURL(url);
      setNote({ ok: true, text: 'Se descargó el archivo con tus datos.' });
    } catch (err) {
      setNote({ ok: false, text: err.message });
    }
  }

  async function deleteAccount() {
    const word = window.prompt('Se eliminarán tu nombre, teléfono, documentos y comentarios. Tus viajes quedan sin direcciones para estadísticas y reclamos. No se puede deshacer.\n\nEscribe ELIMINAR para continuar:');
    if (word !== 'ELIMINAR') return;
    const password = window.prompt('Por seguridad, escribe tu contraseña:');
    if (!password) return;
    try {
      await apiPost('me/delete', token, { password });
      onLogout('Tu cuenta fue eliminada. Gracias por haber usado Jalón.');
    } catch (err) {
      setNote({ ok: false, text: err.message });
    }
  }

  async function newBackupCodes() {
    const password = window.prompt('Escribe tu contraseña para generar códigos de respaldo nuevos (los anteriores dejarán de servir):');
    if (!password) return;
    try {
      setCodes((await apiPost('2fa/backup-codes', token, { password })).backupCodes);
    } catch (err) {
      setNote({ ok: false, text: err.message });
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
          <p className="muted small">Mínimo {min} caracteres, no solo números ni algo muy común, y sin tu teléfono.</p>
          {msg.text && <div className={msg.ok ? 'hint ok' : 'error'}>{msg.text}</div>}
          <button className="primary" disabled={busy}>{busy ? 'Un momento…' : 'Cambiar contraseña'}</button>
        </form>

        {!forced && (
          <>
            {isStaff && (
              <div className="req">
                <b>Verificación en dos pasos</b>
                <div className={user.twoFactorEnabled ? 'ok' : 'error'}>{user.twoFactorEnabled ? '✓ Activada' : 'No está activada'}</div>
                {user.twoFactorEnabled && <button onClick={newBackupCodes}>Generar códigos de respaldo nuevos</button>}
                {codes && (
                  <>
                    <div className="hint">Guárdalos ahora: no se volverán a mostrar. Los anteriores ya no sirven.</div>
                    <div className="backup">{codes.map((c) => <code key={c}>{c}</code>)}</div>
                  </>
                )}
              </div>
            )}

            <div className="req">
              <b>Seguridad de tu sesión</b>
              <button onClick={logoutAll}>Cerrar sesión en los demás dispositivos</button>
            </div>

            {!isStaff && (
              <div className="req">
                <b>Tus datos</b>
                <button onClick={exportData}>⬇ Descargar mis datos</button>
                <button className="danger" onClick={deleteAccount}>Eliminar mi cuenta</button>
              </div>
            )}
            {note.text && <div className={note.ok ? 'hint ok' : 'error'}>{note.text}</div>}
          </>
        )}

        <p className="muted small">
          <a href="/terminos" target="_blank" rel="noreferrer">Términos de uso</a> · <a href="/privacidad" target="_blank" rel="noreferrer">Política de privacidad</a>
        </p>
        <button className="danger" onClick={() => onLogout()}>Cerrar sesión</button>
      </div>
    </div>
  );
}
