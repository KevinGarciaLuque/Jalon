import { useEffect, useState } from 'react';
import { api, useInstall } from './lib.js';

const RESEND_SECONDS = 60;
const friendly = (e) => (e.message === 'Failed to fetch' ? 'No se pudo conectar con el servidor' : e.message);

export default function Auth({ onAuth, notice }) {
  const [mode, setMode] = useState('login'); // login | register | forgot
  const [step, setStep] = useState(1); // 1: datos · 2: código recibido por correo
  const [role, setRole] = useState('passenger');
  const [f, setF] = useState({ name: '', phone: '', email: '', password: '', vehicle: '', plate: '', code: '' });
  const [error, setError] = useState('');
  const [info, setInfo] = useState(notice || '');
  const [devCode, setDevCode] = useState('');
  const [wait, setWait] = useState(0);
  const [busy, setBusy] = useState(false);
  const [terms, setTerms] = useState(false);
  const [challenge, setChallenge] = useState(null); // el personal con verificación en dos pasos: tras la contraseña falta el código
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
    setF({ ...f, code: '', password: '' });
  }

  // Envía el código por correo (registro o recuperación)
  async function sendCode() {
    const path = mode === 'register' ? 'otp/send' : 'password/forgot';
    const res = await api(path, mode === 'register' ? { phone: f.phone, email: f.email } : { phone: f.phone });
    setDevCode(res.devCode || '');
    setF((cur) => ({ ...cur, code: res.devCode || '' }));
    setWait(RESEND_SECONDS);
    setStep(2);
    setInfo(mode === 'register' ? `Te enviamos un código de 6 dígitos a ${f.email.trim()}. Revisa también la carpeta de spam.` : 'Si ese teléfono tiene una cuenta, enviamos un código al correo registrado. Revisa también la carpeta de spam.');
  }

  async function submit(e) {
    e.preventDefault();
    setError('');
    setBusy(true);
    try {
      if (mode === 'login' && challenge) {
        onAuth(await api('login/2fa', { challenge, code: f.code.trim() }));
      } else if (mode === 'login') {
        const res = await api('login', { phone: f.phone, password: f.password });
        if (res.twoFactor) {
          setChallenge(res.challenge);
          setF((cur) => ({ ...cur, code: '' }));
        } else {
          onAuth(res);
        }
      } else if (step === 1) {
        if (f.password.length < 8) throw new Error('La contraseña debe tener al menos 8 caracteres');
        if (mode === 'register' && !terms) throw new Error('Debes aceptar los Términos y la Política de Privacidad');
        await sendCode();
      } else if (mode === 'register') {
        onAuth(await api('register', { ...f, role, acceptTerms: terms }));
      } else {
        await api('password/reset', { phone: f.phone, code: f.code, password: f.password });
        go('login');
        setInfo('Contraseña actualizada. Ya puedes entrar.');
      }
    } catch (err) {
      if (challenge && /venció/.test(err.message)) setChallenge(null);
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
    : step === 1 ? 'Enviar código a mi correo'
    : mode === 'register' ? 'Verificar y crear cuenta'
    : 'Cambiar contraseña';

  return (
    <div className="auth">
      <h1>Jalón</h1>
      <p className="tagline">Tú pones el precio. Tu conductor llega.</p>
      <form onSubmit={submit} className="card">
        <b>{title}</b>

        {mode === 'register' && step === 1 && (
          <>
            <div className="seg">
              <button type="button" className={role === 'passenger' ? 'on' : ''} onClick={() => setRole('passenger')}>Soy pasajero</button>
              <button type="button" className={role === 'driver' ? 'on' : ''} onClick={() => setRole('driver')}>Soy conductor</button>
            </div>
            <input placeholder="Nombre" value={f.name} onChange={set('name')} required />
          </>
        )}

        {challenge && (
          <>
            <p className="muted">Escribe el código de 6 dígitos de tu app de autenticación. Si perdiste el teléfono, usa un código de respaldo (XXXX-XXXX).</p>
            <input
              className="code"
              placeholder="Código"
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
            <input placeholder="Teléfono (8 dígitos)" inputMode="tel" autoComplete="tel" value={f.phone} onChange={set('phone')} required />
            {mode === 'register' && (
              <input placeholder="Correo electrónico" type="email" inputMode="email" autoComplete="email" maxLength={160} value={f.email} onChange={set('email')} required />
            )}
            <input
              placeholder={mode === 'forgot' ? 'Nueva contraseña' : 'Contraseña'}
              type="password"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
              value={f.password}
              onChange={set('password')}
              required
            />
          </>
        )}

        {mode === 'register' && step === 1 && role === 'driver' && (
          <>
            <input placeholder="Vehículo (ej. Toyota Corolla blanco)" value={f.vehicle} onChange={set('vehicle')} required />
            <input placeholder="Placa" value={f.plate} onChange={set('plate')} required />
            <p className="muted small">Después de registrarte subirás tu foto, licencia y matrícula para que revisemos tu cuenta.</p>
          </>
        )}

        {step === 2 && (
          <>
            {info && <div className="hint ok">{info}</div>}
            {devCode && <div className="hint">Modo desarrollo (sin correo real): tu código es <b>{devCode}</b></div>}
            <input
              className="code"
              placeholder="Código de 6 dígitos"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={f.code}
              onChange={(e) => setF({ ...f, code: e.target.value.replace(/\D/g, '') })}
              required
              autoFocus
            />
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

        {mode === 'login' && !challenge && (
          <>
            <button type="button" className="link" onClick={() => go('forgot')}>¿Olvidaste tu contraseña?</button>
            <button type="button" className="link" onClick={() => go('register')}>¿No tienes cuenta? Regístrate</button>
          </>
        )}
        {mode !== 'login' && !challenge && <button type="button" className="link" onClick={() => go('login')}>← Volver a entrar</button>}
        {mode === 'login' && install.canInstall && <button type="button" className="link" onClick={install.prompt}>📲 Instalar la app</button>}
      </form>
    </div>
  );
}
