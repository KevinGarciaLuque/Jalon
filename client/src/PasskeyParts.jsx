import { useEffect, useState } from 'react';
import { activatePasskey, deviceCanUnlock, listPasskeys, passkeyName, passkeysSupported, removePasskey } from './passkeys.js';

const OFFER_KEY = (id) => `ktracho:pk-offer:${id}`; // en este aparato ya se le ofreció (una sola vez)
const when = (d) => new Date(d).toLocaleDateString('es-HN', { day: 'numeric', month: 'short', year: 'numeric' });

// Después de entrar con la contraseña: «¿Quieres entrar con Face ID la próxima vez?» (una vez por aparato y cuenta)
export function PasskeyOffer({ userId, onClose }) {
  const [show, setShow] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        if (localStorage.getItem(OFFER_KEY(userId))) return onClose();
      } catch { return onClose(); }
      // Solo si el aparato tiene Face ID / huella y la cuenta todavía no lo usa en ningún aparato
      const can = await deviceCanUnlock();
      const mine = can ? await listPasskeys().catch(() => [1]) : [];
      if (!alive) return;
      if (can && mine.length === 0) setShow(true); else onClose();
    })();
    return () => { alive = false; };
  }, [userId]); // eslint-disable-line react-hooks/exhaustive-deps

  function close() {
    try { localStorage.setItem(OFFER_KEY(userId), '1'); } catch { /* se volverá a ofrecer */ }
    onClose();
  }
  async function activate() {
    setBusy(true);
    setError('');
    try {
      const list = await activatePasskey();
      if (list) setDone(true);
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!show) return null;
  return (
    <div className="offer-pop" role="dialog" aria-modal="true" aria-labelledby="pk-offer-title">
      <div className="card">
        <b id="pk-offer-title">{done ? '¡Listo!' : `¿Entrar con ${passkeyName} la próxima vez?`}</b>
        {done ? (
          <p>La próxima vez toca <b>«Entrar con {passkeyName}»</b> y listo: sin escribir tu contraseña.</p>
        ) : (
          <p className="muted">Entras más rápido y sin escribir la contraseña. Tu cara o tu huella nunca salen de tu celular. La contraseña sigue funcionando.</p>
        )}
        {error && <div className="error">{error}</div>}
        {done ? (
          <button className="primary" onClick={close}>Entendido</button>
        ) : (
          <>
            <button className="primary" disabled={busy} onClick={activate}>{busy ? 'Un momento…' : 'Activar'}</button>
            <button className="link" disabled={busy} onClick={close}>Ahora no</button>
          </>
        )}
      </div>
    </div>
  );
}

// Mi cuenta: los aparatos con Face ID / huella, activar en este y quitar
export function PasskeySection({ token }) {
  const [list, setList] = useState(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState({ ok: true, text: '' });

  useEffect(() => { listPasskeys(token).then(setList).catch(() => setList([])); }, [token]);
  if (!passkeysSupported()) return null;

  async function activate() {
    setBusy(true);
    setMsg({ ok: true, text: '' });
    try {
      const next = await activatePasskey(token);
      if (next) { setList(next); setMsg({ ok: true, text: `Listo: ya puedes entrar con ${passkeyName} en este aparato.` }); }
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(false);
    }
  }
  async function remove(p) {
    if (!window.confirm(`¿Quitar ${passkeyName} del aparato «${p.device}»? Ahí tendrás que entrar con tu contraseña.`)) return;
    try {
      setList(await removePasskey(token, p.id));
      setMsg({ ok: true, text: 'Quitado.' });
    } catch (e) {
      setMsg({ ok: false, text: e.message });
    }
  }

  return (
    <section className="req" aria-labelledby="pk-title">
      <b id="pk-title">Entrar con {passkeyName}</b>
      <p className="muted small">Entra sin escribir tu contraseña. Tu cara o tu huella nunca salen de tu celular; la contraseña sigue funcionando.</p>
      {list === null && <p className="muted small">Cargando…</p>}
      {list?.length === 0 && <p className="muted small">Todavía no lo tienes activado en ningún aparato.</p>}
      {list?.map((p) => (
        <div key={p.id} className="row between">
          <span>
            <span>{p.device}</span>
            <br />
            <span className="muted small">Activado el {when(p.createdAt)}{p.lastUsedAt ? ` · usado el ${when(p.lastUsedAt)}` : ''}</span>
          </span>
          <button className="sm" onClick={() => remove(p)}>Quitar</button>
        </div>
      ))}
      {msg.text && <div className={msg.ok ? 'hint ok' : 'error'}>{msg.text}</div>}
      <button className="primary" disabled={busy} onClick={activate}>{busy ? 'Un momento…' : `Activar ${passkeyName} en este aparato`}</button>
    </section>
  );
}

