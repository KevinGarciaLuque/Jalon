import { useState } from 'react';
import { apiGet, apiPost, apiPut, useInstall } from './lib.js';
import { PushToggle, PasswordInput } from './components.jsx';
import { SavedPlaces, TrustedContacts } from './PersonalLists.jsx';
import { Panel } from './Menu.jsx';
import { PasskeySection } from './PasskeyParts.jsx';

const ROLE = { passenger: 'Pasajero', driver: 'Conductor', admin: 'Administrador', superadmin: 'Superadministrador', support: 'Soporte' };
const STAFF = ['superadmin', 'admin', 'support'];

// PIN de viaje opcional: al subir, el pasajero le dice al conductor un PIN de 4 dígitos (sin él no inicia el viaje)
function PinSection({ user }) {
  const [on, setOn] = useState(!!user.ridePin);
  const [error, setError] = useState('');
  async function toggle(v) {
    setOn(v);
    setError('');
    try {
      const r = await apiPut('me/ride-pin', null, { enabled: v });
      window.dispatchEvent(new CustomEvent('ktracho:profile', { detail: { ridePin: r.ridePin } }));
    } catch (e) {
      setOn(!v);
      setError(e.message);
    }
  }
  return (
    <section className="req" aria-labelledby="pin-title">
      <b id="pin-title">PIN de viaje</b>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => toggle(e.target.checked)} />
        <span><b>Usar PIN en mis viajes</b>: cuando el conductor acepte, verás un PIN de 4 dígitos. Díselo al subir; sin él no puede iniciar el viaje. Así confirmas que te subes al carro correcto.</span>
      </label>
      <p className="muted small">En los viajes «Solo conductoras» el PIN se usa siempre.</p>
      {error && <div className="error">{error}</div>}
    </section>
  );
}

// Sexo (opcional): solo sirve para «Solo conductoras». A las conductoras se lo confirma el equipo con su licencia.
function GenderSection({ user }) {
  const [value, setValue] = useState(user.gender || '');
  const [msg, setMsg] = useState({ ok: true, text: '' });
  async function save(v) {
    setValue(v);
    try {
      const r = await apiPut('me/gender', null, { gender: v || null });
      window.dispatchEvent(new CustomEvent('ktracho:profile', { detail: { gender: r.gender, genderVerified: r.genderVerified } }));
      setMsg({ ok: true, text: 'Guardado.' });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  }
  return (
    <section className="req" aria-labelledby="gender-title">
      <b id="gender-title">Sexo (opcional)</b>
      <p className="muted small">
        {user.role === 'driver'
          ? 'Si eres mujer, indícalo: el equipo lo confirma con tu licencia y recibirás también los viajes «Solo conductoras».'
          : 'Si eres mujer, podrás pedir «Solo conductoras». No se lo mostramos a nadie más.'}
      </p>
      <select aria-label="Sexo" value={value} onChange={(e) => save(e.target.value)}>
        <option value="">Prefiero no decirlo</option>
        <option value="f">Mujer</option>
        <option value="m">Hombre</option>
        <option value="x">Otro</option>
      </select>
      {user.role === 'driver' && value === 'f' && <p className="small">{user.genderVerified ? '✓ Confirmado por el equipo' : '⏳ El equipo lo confirmará con tu licencia'}</p>}
      {msg.text && <div className={msg.ok ? 'hint ok' : 'error'}>{msg.text}</div>}
    </section>
  );
}

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
      await apiPost('password/change', token, { current: f.current, password: f.next });
      onToken(); // las demás sesiones se cierran; esta sigue (el servidor renovó la cookie)
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
      await apiPost('logout-all', token);
      onToken();
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
      a.download = 'mis-datos-ktracho-go.json';
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
      onLogout('Tu cuenta fue eliminada. Gracias por haber usado Ktracho GO.');
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
    <Panel onClose={forced ? null : onClose} labelledBy="account-title">
      <div className="overlay-head">
        <b id="account-title">{forced ? 'Cambia tu contraseña para continuar' : 'Mi cuenta'}</b>
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
            <b>📲 Instalar Ktracho GO en tu celular</b>
            {install.canInstall ? (
              <button className="primary" onClick={install.prompt}>Instalar la app</button>
            ) : (
              <p className="muted">En iPhone: toca el botón Compartir de Safari y elige &quot;Agregar a inicio&quot;.</p>
            )}
          </div>
        )}

        {!forced && user.role === 'passenger' && <PinSection user={user} />}
        {!forced && !isStaff && <GenderSection user={user} />}
        {!forced && <PasskeySection token={token} />}

        <form className="req" onSubmit={changePassword}>
          <b>Cambiar contraseña</b>
          <PasswordInput autoComplete="current-password" aria-label="Contraseña actual" placeholder="Contraseña actual" value={f.current} onChange={set('current')} required />
          <PasswordInput autoComplete="new-password" aria-label="Contraseña nueva" placeholder="Contraseña nueva" value={f.next} onChange={set('next')} required />
          <PasswordInput autoComplete="new-password" aria-label="Repite la contraseña nueva" placeholder="Repite la contraseña nueva" value={f.again} onChange={set('again')} required />
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
              <b>Notificaciones</b>
              <PushToggle token={token} why={isStaff ? 'Recibe en tu celular las emergencias y las solicitudes de conductores.' : user.role === 'driver' ? 'Entérate de viajes cercanos y de que te aceptaron, aunque tengas la app cerrada.' : 'Entérate de las ofertas y de la llegada de tu conductor, aunque tengas la app cerrada.'} />
            </div>

            {user.role === 'passenger' && (
              <>
                <TrustedContacts token={token} />
                <SavedPlaces token={token} />
              </>
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
    </Panel>
  );
}
