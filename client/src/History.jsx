import { useCallback, useEffect, useState } from 'react';
import { apiGet, lempiras, CATEGORY_LABEL } from './lib.js';
import { Empty, Loading, Stars } from './components.jsx';
import Receipt from './Receipt.jsx';
import ReportForm, { REPORT_LABEL } from './ReportForm.jsx';
import RideDetail from './RideDetail.jsx';

const STATUS = {
  requested: 'Solicitado', accepted: 'Aceptado', arrived: 'Llegó', started: 'En curso',
  completed: 'Completado', cancelled: 'Cancelado',
};
const FILTERS = [['all', 'Todos'], ['completed', 'Completados'], ['cancelled', 'Cancelados']];

const dateText = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' });

export default function History({ token, role, onClose }) {
  const [filter, setFilter] = useState('all');
  const [data, setData] = useState(null); // { rides, hasMore, month, rating }
  const [more, setMore] = useState(false);
  const [error, setError] = useState('');
  const [detail, setDetail] = useState(null);
  const [receipt, setReceipt] = useState(null);
  const [report, setReport] = useState(null);
  const [reports, setReports] = useState([]);

  const load = useCallback(() => {
    setData(null);
    apiGet(`rides/mine?status=${filter}`, token).then(setData).catch((e) => setError(e.message));
  }, [filter, token]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { apiGet('reports/mine', token).then(setReports).catch(() => {}); }, [token, report]);

  // «Ver más»: los 20 anteriores al último que se ve
  async function loadMore() {
    setMore(true);
    try {
      const last = data.rides[data.rides.length - 1].id;
      const next = await apiGet(`rides/mine?status=${filter}&before=${last}`, token);
      setData({ ...data, rides: [...data.rides, ...next.rides], hasMore: next.hasMore });
    } catch (e) {
      setError(e.message);
    } finally {
      setMore(false);
    }
  }

  const other = role === 'driver' ? 'Pasajero' : 'Conductor';
  return (
    <div className="overlay">
      <div className="overlay-head">
        <b>Mis viajes</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        {error && <div className="error">{error}</div>}
        {data && (
          <div className="stats">
            <div><b>{data.month.rides}</b><span>Viajes este mes</span></div>
            <div><b>{lempiras(data.month.total)}</b><span>{role === 'driver' ? 'Cobrado este mes' : 'Gastado este mes'}</span></div>
            <div><b><Stars rating={data.rating} /></b><span>Mi calificación</span></div>
          </div>
        )}
        <div className="chips">
          {FILTERS.map(([k, l]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{l}</button>)}
        </div>
        {!data && !error && <Loading />}
        {data && data.rides.length === 0 && (
          filter === 'all'
            ? <Empty title="Todavía no tienes viajes">Cuando hagas tu primer viaje aparecerá aquí con su recibo.</Empty>
            : <Empty title={`No tienes viajes ${filter === 'completed' ? 'completados' : 'cancelados'}`} />
        )}
        {data?.rides.map((r) => (
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
              <span className="muted small">{CATEGORY_LABEL[r.category || 'car']} · {r.distance_km.toFixed(1)} km</span>
            </div>
            {r.other_name && <div className="muted">{other}: {r.other_name}</div>}
            {r.status === 'completed' && (
              <div className="muted">
                Tu calificación: {r.my_stars ? '★'.repeat(r.my_stars) : 'sin calificar'}
                {r.their_stars ? ` · Te calificaron: ${'★'.repeat(r.their_stars)}` : ''}
              </div>
            )}
            <div className="row wrap">
              <button className="sm" onClick={() => setDetail(r.id)}>Ver detalle</button>
              {r.status === 'completed' && <button className="sm" onClick={() => setReceipt(r.id)}>Ver recibo</button>}
            </div>
          </div>
        ))}
        {data?.hasMore && <button disabled={more} onClick={loadMore}>{more ? 'Cargando…' : 'Ver más viajes'}</button>}
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
      </div>
      {detail && <RideDetail rideId={detail} token={token} onClose={() => setDetail(null)} onReceipt={(id) => setReceipt(id)} onReport={(id) => setReport(id)} />}
      {receipt && <Receipt rideId={receipt} token={token} onClose={() => setReceipt(null)} />}
      {report && <ReportForm rideId={report} token={token} onClose={() => setReport(null)} />}
    </div>
  );
}
