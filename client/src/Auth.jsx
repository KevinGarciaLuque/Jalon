import { useEffect, useState } from 'react';
import { api, useInstall } from './lib.js';
import { Brand, PasswordInput, VehicleFields } from './components.jsx';
import { loginWithPasskey, passkeyName, passkeysSupported } from './passkeys.js';

const RESEND_SECONDS = 60;
// Enlace de invitación (QR de «Compartir» del panel): ?registro=conductor abre el registro con «Soy conductor» elegido
const invite = new URLSearchParams(window.location.search).get('registro');
// Si ya no tiene acceso a su correo: escribirle a soporte (variables de Railway, se ponen al compilar)
const SUPPORT_EMAIL = import.meta.env.VITE_CONTACT_EMAIL;
const SUPPORT_WHATSAPP = (import.meta.env.VITE_SUPPORT_WHATSAPP || '').replace(/\D/g, '');
const supportLink = SUPPORT_WHATSAPP
  ? `https://wa.me/${SUPPORT_WHATSAPP.length === 8 ? `504${SUPPORT_WHATSAPP}` : SUPPORT_WHATSAPP}?text=${encodeURIComponent('Hola, no puedo entrar a mi cuenta de Ktracho GO y ya no tengo acceso a mi correo.')}`
  : SUPPORT_EMAIL ? `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent('No puedo entrar a mi cuenta')}` : '';
const friendly = (e) => (e.message === 'Failed to fetch' ? 'No se pudo conectar con el servidor' : e.message);

