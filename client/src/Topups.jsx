import { useEffect, useState } from 'react';
import { API, money2 } from './lib.js';

const when = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' });

// El comprobante se baja con la sesión del personal y se muestra como imagen
function Proof({ id, token }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url;
    fetch(`${API}/api/admin/topups/${id}/receipt`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => { url = URL.createObjectURL(b); setSrc(url); })
      .catch(() => setFailed(true));
    return () => url && URL.revokeObjectURL(url);
  }, [id, token]);
  if (failed) return <div className="muted small">El comprobante ya no está disponible.</div>;
  return src ? <a href={src} target="_blank" rel="noreferrer"><img className="docimg" src={src} alt="Comprobante de transferencia" /></a> : <div className="muted small">Cargando comprobante…</div>;
}

// Recargas por transferencia: el personal compara el comprobante con la cuenta de Jalón y autoriza o rechaza
export default function Topups({ topups, status, setStatus, call, token, reload, onError }) {
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
      <div className="chips">
        {[['pending', 'Por aprobar'], ['approved', 'Aprobadas'], ['rejected', 'Rechazadas']].map(([k, label]) => (
          <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{label}</button>
        ))}
      </div>
      {topups.length === 0 && <p className="muted">No hay recargas {status === 'pending' ? 'por aprobar' : status === 'approved' ? 'aprobadas' : 'rechazadas'}.</p>}
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
