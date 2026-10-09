import { useCallback, useEffect, useRef, useState } from 'react';
import { apiGet, API } from './lib.js';

const DOCS = [
  { type: 'photo', label: 'Tu foto (rostro visible)' },
  { type: 'license', label: 'Licencia de conducir' },
  { type: 'registration', label: 'Matrícula del vehículo' },
];

// Reduce la foto del celular (varios MB) a un JPEG de máx. 1280 px antes de subirla
async function toJpeg(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}

export default function DriverDocs({ token, socket }) {
  const [docs, setDocs] = useState(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const inputs = useRef({});

  const load = useCallback(() => apiGet('driver/documents', token).then(setDocs).catch((e) => setError(e.message)), [token]);

  useEffect(() => {
    load();
    socket.on('docs:changed', load); // el admin rechazó o revisó un documento
    return () => socket.off('docs:changed', load);
  }, [load, socket]);

  async function upload(type, file) {
    if (!file) return;
    setError('');
    setBusy(type);
    try {
      const image = await toJpeg(file);
      const res = await fetch(`${API}/api/driver/documents/${type}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ image }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo subir la foto');
      await load();
    } catch (e) {
      setError(e.name === 'InvalidStateError' ? 'No se pudo leer esa imagen. Prueba con otra foto.' : e.message);
    } finally {
      setBusy('');
      if (inputs.current[type]) inputs.current[type].value = '';
    }
  }

  if (!docs) return null;
  const byType = Object.fromEntries(docs.map((d) => [d.type, d]));
  const done = docs.filter((d) => d.status === 'uploaded').length;

  return (
    <div className="docs">
      <b>Documentos para aprobar tu cuenta ({done} de 3)</b>
      {DOCS.map(({ type, label }) => {
        const d = byType[type];
        return (
          <div className="doc" key={type}>
            <div>
              <div>{label}</div>
              {!d && <div className="muted small">Falta subirlo</div>}
              {d?.status === 'uploaded' && <div className="ok small">✓ Recibido, en revisión</div>}
              {d?.status === 'rejected' && <div className="error small">Rechazado{d.note ? `: ${d.note}` : ''}. Súbelo de nuevo.</div>}
            </div>
            <label className={`sm upload ${busy ? 'disabled' : ''}`}>
              {busy === type ? 'Subiendo…' : d ? 'Cambiar' : 'Subir foto'}
              <input
                ref={(el) => (inputs.current[type] = el)}
                type="file"
                accept="image/*"
                capture={type === 'photo' ? 'user' : 'environment'}
                disabled={!!busy}
                onChange={(e) => upload(type, e.target.files[0])}
              />
            </label>
          </div>
        );
      })}
      {error && <div className="error">{error}</div>}
      {done === 3 && <div className="hint ok">Listo: un administrador revisará tus documentos y te aprobará.</div>}
    </div>
  );
}
