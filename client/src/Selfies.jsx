import { useEffect, useState } from 'react';
import { API, authFetch } from './lib.js';
import { Empty } from './components.jsx';

const when = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' });

// Imagen protegida (se baja con la sesión del personal)
function Img({ url, alt }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let obj;
    authFetch(url).then((r) => (r.ok ? r.blob() : Promise.reject())).then((b) => { obj = URL.createObjectURL(b); setSrc(obj); }).catch(() => setFailed(true));
    return () => obj && URL.revokeObjectURL(obj);
  }, [url]);
  if (failed) return <div className="selfie-img muted small">No disponible</div>;
  return src ? <img className="selfie-img" src={src} alt={alt} /> : <div className="selfie-img muted small">Cargando…</div>;
}

// Selfies de los conductores al conectarse: lado a lado con la foto que se aprobó
export default function Selfies({ call, onError, reload }) {
  const [status, setStatus] = useState('pending');
  const [list, setList] = useState(null);
  const load = () => call(`selfies?status=${status}`).then(setList).catch((e) => onError(e.message));
  useEffect(() => { setList(null); load(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps

  async function review(s, result) {
    if (result === 'mismatch' && !window.confirm(`¿No es la misma persona? Se bloqueará la cuenta de ${s.driver} y se cancelará su viaje si tiene uno.`)) return;
    try { await call(`selfies/${s.id}/review`, { result }); await load(); reload?.(); } catch (e) { onError(e.message); }
  }

  return (
    <>
      <div className="chips">
        {[['pending', 'Por revisar'], ['ok', 'Coinciden'], ['mismatch', 'No coinciden']].map(([k, label]) => (
          <button key={k} className={status === k ? 'on' : ''} onClick={() => setStatus(k)}>{label}</button>
        ))}
      </div>
      {list?.length === 0 && <Empty title={status === 'pending' ? 'No hay selfies por revisar' : 'No hay selfies aquí'} />}
      {list?.map((s) => (
        <div className="req" key={s.id}>
          <div className="row between">
            <b>{s.driver} <span className="muted">· {s.plate}</span></b>
            <span className="muted small">{when(s.created_at)}</span>
          </div>
          <div className="selfie-pair">
            <figure><Img url={`${API}/api/admin/selfies/${s.id}/file`} alt={`Selfie de ${s.driver}`} /><figcaption>Selfie de hoy</figcaption></figure>
            <figure>{s.photo_id ? <Img url={`${API}/api/admin/documents/${s.photo_id}/file`} alt={`Foto aprobada de ${s.driver}`} /> : <div className="selfie-img muted small">Sin foto</div>}<figcaption>Foto aprobada</figcaption></figure>
          </div>
          {s.status === 'pending' ? (
            <div className="row wrap">
              <button className="primary sm" onClick={() => review(s, 'ok')}>✓ Es la misma persona</button>
              <button className="danger sm" onClick={() => review(s, 'mismatch')}>No coincide: bloquear</button>
            </div>
          ) : (
            <div className={s.status === 'ok' ? 'hint ok' : 'hint danger'}>{s.status === 'ok' ? 'Coincide' : 'No coincide: cuenta bloqueada'}{s.reviewer ? ` · revisó ${s.reviewer}` : ''}</div>
          )}
        </div>
      ))}
    </>
  );
}
