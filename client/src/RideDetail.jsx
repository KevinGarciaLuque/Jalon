import { useEffect, useState } from 'react';
import { MapContainer, TileLayer, Marker } from 'react-leaflet';
import { apiGet, lempiras, icons, TILE_URL, TILE_ATTRIBUTION } from './lib.js';
import { FitTo, Loading, RouteLine } from './components.jsx';

const STATUS = { requested: 'Solicitado', accepted: 'Aceptado', arrived: 'Llegó', started: 'En curso', completed: 'Completado', cancelled: 'Cancelado' };
const CANCELLED_BY = { passenger: 'el pasajero', driver: 'el conductor', admin: 'soporte', system: 'el sistema (nadie lo tomó a tiempo)' };
const when = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' });
const time = (d) => new Date(d).toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit' });
// Colores de las dos líneas del mapa (Leaflet los necesita como valor, no como variable de CSS)
const PLANNED = '#7a8a82';
const REAL = '#0a7d4f';

// Detalle de un viaje: mapa con la ruta planeada y el camino real, horarios, distancias, precio y calificaciones
export default function RideDetail({ rideId, token, onClose, onReceipt, onReport }) {
  const [r, setR] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { apiGet(`rides/${rideId}/detail`, token).then(setR).catch((e) => setError(e.message)); }, [rideId, token]);

  const points = r ? [...(r.route || []), ...(r.track || [])] : [];
  const fit = points.length > 1 ? points : r ? [[r.origin.lat, r.origin.lng], [r.dest.lat, r.dest.lng]] : [];
  return (
    <div className="overlay top">
      <div className="overlay-head">
        <b>Viaje #{rideId}</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        {error && <div className="error">{error}</div>}
        {!r && !error && <Loading />}
        {r && (
          <>
            <div className="detail-map">
              <MapContainer center={fit[0]} zoom={14} style={{ height: '100%' }}>
                <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
                <FitTo points={fit} />
                {r.route?.length > 1 && <RouteLine positions={r.route} color={PLANNED} dashed />}
                {r.track?.length > 1 && <RouteLine positions={r.track} color={REAL} />}
                <Marker position={[r.origin.lat, r.origin.lng]} icon={icons.me} />
                <Marker position={[r.dest.lat, r.dest.lng]} icon={icons.dest} />
              </MapContainer>
            </div>
            <div className="map-legend">
              <span><i className="line dashed" style={{ borderColor: PLANNED }} />Ruta planeada</span>
              {r.track?.length > 1 && <span><i className="line" style={{ borderColor: REAL }} />Camino real</span>}
            </div>

            <div className="req">
              <div className="row between">
                <b>{when(r.createdAt)}</b>
                {r.finalPrice != null ? <span className="tag">{lempiras(r.finalPrice)}</span> : <span className="muted">Ofrecido {lempiras(r.offeredPrice)}</span>}
              </div>
              <div className="row wrap">
                <span className={`pill ride-${r.status}`}>{STATUS[r.status]}</span>
                <span className="muted small">{r.categoryLabel}{r.status === 'cancelled' && r.cancelledBy ? ` · lo canceló ${CANCELLED_BY[r.cancelledBy]}` : ''}</span>
              </div>
              <div className="route-list">
                <div><i className="dot-o" />{r.origin.text || 'Punto de recogida'}</div>
                <div><i className="dot-d" />{r.dest.text || 'Destino en el mapa'}</div>
              </div>
              {r.other && <div className="muted">{r.me === 'passenger' ? 'Conductor' : 'Pasajero'}: <b>{r.other.name}</b>{r.other.vehicle ? ` · ${r.other.vehicle} · ${r.other.plate}` : ''}</div>}
            </div>

            <div className="stats">
              <div><b>{Number(r.plannedKm).toFixed(1)}</b><span>Km planeados</span></div>
              <div><b>{r.realKm != null ? r.realKm.toFixed(1) : '—'}</b><span>Km reales</span></div>
              <div><b>{r.plannedMin ? Math.round(r.plannedMin) : '—'}</b><span>Min estimados</span></div>
              <div><b>{r.realMin ?? '—'}</b><span>Min reales{r.startedAt && r.completedAt ? ` (${time(r.startedAt)} a ${time(r.completedAt)})` : ''}</span></div>
            </div>
            {r.status === 'completed' && r.realKm == null && <p className="muted small">Este viaje no tiene camino guardado (es anterior a esta función o el GPS no envió posiciones).</p>}

            {(r.myRating || r.theirRating) && (
              <div className="req">
                {r.myRating && <div>Tu calificación: <b className="stars">{'★'.repeat(r.myRating.stars)}</b>{r.myRating.comment ? ` · «${r.myRating.comment}»` : ''}</div>}
                {r.theirRating && <div>Te calificaron: <b className="stars">{'★'.repeat(r.theirRating.stars)}</b></div>}
              </div>
            )}
            <div className="row wrap">
              {r.status === 'completed' && <button onClick={() => onReceipt(r.id)}>Ver recibo</button>}
              {['completed', 'cancelled'].includes(r.status) && r.other && <button onClick={() => onReport(r.id)}>Reportar un problema</button>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
