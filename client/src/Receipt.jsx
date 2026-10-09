import { useEffect, useState } from 'react';
import { apiGet, lempiras } from './lib.js';

const when = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'long', timeStyle: 'short' });

// Comprobante del viaje, listo para imprimir o guardar como PDF desde el navegador
export default function Receipt({ rideId, token, onClose }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { apiGet(`rides/${rideId}/receipt`, token).then(setR).catch((e) => setError(e.message)); }, [rideId, token]);

  return (
    <div className="overlay top">
      <div className="overlay-head no-print">
        <b>Recibo del viaje</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        {error && <div className="error">{error}</div>}
        {!r && !error && <div className="pulse">Cargando…</div>}
        {r && (
          <>
            <div className="receipt" data-testid="receipt">
              <h2>Jalón</h2>
              <p className="muted center">Comprobante de viaje · {r.number}</p>
              <dl>
                <dt>Fecha</dt><dd>{when(r.date)}</dd>
                <dt>Pasajero</dt><dd>{r.passenger}</dd>
                <dt>Conductor</dt><dd>{r.driver}</dd>
                <dt>Vehículo</dt><dd>{r.vehicle} · placa {r.plate}</dd>
                <dt>Desde</dt><dd>{r.origin || 'Ubicación del pasajero'}</dd>
                <dt>Hasta</dt><dd>{r.dest || 'Destino en el mapa'}</dd>
                <dt>Recorrido</dt><dd>{Number(r.distanceKm).toFixed(1)} km{r.durationMin ? ` · ${Math.round(r.durationMin)} min estimados` : ''}</dd>
                <dt>Forma de pago</dt><dd>{r.payment}</dd>
              </dl>
              <div className="total"><span>Total</span><b>{lempiras(r.price)}</b></div>
              <p className="muted small center">Este comprobante no es una factura fiscal.</p>
            </div>
            <button className="primary no-print" onClick={() => window.print()}>🖨 Imprimir o guardar como PDF</button>
          </>
        )}
      </div>
    </div>
  );
}
