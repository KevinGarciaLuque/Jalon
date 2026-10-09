import { useEffect, useState } from 'react';
import { apiGet, lempiras } from './lib.js';
import { Stars } from './components.jsx';

const STATUS = {
  requested: 'Solicitado', accepted: 'Aceptado', arrived: 'Llegó', started: 'En curso',
  completed: 'Completado', cancelled: 'Cancelado',
};

const dateText = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' });

export default function History({ token, role, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    apiGet('rides/mine', token).then(setData).catch((e) => setError(e.message));
  }, [token]);

  const other = role === 'driver' ? 'Pasajero' : 'Conductor';
  const total = data?.rides.filter((r) => r.status === 'completed').reduce((sum, r) => sum + Number(r.final_price || 0), 0) || 0;

  return (
    <div className="overlay">
      <div className="overlay-head">
        <b>Mis viajes</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        {error && <div className="error">{error}</div>}
        {!data && !error && <div className="pulse">Cargando…</div>}
        {data && (
          <>
            <div className="stats">
              <div><b>{data.rides.filter((r) => r.status === 'completed').length}</b><span>Viajes completados</span></div>
              <div><b>{lempiras(total)}</b><span>{role === 'driver' ? 'Ganado' : 'Gastado'}</span></div>
              <div><b><Stars rating={data.rating} /></b><span>Mi calificación</span></div>
            </div>
            {data.rides.length === 0 && <p className="muted">Todavía no tienes viajes.</p>}
            {data.rides.map((r) => (
              <div className="req" key={r.id}>
                <div className="row between">
                  <b>{r.dest_text || 'Destino en el mapa'}</b>
                  <span className="tag">{lempiras(r.final_price ?? r.offered_price)}</span>
                </div>
                <div className="muted">Desde {r.origin_text || 'Mi ubicación'}</div>
                <div className="muted">
                  {dateText(r.created_at)} · {r.distance_km.toFixed(1)} km · {STATUS[r.status]}
                </div>
                {r.other_name && <div className="muted">{other}: {r.other_name}</div>}
                {r.status === 'completed' && (
                  <div className="muted">
                    Tu calificación: {r.my_stars ? '★'.repeat(r.my_stars) : 'sin calificar'}
                    {r.their_stars ? ` · Te calificaron: ${'★'.repeat(r.their_stars)}` : ''}
                  </div>
                )}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}
