import { useEffect, useState } from 'react';
import { API, authFetch, money2 } from './lib.js';
import { Empty } from './components.jsx';

const when = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' });

// El comprobante se baja con la sesión del personal y se muestra como imagen
function Proof({ id, token }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url;
    authFetch(`${API}/api/admin/topups/${id}/receipt`)
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => { url = URL.createObjectURL(b); setSrc(url); })
      .catch(() => setFailed(true));
    return () => url && URL.revokeObjectURL(url);
  }, [id, token]);
  if (failed) return <div className="muted small">El comprobante ya no está disponible.</div>;
  return src ? <a href={src} target="_blank" rel="noreferrer"><img className="docimg" src={src} alt="Comprobante de transferencia" /></a> : <div className="muted small">Cargando comprobante…</div>;
}

const ago = (d) => {
  const min = Math.max(0, Math.round((Date.now() - new Date(d).getTime()) / 60000));
  return min < 60 ? `hace ${min} min` : min < 1440 ? `hace ${Math.floor(min / 60)} h` : when(d);
};

// Solicitudes de recarga: el conductor pidió un monto; se le asigna una cuenta (la ve 24 horas) o se rechaza
function Requests({ call, waiting, onError, canSettings }) {
  const [data, setData] = useState({ requests: [], accounts: [] });
  const [pick, setPick] = useState({}); // solicitud → cuenta elegida
  const [busy, setBusy] = useState(0);
  const load = () => call('topup-requests').then(setData).catch((e) => onError(e.message));
  useEffect(() => { load(); }, [waiting]); // eslint-disable-line react-hooks/exhaustive-deps

  async function assign(r) {
    const accountId = Number(pick[r.id] || data.accounts[0]?.id);
    setBusy(r.id);
    try { await call(`topup-requests/${r.id}/assign`, { accountId }); await load(); } catch (e) { onError(e.message); } finally { setBusy(0); }
  }
  async function reject(r) {
    const note = window.prompt(`¿Por qué no se atiende? ${r.driver} verá este motivo:`, 'Por ahora no podemos recibir recargas, intenta más tarde');
    if (!note) return;
    try { await call(`topup-requests/${r.id}/reject`, { note }); await load(); } catch (e) { onError(e.message); }
  }

  if (!data.requests.length) return null;
  return (
    <section className="pending" aria-labelledby="req-title">
      <b id="req-title">🙋 Solicitudes de recarga ({data.requests.length})</b>
      <p className="muted small">Asigna una cuenta: solo ese conductor la ve, durante 24 horas, para transferir y subir su comprobante.</p>
      {!data.accounts.length && (
        <div className="hint danger">
          No hay cuentas bancarias activas para asignar.{' '}
          {canSettings && <button className="link" onClick={() => window.dispatchEvent(new CustomEvent('ktracho:go', { detail: 'settings' }))}>Agregar una en Ajustes</button>}
        </div>
      )}
      {data.requests.map((r) => (
        <div className="ucard" key={r.id}>
          <div className="grow">
            <b>{r.driver}</b> <span className="muted">· {money2(r.amount)}</span>
            <div className="muted small">Saldo actual {money2(r.driver_balance)} · <a href={`tel:${r.driver_phone}`}>{r.driver_phone}</a> · {ago(r.created_at)}</div>
          </div>
          {data.accounts.length > 0 && (
            <div className="row wrap">
              <select aria-label={`Cuenta para ${r.driver}`} value={pick[r.id] || data.accounts[0].id} onChange={(e) => setPick({ ...pick, [r.id]: e.target.value })}>
                {data.accounts.map((a) => <option key={a.id} value={a.id}>{a.bank} · {a.number}</option>)}
              </select>
              <button className="primary sm" disabled={busy === r.id} onClick={() => assign(r)}>Enviar cuenta</button>
              <button className="danger sm" onClick={() => reject(r)}>Rechazar</button>
            </div>
          )}
        </div>
      ))}
    </section>
  );
}

// Recargas por transferencia: el personal compara el comprobante con la cuenta de Ktracho GO y autoriza o rechaza
export default function Topups({ topups, status, setStatus, call, token, reload, onError, waiting = 0, canSettings = false }) {
  async function approve(t) {
    const v = window.prompt(`¿Cuánto muestra el comprobante? Se acreditará este monto a ${t.driver}.`, String(t.amount));
    if (v === null) return;
    const amount = Number(v);
    if (!(amount > 0)) return onError('Escribe un monto válido');
    try { await call(`topups/${t.id}/approve`, { amount }); await reload(); } catch (e) { onError(e.message); }
  }
  async function reject(t) {
    const note = window.prompt(`¿Por qué se rechaza? ${t.driver} verá este motivo:`, 'El comprobante no se lee o no coincide con el monto');
    if (!note) return;
    try { await call(`topups/${t.id}/reject`, { note }); await reload(); } catch (e) { onError(e.message); }
  }

  return (
    <>
      <Requests call={call} waiting={waiting} onError={onError} canSettings={canSettings} />
      <b>Comprobantes</b>
      <div className="chips">
        {[['pending', 'Por aprobar'], ['approved', 'Aprobadas'], ['rejected', 'Rechazadas']].map(([k, label]) => (
          <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{label}</button>
        ))}
      </div>
      {topups.length === 0 && <Empty title={`No hay recargas ${status === 'pending' ? 'por aprobar' : status === 'approved' ? 'aprobadas' : 'rechazadas'}`} />}
      {topups.map((t) => (
        <div className="req" key={t.id}>
          <div className="row between">
            <b>{t.driver} · {money2(t.amount)}</b>
            <span className="muted small">{when(t.created_at)}</span>
          </div>
          <div className="muted small">
            {t.bank} · referencia <b>{t.reference}</b> · saldo actual {money2(t.driver_balance)} · <a href={`tel:${t.driver_phone}`}>{t.driver_phone}</a>
          </div>
          {t.status === 'pending' && <Proof id={t.id} token={token} />}
          {t.status === 'approved' && <div className="hint ok">Acreditado {money2(t.approved_amount)}{t.reviewer ? ` por ${t.reviewer}` : ''}</div>}
          {t.status === 'rejected' && <div className="hint danger">Rechazada{t.reviewer ? ` por ${t.reviewer}` : ''}: {t.review_note}</div>}
          {t.status === 'pending' && (
            <div className="row wrap">
              <button className="primary sm" onClick={() => approve(t)}>✓ Aprobar y acreditar</button>
              <button className="danger sm" onClick={() => reject(t)}>Rechazar</button>
            </div>
          )}
        </div>
      ))}
    </>
  );
}
