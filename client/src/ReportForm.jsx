import { useState } from 'react';
import { apiPost } from './lib.js';

export const REPORT_TYPES = [
  ['lost_item', '📦 Dejé un objeto en el carro'],
  ['overcharge', '💸 Me cobraron de más'],
  ['behavior', '🗣 Trato o conducta'],
  ['safety', '🛡 No me sentí seguro/a'],
  ['other', 'Otro problema'],
];
export const REPORT_LABEL = Object.fromEntries(REPORT_TYPES);

// Cuéntale al equipo de Jalón qué pasó en un viaje
export default function ReportForm({ rideId, token, defaultType = 'other', onClose }) {
  const [type, setType] = useState(defaultType);
  const [text, setText] = useState('');
  const [state, setState] = useState('idle'); // idle | sending | done
  const [error, setError] = useState('');

  async function send(e) {
    e.preventDefault();
    setState('sending');
    setError('');
    try {
      await apiPost(`rides/${rideId}/report`, token, { type, text });
      setState('done');
    } catch (err) {
      setError(err.message);
      setState('idle');
    }
  }

  return (
    <div className="overlay top">
      <div className="overlay-head">
        <b>Reportar un problema</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        {state === 'done' ? (
          <>
            <div className="hint ok">Recibimos tu reporte. El equipo lo revisará y verás la respuesta en tu historial (y por notificación si las tienes activas).</div>
            <button className="primary" onClick={onClose}>Listo</button>
          </>
        ) : (
          <form className="req" onSubmit={send}>
            <div className="hint danger">Si estás en peligro ahora mismo, llama al <a href="tel:911"><b>911</b></a>. Este formulario no es una emergencia.</div>
            <select value={type} onChange={(e) => setType(e.target.value)} aria-label="Tipo de problema">
              {REPORT_TYPES.map(([k, label]) => <option key={k} value={k}>{label}</option>)}
            </select>
            <textarea
              placeholder="Cuéntanos qué pasó (viaje, hora, lo que pasó…)"
              rows={5}
              maxLength={1000}
              value={text}
              onChange={(e) => setText(e.target.value)}
              required
            />
            <div className="muted small">{text.length}/1000</div>
            {error && <div className="error">{error}</div>}
            <button className="primary" disabled={state === 'sending' || text.trim().length < 5}>{state === 'sending' ? 'Enviando…' : 'Enviar reporte'}</button>
          </form>
        )}
      </div>
    </div>
  );
}
