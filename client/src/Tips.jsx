import { useEffect, useState } from 'react';
import { apiGet, lempiras } from './lib.js';
import { Loading, Empty } from './components.jsx';
import { Panel } from './Menu.jsx';

// Conductor: «Mis propinas». Lo de hoy, este mes y en total, y cada propina con su pasajero y destino.
const RANGES = [['month', 'Este mes'], ['last', 'Mes pasado'], ['all', 'Todo']];
const when = (d) => new Date(d).toLocaleString('es-HN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });

export default function Tips({ token, onClose }) {
  const [range, setRange] = useState('month');
  const [data, setData] = useState(null);
  const [list, setList] = useState([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setData(null);
    setList([]);
    setError('');
    apiGet(`driver/tips?range=${range}`, token).then((d) => { setData(d); setList(d.tips); }).catch((e) => setError(e.message));
  }, [range, token]);

  async function more() {
    setBusy(true);
    try {
      const d = await apiGet(`driver/tips?range=${range}&offset=${data.nextOffset}`, token);
      setList((cur) => [...cur, ...d.tips]);
      setData(d);
    } catch (e) { setError(e.message); } finally { setBusy(false); }
  }

  const s = data?.summary;
  return (
    <Panel onClose={onClose} labelledBy="tips-title">
      <div className="overlay-head">
        <b id="tips-title">Mis propinas</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        {error && <div className="error">{error}</div>}
        {!data && !error && <Loading />}
        {s && (
          <div className="tips-sum">
            <div><span>Hoy</span><b>{lempiras(s.today)}</b><em>{s.todayCount} propina{s.todayCount === 1 ? '' : 's'}</em></div>
            <div className="main"><span>Este mes</span><b>{lempiras(s.month)}</b><em>{s.monthCount} propina{s.monthCount === 1 ? '' : 's'}</em></div>
            <div><span>Total</span><b>{lempiras(s.total)}</b><em>{s.totalCount} propina{s.totalCount === 1 ? '' : 's'}</em></div>
          </div>
        )}
        {data && <p className="muted small">Las propinas son todas tuyas: Ktracho GO no cobra comisión sobre ellas. El pasajero te las paga en efectivo junto con el viaje.</p>}
        <div className="seg" role="radiogroup" aria-label="Período">
          {RANGES.map(([k, l]) => <button key={k} role="radio" aria-checked={range === k} className={range === k ? 'on' : ''} onClick={() => setRange(k)}>{l}</button>)}
        </div>
        {data && data.inRange.count > 0 && (
          <p className="small tips-range"><b>{lempiras(data.inRange.amount)}</b> en {data.inRange.count} propina{data.inRange.count === 1 ? '' : 's'} de {data.inRange.people} pasajero{data.inRange.people === 1 ? '' : 's'}</p>
        )}
        {data && !list.length && (
          <Empty title={range === 'month' ? 'Todavía no hay propinas este mes' : 'Sin propinas en este período'}>
            Cuando un pasajero te deje propina, aparece aquí. Un buen trato y un carro limpio ayudan.
          </Empty>
        )}
        {list.length > 0 && (
          <ul className="tips-list">
            {list.map((t) => (
              <li key={t.rideId}>
                <span className="tip-heart" aria-hidden="true">💚</span>
                <span className="grow">
                  <span className="tip-who"><b>{t.passenger}</b>{t.dest && <span className="muted"> · {t.dest.split(',')[0]}</span>}</span>
                  <span className="muted small">{when(t.at)} · viaje de {lempiras(t.fare)}</span>
                </span>
                <b className="tip-amt">{lempiras(t.amount)}</b>
              </li>
            ))}
          </ul>
        )}
        {data?.more && <button disabled={busy} onClick={more}>{busy ? 'Cargando…' : 'Ver más'}</button>}
      </div>
    </Panel>
  );
}