export default function Auth({ onAuth, notice }) {
  const [mode, setMode] = useState(invite ? 'register' : 'login'); // login | register | forgot
  const [step, setStep] = useState(1); // 1: datos · 2: código recibido por correo
  const [role, setRole] = useState(invite === 'conductor' ? 'driver' : 'passenger');
  const [f, setF] = useState({ name: '', phone: '', email: '', password: '', again: '', code: '', category: 'car', make: '', model: '', color: '', year: '', plate: '' });
  const [error, setError] = useState('');
  const [info, setInfo] = useState(notice || '');
  const [devCode, setDevCode] = useState('');
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState(false);
  const [challenge, setChallenge] = useState(null); // el personal con verificación en dos pasos: tras la contraseña falta el código
  const [via, setVia] = useState('password'); // con qué entró (después de la contraseña se ofrece activar Face ID)
  const canPasskey = passkeysSupported();
  const install = useInstall();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });

  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait(wait - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);

  function go(next) {
    setMode(next);
    setStep(1);
    setError('');
    setInfo('');
    setDevCode('');
    setF({ ...f, code: '', password: '', again: '' });
  }

  // Envía el código por correo (registro o recuperación)
  async function sendCode() {
    const path = mode === 'register' ? 'otp/send' : 'password/forgot';
    const res = await api(path, mode === 'register' ? { phone: f.phone, email: f.email } : { login: f.phone });
    setDevCode(res.devCode || '');
    setF((cur) => ({ ...cur, code: res.devCode || '' }));
    setWait(RESEND_SECONDS);
    setStep(2);
    setInfo(mode === 'register' ? `Te enviamos un código de 6 dígitos a ${f.email.trim()}. Revisa también la carpeta de spam.` : 'Si ese teléfono o correo tiene una cuenta, te enviamos un código de 6 dígitos al correo registrado. Revisa también la carpeta de spam.');
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login' && challenge) {
        onAuth(await api('login/2fa', { challenge, code: f.code.trim() }), via);
      } else if (mode === 'login') {
        const res = await api('login', { phone: f.phone, password: f.password });
        if (res.twoFactor) {
          setVia('password');
          setChallenge(res.challenge);
          setF((cur) => ({ ...cur, code: '' }));
        } else {
          onAuth(res, 'password');
        }
      } else if (step === 1) {
        if (mode === 'register' && f.password.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
        if (mode === 'register' && !terms) throw new Error('Debes aceptar los Términos y la Política de Privacidad');
        await sendCode();
      } else if (mode === 'register') {
        onAuth(await api('register', { ...f, role, acceptTerms: terms }));
      } else {
        // Recuperar: con el código se elige la contraseña nueva y se entra directo
        if (f.password !== f.again) throw new Error('Las dos contraseñas nuevas no coinciden');
        onAuth(await api('password/reset', { login: f.phone, code: f.code, password: f.password }), 'password');
      }
    } catch (err) {
      if (challenge && /venció/.test(err.message)) setChallenge(null);
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }

  // Entrar con Face ID / huella: el celular ofrece las cuentas guardadas para Ktracho GO
  async function passkeyLogin() {
    setError('');
    setBusy(true);
    try {
      const res = await loginWithPasskey();
      if (!res) return; // la persona canceló
      if (res.twoFactor) {
        setVia('passkey');
        setChallenge(res.challenge);
        setF((cur) => ({ ...cur, code: '' }));
      } else {
        onAuth(res, 'passkey');
      }
    } catch (err) {
      setError(friendly(err));
    } finally {
      setBusy(false);
    }
  }

  async function resend() {
    setError('');
    setBusy(true);
    try { await sendCode(); } catch (err) { setError(friendly(err)); } finally { setBusy(false); }
  }

  const title = challenge ? 'Verificación en dos pasos' : { login: 'Entrar', register: 'Crear cuenta', forgot: 'Recuperar contraseña' }[mode];
  const button =
    challenge ? 'Verificar' : mode === 'login' ? 'Entrar'
    : step === 1 ? (mode === 'forgot' ? 'Enviar código' : 'Enviar código a mi correo')
    : mode === 'register' ? 'Verificar y crear cuenta'
    : 'Cambiar contraseña y entrar';

  return (
    <div className="auth">
      <h1><Brand size="lg" /></h1>
      <p className="tagline">Tú pones el precio. Tu conductor llega.</p>
      {/* method/action y los name: así el llavero del iPhone (y los gestores de contraseñas) reconocen el formulario y ofrecen guardar la contraseña */}
      <form onSubmit={submit} className="card" method="post" action="/" autoComplete="on">
        <b>{title}</b>

        {mode === 'register' && step === 1 && (
          <>
            <div className="seg">
              <button type="button" className={role === 'passenger' ? 'on' : ''} onClick={() => setRole('passenger')}>Soy pasajero</button>
              <button type="button" className={role === 'driver' ? 'on' : ''} onClick={() => setRole('driver')}>Soy conductor</button>
            </div>
            <input aria-label="Nombre" placeholder="Nombre" value={f.name} onChange={set('name')} required />
          </>
        )}

        {challenge && (
          <>
            <p className="muted">Escribe el código de 6 dígitos de tu app de autenticación. Si perdiste el teléfono, usa un código de respaldo (XXXX-XXXX).</p>
            <input
              className="code"
              aria-label="Código" placeholder="Código"
              autoComplete="one-time-code"
              maxLength={9}
              value={f.code}
              onChange={(e) => setF({ ...f, code: e.target.value })}
              required
              autoFocus
            />
            <button type="button" className="link" onClick={() => { setChallenge(null); setError(''); setF((cur) => ({ ...cur, code: '', password: '' })); }}>← Volver</button>
          </>
        )}

        {step === 1 && !challenge && (
          <>
            {/* El teléfono es el usuario de la cuenta: «username» (no «tel») para que el iPhone lo guarde junto con la contraseña */}
            {mode === 'forgot' ? (
              <>
                <p className="muted small">Escribe tu teléfono o el correo de tu cuenta. Te enviaremos un código para que elijas una contraseña nueva.</p>
                <input id="username" name="username" aria-label="Teléfono o correo" placeholder="Teléfono o correo" autoComplete="username" autoCapitalize="off" spellCheck={false} maxLength={160} value={f.phone} onChange={set('phone')} required />
              </>
            ) : (
              <input id="username" name="username" aria-label="Teléfono (8 dígitos)" placeholder="Teléfono (8 dígitos)" inputMode="tel" autoComplete="username" value={f.phone} onChange={set('phone')} required />
            )}
            {mode === 'register' && (
              <input aria-label="Correo electrónico" placeholder="Correo electrónico" type="email" inputMode="email" autoComplete="email" maxLength={160} value={f.email} onChange={set('email')} required />
            )}
            {mode !== 'forgot' && (
              <PasswordInput
                id="password" name="password"
                aria-label="Contraseña" placeholder="Contraseña"
                autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
                value={f.password}
                onChange={set('password')}
                required
              />
            )}
          </>
        )}

        {mode === 'register' && step === 1 && role === 'driver' && (
          <>
            <b className="small">Tu vehículo</b>
            <VehicleFields value={f} onChange={(v) => setF({ ...f, ...v })} />
            <p className="muted small">Después de registrarte subirás tu foto, licencia y matrícula para que revisemos tu cuenta.</p>
          </>
        )}

        {step === 2 && (
          <>
            {info && <div className="hint ok">{info}</div>}
            {devCode && <div className="hint">Modo desarrollo (sin correo real): tu código es <b>{devCode}</b></div>}
            <input
              className="code"
              aria-label="Código de 6 dígitos" placeholder="Código de 6 dígitos"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={f.code}
              onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })}
              required
              autoFocus
            />
            {/* Recuperar: la contraseña nueva se elige después de recibir el código */}
            {mode === 'forgot' && (
              <>
                <PasswordInput id="password" name="password" aria-label="Nueva contraseña" placeholder="Nueva contraseña" autoComplete="new-password" value={f.password} onChange={set('password')} required />
                <PasswordInput aria-label="Repite la contraseña nueva" placeholder="Repite la contraseña nueva" autoComplete="new-password" value={f.again} onChange={set('again')} required />
                <p className="muted small">Mínimo 8 caracteres, no solo números ni algo muy común, y sin tu teléfono.</p>
              </>
            )}
            <div className="row between">
              <button type="button" className="link" onClick={() => { setStep(1); setInfo(''); setDevCode(''); }}>← Cambiar datos</button>
              <button type="button" className="link" disabled={wait > 0 || busy} onClick={resend}>
                {wait > 0 ? `Reenviar en ${wait} s` : 'Reenviar código'}
              </button>
            </div>
          </>
        )}

        {mode === 'register' && step === 1 && (
          <label className="check terms">
            <input type="checkbox" checked={terms} onChange={(e) => setTerms(e.target.checked)} />
            <span>
              Tengo 18 años o más y acepto los <a href="/terminos" target="_blank" rel="noreferrer">Términos de uso</a> y la{' '}
              <a href="/privacidad" target="_blank" rel="noreferrer">Política de privacidad</a>.
            </span>
          </label>
        )}

        {step === 1 && info && <div className="hint ok">{info}</div>}
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy || (step === 2 && f.code.length !== 6)}>{busy ? 'Un momento…' : button}</button>

        {mode === 'login' && !challenge && canPasskey && (
          <>
            <div className="or"><span>o</span></div>
            <button type="button" className="passkey-btn" disabled={busy} onClick={passkeyLogin}>
              <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2M9 9.5v1M15 9.5v1M12 9v4h-1M9.5 15.5c1.5 1.2 3.5 1.2 5 0" />
              </svg>
              Entrar con {passkeyName}
            </button>
          </>
        )}
        {mode === 'login' && !challenge && (
          <>
            <button type="button" className="link" onClick={() => go('forgot')}>¿Olvidaste tu contraseña?</button>
            <button type="button" className="link" onClick={() => go('register')}>¿No tienes cuenta? Regístrate</button>
          </>
        )}
        {mode === 'forgot' && supportLink && (
          <p className="muted small center">¿Ya no tienes acceso a tu correo? <a href={supportLink} target="_blank" rel="noreferrer">Escríbenos</a></p>
        )}
        {mode !== 'login' && !challenge && <button type="button" className="link" onClick={() => go('login')}>← Volver a entrar</button>}
        {mode === 'login' && install.canInstall && <button type="button" className="link" onClick={install.prompt}>📲 Instalar la app</button>}
      </form>
    </div>
  );
}
