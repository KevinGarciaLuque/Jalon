import { useCallback, useEffect, useState } from 'react';
import { API, authFetch, lempiras, todayHN } from './lib.js';
import { Loading } from './components.jsx';

const PRESETS = [['today', 'Hoy'], ['7d', '7 días'], ['30d', '30 días'], ['month', 'Este mes'], ['prev_month', 'Mes pasado'], ['custom', 'Fechas']];
const EXPORTS = [['rides', 'Viajes'], ['ledger', 'Movimientos de saldo'], ['topups', 'Recargas'], ['rentals', 'Alquileres'], ['users', 'Usuarios nuevos']];
const WHO = { passenger: 'Pasajero', driver: 'Conductor', admin: 'Personal', system: 'Sistema (nadie lo tomó)' };
const shortDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('es-HN', { day: 'numeric', month: 'short' });
const longDate = (d) => new Date(`${d}T12:00:00`).toLocaleDateString('es-HN', { weekday: 'short', day: 'numeric', month: 'short' });
const minSec = (s) => (s == null ? '—' : s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${s % 60} s`);

// Cambio frente al período anterior: flecha y porcentaje. `goodUp` dice si subir es bueno (más viajes) o malo (más cancelaciones).
function Delta({ now, before, goodUp = true, points = false }) {
  if (now == null || before == null) return null;
  if (points) {
    const d = now - before;
    if (!d) return <span className="delta">igual que antes</span>;
    return <span className={`delta ${d > 0 === goodUp ? 'up' : 'down'}`}>{d > 0 ? '▲' : '▼'} {Math.abs(d)} pts</span>;
  }
  if (!before) return now ? <span className="delta">nuevo</span> : <span className="delta">igual que antes</span>;
  const pct = Math.round(((now - before) / before) * 100);
  if (!pct) return <span className="delta">igual que antes</span>;
  return <span className={`delta ${pct > 0 === goodUp ? 'up' : 'down'}`}>{pct > 0 ? '▲' : '▼'} {Math.abs(pct)}%</span>;
}

// Barras de una sola serie (como en Mis ganancias). Al pasar o tocar una barra se ve su valor.
function Bars({ title, items, tick }) {
  const [hover, setHover] = useState(null);
  const max = Math.max(...items.map((i) => i.value), 1);
  const h = hover == null ? null : items[hover];
  return (
    <figure className="bars">
      <figcaption className="bars-head">
        <b>{title}</b>
        <span className="muted small" aria-live="polite">{h ? h.text : 'Toca una barra para ver el detalle'}</span>
      </figcaption>
      <div className="bars-plot" onMouseLeave={() => setHover(null)}>
        {items.map((it, i) => (
          <div key={it.key} className={`bar${hover === i ? ' on' : ''}`} role="img" tabIndex={0} aria-label={it.text}
            onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} onClick={() => setHover(i)}>
            <i style={{ height: it.value ? `${Math.max(4, (it.value / max) * 100)}%` : 0 }} />
          </div>
        ))}
      </div>
      <div className="bars-axis" aria-hidden="true">{items.map((it, i) => <span key={it.key}>{tick(i) ? it.label : ''}</span>)}</div>
    </figure>
  );
}

// Panel: indicadores del negocio y reporte de dinero del período, y exportar a CSV
export default function Metrics({ call, can, onError }) {
  const today = todayHN();
  const [view, setView] = useState('metrics'); // metrics | money
  const [preset, setPreset] = useState('7d');
  const [custom, setCustom] = useState({ from: today, to: today });
  const [m, setM] = useState(null);
  const [fin, setFin] = useState(null);
  const [busy, setBusy] = useState(false);

  const query = preset === 'custom' ? `from=${custom.from}&to=${custom.to}` : `preset=${preset}`;
  const load = useCallback(async () => {
    try {
      if (view === 'metrics') { setM(null); setM(await call(`metrics?${query}`)); } else { setFin(null); setFin(await call(`finance?${query}`)); }
    } catch (e) {
      onError(e.message);
    }
  }, [call, query, view, onError]);
  useEffect(() => { if (preset !== 'custom') load(); }, [load, preset]);

  // El archivo se baja con la sesión del personal (queda anotado en el Registro)
  async function download(kind) {
    setBusy(true);
    try {
      const res = await authFetch(`${API}/api/admin/export/${kind}?${query}`);
      if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'No se pudo exportar');
      const name = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') || '')?.[1] || `jalon-${kind}.csv`;
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  const data = view === 'metrics' ? m : fin;
  const range = data?.range;
  const rangeText = range && (range.from === range.to ? longDate(range.from) : `${longDate(range.from)} al ${longDate(range.to)}`);
  const dayTick = (n) => (i) => n <= 10 || i === 0 || i === n - 1 || i % Math.ceil(n / 6) === 0;

  return (
    <>
      <div className="seg" role="radiogroup" aria-label="Qué ver">
        <button role="radio" aria-checked={view === 'metrics'} className={view === 'metrics' ? 'on' : ''} onClick={() => setView('metrics')}>Indicadores</button>
        <button role="radio" aria-checked={view === 'money'} className={view === 'money' ? 'on' : ''} onClick={() => setView('money')}>Dinero</button>
      </div>
      <div className="chips" role="radiogroup" aria-label="Período">
        {PRESETS.map(([k, l]) => <button key={k} role="radio" aria-checked={preset === k} className={preset === k ? 'on' : ''} onClick={() => setPreset(k)}>{l}</button>)}
      </div>
      {preset === 'custom' && (
        <div className="req">
          <div className="row">
            <label className="grow">Desde<input type="date" max={today} value={custom.from} onChange={(e) => setCustom({ ...custom, from: e.target.value })} /></label>
            <label className="grow">Hasta<input type="date" max={today} value={custom.to} onChange={(e) => setCustom({ ...custom, to: e.target.value })} /></label>
          </div>
          <button className="primary" onClick={load}>Ver</button>
        </div>
      )}
      {!data && preset !== 'custom' && <Loading />}
      {range && <p className="muted small">{rangeText} · comparado con los {range.days} día{range.days > 1 ? 's' : ''} anteriores. Hora de Honduras.</p>}

      {view === 'metrics' && m && (
        <>
          <div className="stats kpis">
            <div><b>{m.kpis.completed}</b><span>Viajes completados</span><Delta now={m.kpis.completed} before={m.previous.completed} /></div>
            <div><b>{lempiras(m.kpis.gmv)}</b><span>Movido en viajes</span><Delta now={m.kpis.gmv} before={m.previous.gmv} /></div>
            <div><b>{lempiras(m.kpis.commission)}</b><span>Comisión de Jalón</span><Delta now={m.kpis.commission} before={m.previous.commission} /></div>
            <div><b>{m.kpis.cancelRate == null ? '—' : `${m.kpis.cancelRate}%`}</b><span>Cancelados ({m.kpis.cancelled})</span><Delta now={m.kpis.cancelRate} before={m.previous.cancelRate} goodUp={false} points /></div>
            <div><b>{m.kpis.requested}</b><span>Solicitudes</span><Delta now={m.kpis.requested} before={m.previous.requested} /></div>
            <div><b>{minSec(m.kpis.firstOfferSeconds)}</b><span>Hasta la primera oferta</span><Delta now={m.kpis.firstOfferSeconds} before={m.previous.firstOfferSeconds} goodUp={false} /></div>
            <div><b>{m.kpis.activeDrivers}</b><span>Conductores con viajes</span><Delta now={m.kpis.activeDrivers} before={m.previous.activeDrivers} /></div>
            <div><b>{m.kpis.newPassengers}</b><span>Pasajeros nuevos</span><Delta now={m.kpis.newPassengers} before={m.previous.newPassengers} /></div>
            <div><b>{m.kpis.approvedDrivers}</b><span>Conductores aprobados</span><Delta now={m.kpis.approvedDrivers} before={m.previous.approvedDrivers} /></div>
          </div>
          <Bars title="Viajes completados por día" tick={dayTick(m.daily.length)}
            items={m.daily.map((d) => ({ key: d.date, label: shortDate(d.date), value: d.completed, text: `${longDate(d.date)}: ${d.completed} completados, ${d.cancelled} cancelados, ${lempiras(d.gmv)}` }))} />
          <Bars title="Horas pico (solicitudes por hora)" tick={(i) => i % 6 === 0}
            items={m.hours.map((h) => ({ key: String(h.hour), label: `${h.hour}h`, value: h.requested, text: `${h.hour}:00 a ${h.hour + 1}:00: ${h.requested} solicitudes` }))} />
          {m.kpis.cancelled > 0 && (
            <div className="req">
              <b>Quién canceló</b>
              {Object.entries(m.cancelledBy).sort((a, b) => b[1] - a[1]).map(([who, n]) => (
                <div className="row between" key={who}><span>{WHO[who] || who}</span><b className="num">{n} ({Math.round((n / m.kpis.cancelled) * 100)}%)</b></div>
              ))}
            </div>
          )}
        </>
      )}

      {view === 'money' && fin && (
        <>
          <div className="stats">
            <div><b>{lempiras(fin.totals.commission + fin.totals.rentalCommission)}</b><span>Comisiones cobradas</span></div>
            <div><b>{lempiras(fin.totals.topups)}</b><span>Recargas aprobadas</span></div>
            <div><b>{lempiras(fin.totals.rentalsCash + fin.totals.rentalsTransfer)}</b><span>Alquileres de conductores</span></div>
            <div><b>{lempiras(fin.totals.fleetRentals)}</b><span>Alquileres de la flota</span></div>
            <div><b>{lempiras(fin.totals.rentalPayouts)}</b><span>Acreditado a conductores por alquileres</span></div>
            <div><b>{lempiras(fin.driversBalance.total)}</b><span>Saldo actual de {fin.driversBalance.drivers} conductores</span></div>
          </div>
          <p className="muted small">Las recargas son transferencias a la cuenta de Jalón: compáralas con el estado de cuenta del banco. Bonos y ajustes: {lempiras(fin.totals.bonuses)} y {lempiras(fin.totals.adjustments)}.</p>
          <div className="tablewrap">
            <table>
              <thead><tr><th>Día</th><th>Comisión viajes</th><th>Comisión alquileres</th><th>Recargas</th><th>Alquileres (efectivo)</th><th>Alquileres (transferencia)</th><th>Flota</th><th>Acreditado</th><th>Ajustes</th></tr></thead>
              <tbody>
                {fin.days.filter((d) => Object.entries(d).some(([k, v]) => k !== 'date' && v)).map((d) => (
                  <tr key={d.date}>
                    <td>{longDate(d.date)}</td>
                    {['commission', 'rentalCommission', 'topups', 'rentalsCash', 'rentalsTransfer', 'fleetRentals', 'rentalPayouts', 'adjustments'].map((k) => <td key={k} className="num">{d[k] ? lempiras(d[k]) : '—'}</td>)}
                  </tr>
                ))}
              </tbody>
            </table>
            {!fin.days.some((d) => Object.entries(d).some(([k, v]) => k !== 'date' && v)) && <p className="muted pad">Sin movimientos de dinero en este período.</p>}
          </div>
        </>
      )}

      {can('export') && range && (
        <div className="req">
          <b>Exportar a Excel (CSV) · {rangeText}</b>
          <p className="muted small">Llevan datos personales: cada descarga queda anotada en el Registro.</p>
          <div className="row wrap">
            {EXPORTS.map(([k, l]) => <button key={k} className="sm" disabled={busy} onClick={() => download(k)}>{l}</button>)}
          </div>
        </div>
      )}
    </>
  );
}
