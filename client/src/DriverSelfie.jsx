import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { API, authFetch, toJpeg } from './lib.js';

// Selfie para conectarse: confirma que quien maneja es la persona aprobada (el equipo la compara con su foto).
// `capture="user"` abre la cámara frontal en el celular.
export default function DriverSelfie({ onDone, onClose }) {
  const [file, setFile] = useState(null);
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  async function send() {
    setBusy(true);
    setError('');
    try {
      const image = await toJpeg(file);
      const res = await authFetch(`${API}/api/driver/selfie`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ image }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'No se pudo enviar la selfie');
      onDone();
    } catch (e) {
      setError(e.name === 'InvalidStateError' ? 'No se pudo leer esa foto. Toma otra.' : e.message);
    } finally {
      setBusy(false);
    }
  }

  // Fuera de la hoja de abajo (portal): si no, la hoja la tapa
  return createPortal(
    <div className="offer-pop" role="dialog" aria-modal="true" aria-labelledby="selfie-title">
      <div className="card selfie-card">
        <b id="selfie-title">📸 Tómate una selfie para conectarte</b>
        <p className="muted small">Así confirmamos que eres tú quien maneja. Mira de frente a la cámara, con buena luz y sin lentes oscuros ni gorra. El equipo la compara con tu foto y se borra a los 30 días.</p>
        {preview && <img className="selfie-preview" src={preview} alt="Tu selfie" />}
        <label className={`upload selfie-take ${busy ? 'disabled' : ''}`}>
          {file ? '🔄 Tomar otra' : '📷 Abrir la cámara'}
          <input type="file" accept="image/*" capture="user" disabled={busy} onChange={(e) => setFile(e.target.files[0] || null)} />
        </label>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={!file || busy} onClick={send}>{busy ? 'Enviando…' : 'Enviar y ponerme disponible'}</button>
        <button className="link" disabled={busy} onClick={onClose}>Ahora no</button>
      </div>
    </div>,
    document.body
  );
}
