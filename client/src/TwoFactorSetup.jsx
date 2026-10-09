import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { apiPost } from './lib.js';

// Activación obligatoria de la verificación en dos pasos del personal: escanear el QR, confirmar con un código y guardar los códigos de respaldo
export default function TwoFactorSetup({ token, onDone, onLogout }) {
  const [setup, setSetup] = useState(null); // { secret, otpauthUrl, qr }
  const [code, setCode] = useState('');
  const [codes, setCodes] = useState(null); // códigos de respaldo (se muestran una sola vez)
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiPost('2fa/setup', token)
      .then(async (s) => {
        const qr = await QRCode.toDataURL(s.otpauthUrl, { width: 240, margin: 1 });
        if (!cancelled) setSetup({ ...s, qr });
      })
      .catch((e) => !cancelled && setError(e.message));
    return () => { cancelled = true; };
  }, [token]);

  async function confirm(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await apiPost('2fa/enable', token, { code: code.trim() });
      setCodes(r.backupCodes);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  const text = codes ? `Códigos de respaldo de Jalón\nCada uno sirve una sola vez.\n\n${codes.join('\n')}\n` : '';
  async function copy() {
    try { await navigator.clipboard.writeText(text); setCopied(true); } catch { window.prompt('Copia los códigos:', codes.join(' ')); }
  }
  function download() {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = 'jalon-codigos-de-respaldo.txt';
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="overlay top">
      <div className="overlay-head">
        <b>{codes ? 'Guarda tus códigos de respaldo' : 'Activa la verificación en dos pasos'}</b>
        <button className="link" onClick={onLogout}>Salir</button>
      </div>
      <div className="overlay-body">
        {!codes && (
          <>
            <div className="hint">El personal necesita este segundo paso para proteger los datos y documentos de todos los usuarios.</div>
            <ol className="steps">
              <li>Instala una app de autenticación: <b>Google Authenticator</b>, Microsoft Authenticator, Authy o 1Password.</li>
              <li>Escanea este código QR con la app (o escribe la clave a mano).</li>
              <li>Escribe aquí el código de 6 dígitos que muestra la app.</li>
            </ol>
            {!setup && !error && <div className="pulse">Preparando…</div>}
            {setup && (
              <>
                <img className="qr" src={setup.qr} alt="Código QR para la app de autenticación" />
                <div className="muted small">¿No puedes escanear? Escribe esta clave en la app:</div>
                <div className="secret" data-testid="secret">{setup.secret}</div>
                <form className="req" onSubmit={confirm}>
                  <input
                    className="code"
                    placeholder="Código de 6 dígitos"
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    maxLength={6}
                    value={code}
                    onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    required
                  />
                  {error && <div className="error">{error}</div>}
                  <button className="primary" disabled={busy || code.length !== 6}>{busy ? 'Un momento…' : 'Activar'}</button>
                </form>
              </>
            )}
            {!setup && error && <div className="error">{error}</div>}
          </>
        )}

        {codes && (
          <>
            <div className="hint">
              Si pierdes tu teléfono, estos códigos son la única forma de entrar sin ayuda. <b>Cada uno sirve una sola vez y no se volverán a mostrar.</b> Guárdalos en un lugar seguro (por ejemplo, tu gestor de contraseñas).
            </div>
            <div className="backup" data-testid="backup-codes">{codes.map((c) => <code key={c}>{c}</code>)}</div>
            <div className="row">
              <button onClick={copy}>{copied ? '✓ Copiados' : 'Copiar'}</button>
              <button onClick={download}>Descargar .txt</button>
            </div>
            <label className="check">
              <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />
              <span>Ya guardé mis códigos de respaldo</span>
            </label>
            <button className="primary" disabled={!saved} onClick={onDone}>Continuar al panel</button>
          </>
        )}
      </div>
    </div>
  );
}
