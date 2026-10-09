import { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import { MapContainer, TileLayer, Marker, Polyline, useMap } from 'react-leaflet';
import { icons, lempiras, TILE_URL, TILE_ATTRIBUTION } from './lib.js';

const REFRESH_MS = 5000;
const STATE = { free: ['Libre', 'free'], busy: ['En viaje', 'busy'], away: ['Sin conexión', 'away'] };
const RIDE = { accepted: 'Va por el pasajero', arrived: 'Llegó al origen', started: 'Viaje en curso' };
const TYPE = { completed: 'Completado', cancelled: 'Cancelado', started: 'En curso', accepted: 'Aceptado', arrived: 'Llegó' };
const CANCEL_BY = { passenger: 'el pasajero', driver: 'el conductor', admin: 'un administrador', system: 'el sistema' };

const driverIcon = (state, plate, selected) =>
  L.divIcon({
    className: '',
    html: `<div class="mk ${state}${selected ? ' sel' : ''}"><span class="car">🚕</span><span class="plate">${String(plate || '').replace(/[<>&"]/g, '')}</span></div>`,
    iconSize: [64, 46],
    iconAnchor: [32, 40],
  });
const waitIcon = L.divIcon({ className: '', html: '<div class="mk wait"><span class="car">🙋</span></div>', iconSize: [34, 34], iconAnchor: [17, 30] });

const ago = (s) => (s == null ? '—' : s < 60 ? `hace ${s} s` : s < 3600 ? `hace ${Math.round(s / 60)} min` : `hace ${Math.round(s / 3600)} h`);
const mins = (m) => (m == null ? '—' : m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`);
const when = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'short', timeStyle: 'short' });

// Encuadra el mapa solo cuando cambia `trigger` (al abrir, al elegir un conductor o con «Ver todos»): así el mapa no salta mientras lo mueves
function Fit({ points, trigger }) {
  const map = useMap();
  useEffect(() => {
    if (points.length > 1) map.fitBounds(points, { padding: [40, 40], maxZoom: 16 });
    else if (points.length === 1) map.setView(points[0], Math.max(map.getZoom(), 15));
  }, [trigger]); // eslint-disable-line react-hooks/exhaustive-deps
  return null;
}

// Mapa en vivo de conductores y ficha de rendimiento. Se refresca solo cada pocos segundos mientras la pestaña está abierta.
export default function Monitor({ call, onError }) {
  const [snap, setSnap] = useState(null);
  const [filter, setFilter] = useState('all');
  const [sel, setSel] = useState(null); // id del conductor elegido
  const [ficha, setFicha] = useState(null);
  const [fit, setFit] = useState(0); // cada cambio vuelve a encuadrar el mapa
  const first = useRef(true);
  const fichaRef = useRef(null);

  const load = useCallback(async () => {
    try {
      setSnap(await call('monitor'));
      if (first.current) { first.current = false; setFit((n) => n + 1); }
    } catch (e) {
      onError(e.message);
    }
  }, [call, onError]);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (!document.hidden) load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  useEffect(() => {
    if (!sel) return setFicha(null);
    let alive = true;
    const get = () => call(`monitor/drivers/${sel}`).then((f) => alive && setFicha(f)).catch((e) => onError(e.message));
    get();
    const t = setInterval(get, 15000);
    return () => { alive = false; clearInterval(t); };
  }, [sel, call, onError]);

  useEffect(() => { if (ficha) fichaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' }); }, [ficha?.driver.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!snap) return <div className="pulse">Cargando mapa…</div>;
  const drivers = snap.drivers.filter((d) => filter === 'all' || d.state === filter);
  const chosen = snap.drivers.find((d) => d.id === sel);
  const withPos = drivers.filter((d) => d.lat != null && d.lng != null);
  const points = chosen?.ride
    ? [[chosen.lat, chosen.lng], [chosen.ride.origin.lat, chosen.ride.origin.lng], [chosen.ride.dest.lat, chosen.ride.dest.lng]]
    : chosen ? [[chosen.lat, chosen.lng]] : withPos.map((d) => [d.lat, d.lng]);

  const pick = (id) => { setSel(sel === id ? null : id); setFit((n) => n + 1); };

  return (
    <div className="monitor">
      <div className="stats">
        <div><b className="free">{snap.counts.free}</b><span>Libres</span></div>
        <div><b className="busy">{snap.counts.busy}</b><span>En viaje</span></div>
        <div><b className="away">{snap.counts.away}</b><span>Sin conexión (con avisos)</span></div>
        <div className={snap.counts.waiting ? 'alert' : ''}><b>{snap.counts.waiting}</b><span>Solicitudes esperando</span></div>
      </div>

      <div className="chips">
        {[['all', 'Todos'], ['free', 'Libres'], ['busy', 'En viaje'], ['away', 'Sin conexión']].map(([k, label]) => (
          <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{label}</button>
        ))}
        <button onClick={() => { setSel(null); setFit((n) => n + 1); }}>Ver todos en el mapa</button>
      </div>

      <div className="monlayout">
        <div className="monmap">
          <MapContainer center={[14.0723, -87.1921]} zoom={12} style={{ height: '100%' }}>
            <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
            {withPos.map((d) => (
              <Marker key={d.id} position={[d.lat, d.lng]} icon={driverIcon(d.state, d.plate, d.id === sel)} eventHandlers={{ click: () => pick(d.id) }} />
            ))}
            {snap.waiting.map((w) => <Marker key={`w${w.id}`} position={[w.lat, w.lng]} icon={waitIcon} />)}
            {chosen?.ride && (
              <>
                <Marker position={[chosen.ride.origin.lat, chosen.ride.origin.lng]} icon={icons.me} />
                <Marker position={[chosen.ride.dest.lat, chosen.ride.dest.lng]} icon={icons.dest} />
                <Polyline positions={[[chosen.ride.origin.lat, chosen.ride.origin.lng], [chosen.ride.dest.lat, chosen.ride.dest.lng]]} pathOptions={{ dashArray: '6 8' }} />
              </>
            )}
            <Fit points={points} trigger={fit} />
          </MapContainer>
          {snap.drivers.length === 0 && <div className="monempty">Ningún conductor conectado en este momento.</div>}
        </div>

        <div className="monside">
          {drivers.length === 0 && <p className="muted">No hay conductores en esta lista.</p>}
          {drivers.map((d) => (
            <button key={d.id} className={`ucard click ${d.id === sel ? 'on' : ''}`} onClick={() => pick(d.id)}>
              <span className={`dotstate ${d.state}`} />
              <div className="grow">
                <b>{d.name}</b> <span className="muted small">{d.plate}</span>
                <div className="muted small">{STATE[d.state][0]}{d.ride ? ` · ${RIDE[d.ride.status]}` : ''} · {ago(d.seenSecondsAgo)}</div>
              </div>
            </button>
          ))}
          <p className="muted small">Se actualiza solo cada {REFRESH_MS / 1000} segundos. Cada vez que consultas este mapa queda anotado en el Registro.</p>
        </div>
      </div>

      {chosen && !ficha && <div className="pulse">Cargando ficha…</div>}
      {ficha && (
        <section className="req ficha" ref={fichaRef}>
          <div className="row between wrap">
            <b>{ficha.driver.name} · {ficha.driver.plate}</b>
            <a className="sm" href={`tel:${ficha.driver.phone}`}>📞 {ficha.driver.phone}</a>
          </div>
          <div className="muted small">{ficha.driver.vehicle} · cuenta {ficha.driver.status === 'active' ? 'activa' : ficha.driver.status === 'pending' ? 'pendiente' : 'bloqueada'} · desde {when(ficha.driver.since)}</div>
          {ficha.live ? (
            <div className={`hint ${ficha.live.state === 'away' ? '' : 'ok'}`}>
              {STATE[ficha.live.state][0]} · última señal {ago(ficha.live.seenSecondsAgo)} · conectado {mins(ficha.live.onlineMinutes)}
              {chosen?.ride && <> · <b>{RIDE[chosen.ride.status]}</b>: {chosen.ride.origin.text || 'origen'} → {chosen.ride.dest.text || 'destino'} (pasajero {chosen.ride.passenger}, {lempiras(chosen.ride.price)})</>}
            </div>
          ) : <div className="muted small">Ahora está desconectado.</div>}

          <b>Últimos 30 días</b>
          <div className="stats">
            <div><b>{ficha.last30.completed}</b><span>Viajes completados</span></div>
            <div><b>{lempiras(ficha.last30.earned)}</b><span>Cobrado en viajes</span></div>
            <div><b>{ficha.last30.km}</b><span>Km recorridos</span></div>
            <div><b>{ficha.last30.acceptanceRate == null ? '—' : `${ficha.last30.acceptanceRate}%`}</b><span>Ofertas aceptadas ({ficha.last30.offersAccepted}/{ficha.last30.offersMade})</span></div>
            <div className={ficha.last30.cancelledByDriver >= 3 ? 'alert' : ''}><b>{ficha.last30.cancelledByDriver}</b><span>Cancelados por él</span></div>
            <div><b>{ficha.rating ? `${ficha.rating.avg} ★` : '—'}</b><span>{ficha.rating ? `${ficha.rating.count} calificaciones` : 'Sin calificaciones'}</span></div>
            <div className={ficha.reports.open ? 'alert' : ''}><b>{ficha.reports.total}</b><span>Reportes en su contra ({ficha.reports.open} abiertos)</span></div>
            <div><b>{ficha.completedTotal}</b><span>Viajes en total</span></div>
            {ficha.balance !== undefined && <div><b>L {ficha.balance.toFixed(2)}</b><span>Saldo (comisión 30 d: L {Number(ficha.last30.commission || 0).toFixed(2)})</span></div>}
          </div>

          {ficha.recent.length > 0 && (
            <>
              <b>Últimos viajes</b>
              {ficha.recent.map((r) => (
                <div className="row between small" key={r.id}>
                  <span className="muted">#{r.id} · {when(r.created_at)} · {r.dest_text || 'sin destino'}</span>
                  <span>{TYPE[r.status] || r.status}{r.status === 'cancelled' && r.cancelled_by ? ` por ${CANCEL_BY[r.cancelled_by]}` : ''} · {lempiras(r.price)}</span>
                </div>
              ))}
            </>
          )}
        </section>
      )}
    </div>
  );
}
