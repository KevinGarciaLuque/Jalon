import { useEffect, useRef } from 'react';
import { lempiras } from './lib.js';

// El pasajero le dejó propina al conductor: tarjeta de celebración al centro, con el monto grande y cuánto cobrar en total.
// Se cierra con «¡Gracias!» o sola a los 6 segundos (puede ir manejando). El sonido lo pone quien la abre.
export default function TipCelebration({ tip, onClose }) {
  const btn = useRef(null);
  useEffect(() => {
    btn.current?.focus();
    const t = setTimeout(onClose, 6000);
    const onKey = (e) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    return () => { clearTimeout(t); document.removeEventListener('keydown', onKey); };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="tip-cele-wrap" onClick={onClose}>
      <div className="tip-cele" role="alertdialog" aria-modal="true" aria-labelledby="tip-cele-title" aria-describedby="tip-cele-desc" onClick={(e) => e.stopPropagation()}>
        <div className="tip-sparks" aria-hidden="true">{Array.from({ length: 10 }, (_, i) => <i key={i} style={{ '--a': `${i * 36}deg` }} />)}</div>
        <span className="tip-cele-heart" aria-hidden="true">💚</span>
        <h2 id="tip-cele-title">¡Te dejaron propina!</h2>
        <b className="tip-cele-amt">{lempiras(tip.amount)}</b>
        <p id="tip-cele-desc" className="muted">
          {tip.passenger ? <><b>{tip.passenger}</b> te la dejó. </> : null}Cobra <b>{lempiras(tip.toCollect)}</b> en efectivo (ya incluye la propina). Es toda tuya.
        </p>
        <button ref={btn} className="primary" onClick={onClose}>¡Gracias!</button>
        <span className="tip-cele-timer" aria-hidden="true" />
      </div>
    </div>
  );
}
