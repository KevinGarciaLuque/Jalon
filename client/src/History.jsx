import { useEffect, useState } from 'react';
import { apiGet, lempiras } from './lib.js';
import { Empty, Loading, Stars } from './components.jsx';
import Receipt from './Receipt.jsx';
import ReportForm, { REPORT_LABEL } from './ReportForm.jsx';

const STATUS = {
  requested: 'Solicitado', accepted: 'Aceptado', arrived: 'Llegó', started: 'En curso',
  completed: 'Completado', cancelled: 'Cancelado',
};

const dateText = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' });

export default function History({ token, role, onClose }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [receipt, setReceipt] = useState(null);
  const [report, setReport] = useState(null);
  const [reports, setReports] = useState([]);

  useEffect(() => {
    apiGet('rides/mine', token).then(setData).catch((e) => setError(e.message));
    apiGet('reports/mine', token).then(setReports).catch(() => {});
  }, [token, report]);

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
        {!data && !error && <Loading />}
        {data && (
          <>
            <div className="stats">
              <div><b>{data.rides.filter((r) => r.status === 'completed').length}</b><span>Viajes completados</span></div>
              <div><b>{lempiras(total)}</b><span>{role === 'driver' ? 'Ganado' : 'Gastado'}</span></div>
              <div><b><Stars rating={data.rating} /></b><span>Mi calificación</span></div>
            </div>
            {data.rides.length === 0 && <Empty title="Todavía no tienes viajes">Cuando hagas tu primer viaje aparecerá aquí con su recibo.</Empty>}
            {data.rides.map((r) => (
              <div className="req" key={r.id}>
                <div className="row between">
                  <b>{dateText(r.created_at)}</b>
                  <span className="tag">{lempiras(r.final_price ?? r.offered_price)}</span>
                </div>
                <div className="route-list muted">
                  <div><i className="dot-o" />{r.origin_text || 'Mi ubicación'}</div>
                  <div><i className="dot-d" />{r.dest_text || 'Destino en el mapa'}</div>
                </div>
                <div className="row wrap">
                  <span className={`pill ride-${r.status}`}>{STATUS[r.status]}</span>
                  <span className="muted small">{r.distance_km.toFixed(1)} km</span>
                </div>
                {r.other_name && <div className="muted">{other}: {r.other_name}</div>}
                {r.status === 'completed' && (
                  <div className="muted">
                    Tu calificación: {r.my_stars ? '★'.repeat(r.my_stars) : 'sin calificar'}
                    {r.their_stars ? ` · Te calificaron: ${'★'.repeat(r.their_stars)}` : ''}
                  </div>
                )}
                {['completed', 'cancelled'].includes(r.status) && r.other_name && (
                  <div className="row wrap">
                    {r.status === 'completed' && <button className="sm" onClick={() => setReceipt(r.id)}>Ver recibo</button>}
                    <button className="sm" onClick={() => setReport(r.id)}>Reportar un problema</button>
                  </div>
                )}
              </div>
            ))}
            {reports.length > 0 && (
              <>
                <b>Mis reportes</b>
                {reports.map((x) => (
                  <div className="req" key={x.id}>
                    <div className="row between"><b>{REPORT_LABEL[x.type]}</b><span className={`pill ${x.status === 'open' ? 'pending' : 'active'}`}>{x.status === 'open' ? 'En revisión' : 'Atendido'}</span></div>
                    <div className="muted small">Viaje #{x.ride_id} · {dateText(x.created_at)}</div>
                    <div>{x.text}</div>
                    {x.resolution && <div className="hint ok">Respuesta: {x.resolution}</div>}
                  </div>
                ))}
              </>
            )}
          </>
        )}
      </div>
      {receipt && <Receipt rideId={receipt} token={token} onClose={() => setReceipt(null)} />}
      {report && <ReportForm rideId={report} token={token} onClose={() => setReport(null)} />}
    </div>
  );
}
