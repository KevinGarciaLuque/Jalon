import { useState } from 'react';
import { apiPost } from './lib.js';

// Lo más importante que cambió en la última versión (la lista completa está en cada página)
const CHANGES = [
  'Mientras un viaje está en curso guardamos el camino que sigue el carro, para mostrártelo en tu historial y en el recibo y para atender reclamos. Se borra a los 90 días.',
  'Si eres conductor, guardamos cuándo te pones disponible y cuándo te desconectas, para mostrarte tus horas y tu ganancia por hora (no dónde estabas).',
  'Tu sesión se guarda en una cookie segura que solo sirve para mantenerte dentro de tu cuenta.',
];

// Quien aceptó una versión anterior la ve al abrir la app. Si no está de acuerdo puede salir, o descargar sus datos y eliminar su cuenta.
export default function TermsUpdate({ version, onAccepted, onAccount, onLogout }) {
  const [ok, setOk] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function accept() {
    setBusy(true);
    setError('');
    try {
      await apiPost('terms/accept', null, { version });
      onAccepted();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="overlay" role="dialog" aria-modal="true" aria-labelledby="terms-title">
      <div className="overlay-head">
        <b id="terms-title">Actualizamos los términos (versión {version})</b>
      </div>
      <div className="overlay-body">
        <p>Antes de seguir, revisa lo que cambió en los Términos de uso y la Política de privacidad:</p>
        <ul>{CHANGES.map((c) => <li key={c}>{c}</li>)}</ul>
        <p>
          Puedes leerlos completos: <a href="/terminos" target="_blank" rel="noreferrer">Términos de uso</a> y{' '}
          <a href="/privacidad" target="_blank" rel="noreferrer">Política de privacidad</a>.
        </p>
        <label className="check terms">
          <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
          <span>Leí y acepto los Términos de uso y la Política de privacidad (versión {version})</span>
        </label>
        {error && <p className="error" role="alert">{error}</p>}
        <button className="primary" disabled={!ok || busy} onClick={accept}>{busy ? 'Guardando…' : 'Aceptar y seguir'}</button>
        <p className="muted small">Si no estás de acuerdo, puedes descargar tus datos o eliminar tu cuenta.</p>
        <div className="row wrap">
          <button onClick={onAccount}>Ir a mi cuenta</button>
          <button className="link" onClick={onLogout}>Salir</button>
        </div>
      </div>
    </div>
  );
}
