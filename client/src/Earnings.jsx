import { useEffect, useState } from 'react';
import { apiGet, lempiras } from './lib.js';
import { Loading } from './components.jsx';

const PERIODS = [['day', 'Hoy'], ['week', 'Semana'], ['month', 'Mes']];
const WEEKDAY = ['Lu', 'Ma', 'Mi', 'Ju', 'Vi', 'Sá', 'Do'];
const longDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('es-HN', { weekday: 'short', day: 'numeric', month: 'short' });
const hourText = (h) => `${String(h).padStart(2, '0')}:00`;

// Gráfico de barras de una sola serie: lo cobrado por hora (hoy) o por día (semana y mes).
// Al pasar el dedo o el mouse por una barra (o al llegar con el teclado) se muestra su valor arriba.
function Bars({ data }) {
  const [hover, setHover] = useState(null);
  const series = data.series;
  const max = Math.max(...series.map((s) => s.gross), 1);
  const label = (s, i) => (data.period === 'day' ? hourText(s.key) : data.period === 'week' ? WEEKDAY[i] : String(Number(s.key.slice(8))));
  const showTick = (i) => (data.period === 'day' ? i % 6 === 0 : data.period === 'week' ? true : i === 0 || (i + 1) % 5 === 0);
  const name = (s) => (data.period === 'day' ? `${hourText(s.key)} a ${hourText((Number(s.key) + 1) % 24)}` : longDate(s.key));
  const h = hover == null ? null : series[hover];
  return (
    <figure className="bars">
      <figcaption className="bars-head">
        <b>Cobrado {data.period === 'day' ? 'por hora' : 'por día'}</b>
        <span className="muted small" aria-live="polite">{h ? `${name(h)}: ${lempiras(h.gross)} · ${h.rides} viaje${h.rides === 1 ? '' : 's'}` : 'Toca una barra para ver el detalle'}</span>
      </figcaption>
      <div className="bars-plot" onMouseLeave={() => setHover(null)}>
        {series.map((s, i) => (
          <div
            key={s.key}
            className={`bar${hover === i ? ' on' : ''}${s.key === data.today ? ' today' : ''}`}
            role="img"
            tabIndex={0}
            aria-label={`${name(s)}: ${lempiras(s.gross)}, ${s.rides} viaje${s.rides === 1 ? '' : 's'}`}
            onMouseEnter={() => setHover(i)}
            onFocus={() => setHover(i)}
            onClick={() => setHover(i)}
          >
            <i style={{ height: s.gross ? `${Math.max(4, (s.gross / max) * 100)}%` : 0 }} />
          </div>
        ))}
      </div>
      <div className="bars-axis" aria-hidden="true">
        {series.map((s, i) => <span key={s.key}>{showTick(i) ? label(s, i) : ''}</span>)}
      </div>
      <details className="bars-table">
        <summary>Ver como tabla</summary>
        <table>
          <thead><tr><th>{data.period === 'day' ? 'Hora' : 'Día'}</th><th>Viajes</th><th>Cobrado</th></tr></thead>
          <tbody>{series.filter((s) => s.rides).map((s) => <tr key={s.key}><td>{name(s)}</td><td className="num">{s.rides}</td><td className="num">{lempiras(s.gross)}</td></tr>)}</tbody>
        </table>
        {!series.some((s) => s.rides) && <p className="muted small">Sin viajes en este período.</p>}
      </details>
    </figure>
  );
}

// Conductor: cuánto ganó hoy, esta semana o este mes, con sus horas conectado
export default function Earnings({ token, onClose }) {
  const [period, setPeriod] = useState('day');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => {
    setData(null);
    apiGet(`driver/earnings?period=${period}`, token).then(setData).catch((e) => setError(e.message));
  }, [period, token]);

  const range = data && (data.period === 'day' ? longDate(data.from) : `${longDate(data.from)} al ${longDate(data.to)}`);
  return (
    <div className="overlay">
      <div className="overlay-head">
        <b>Mis ganancias</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        <div className="seg" role="radiogroup" aria-label="Período">
          {PERIODS.map(([k, l]) => <button key={k} role="radio" aria-checked={period === k} className={period === k ? 'on' : ''} onClick={() => setPeriod(k)}>{l}</button>)}
        </div>
        {error && <div className="error">{error}</div>}
        {!data && !error && <Loading />}
        {data && (
          <>
            <div className="earn-hero">
              <span className="muted">Te quedaron · {range}</span>
              <b className="num">{lempiras(data.net)}</b>
              <span className="muted small">
                Cobrado {lempiras(data.gross + data.rentals.gross)}{data.commission + data.rentals.commission > 0 ? ` − comisión de Jalón ${lempiras(data.commission + data.rentals.commission)}` : ''}
              </span>
            </div>
            <div className="stats">
              <div><b>{data.rides}</b><span>Viajes</span></div>
              <div><b>{data.km}</b><span>Km en viajes</span></div>
              <div><b>{data.rides ? lempiras(data.avgPerRide) : '—'}</b><span>Promedio por viaje</span></div>
              <div><b>{data.hours}</b><span>Horas conectado</span></div>
              <div><b>{data.perHour == null ? '—' : lempiras(data.perHour)}</b><span>Por hora conectado</span></div>
              {data.rentals.count > 0 && <div><b>{lempiras(data.rentals.gross)}</b><span>Alquileres ({data.rentals.count})</span></div>}
            </div>
            <Bars data={data} />
            <p className="muted small">Las horas cuentan mientras tienes la app abierta y estás disponible o en un viaje. Lo cobrado es lo que acordaste con cada pasajero.</p>
          </>
        )}
      </div>
    </div>
  );
}
