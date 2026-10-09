import { useCallback, useEffect, useState } from 'react';
import { API } from './lib.js';

export const DOC_LABEL = { photo: 'Foto del conductor', license: 'Licencia', registration: 'Matrícula' };

// Revisión de los documentos de un conductor: se ven las imágenes, se puede rechazar una con motivo y aprobar al conductor
export default function DocsModal({ user, call, token, canManage, onClose, onApprove, onChanged }) {
  const [docs, setDocs] = useState(null);
  const [images, setImages] = useState({});
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const list = await call(`users/${user.id}/documents`);
      setDocs(list);
      // Las imágenes exigen sesión de personal, por eso se bajan con fetch y se muestran como blob
      const urls = {};
      for (const d of list) {
        const res = await fetch(`${API}/api/admin/documents/${d.id}/file`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) urls[d.id] = URL.createObjectURL(await res.blob());
      }
      setImages((old) => { Object.values(old).forEach(URL.revokeObjectURL); return urls; });
    } catch (e) {
      setError(e.message);
    }
  }, [call, token, user.id]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => () => Object.values(images).forEach(URL.revokeObjectURL), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function reject(d) {
    const note = window.prompt(`¿Por qué rechazas ${DOC_LABEL[d.type].toLowerCase()}? (el conductor verá este motivo)`, 'Foto borrosa o ilegible');
    if (note === null) return;
    try {
      await call(`documents/${d.id}/reject`, { note });
      await refresh();
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  }

  const byType = Object.fromEntries((docs || []).map((d) => [d.type, d]));
  const ready = (docs || []).filter((d) => d.status === 'uploaded').length === 3;

  return (
    <div className="overlay top">
      <div className="overlay-head">
        <b>Documentos de {user.name} · {user.vehicle} {user.plate}</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body wide">
        {error && <div className="error">{error}</div>}
        {!docs && !error && <div className="pulse">Cargando…</div>}
        <div className="docgrid">
          {Object.entries(DOC_LABEL).map(([type, label]) => {
            const d = byType[type];
            return (
              <div className="req" key={type}>
                <b>{label}</b>
                {!d && <div className="muted">No lo ha subido</div>}
                {d && images[d.id] && (
                  <a href={images[d.id]} target="_blank" rel="noreferrer"><img className="docimg" src={images[d.id]} alt={label} /></a>
                )}
                {d?.status === 'rejected' && <div className="error">Rechazado: {d.note}</div>}
                {d?.status === 'uploaded' && canManage && <button className="danger sm" onClick={() => reject(d)}>Rechazar</button>}
              </div>
            );
          })}
        </div>
        {canManage && user.status === 'pending' && (
          <button className="primary" disabled={!ready} onClick={onApprove}>
            {ready ? 'Aprobar conductor' : 'Faltan documentos para aprobar'}
          </button>
        )}
      </div>
    </div>
  );
}
