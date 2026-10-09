import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, useMap } from 'react-leaflet';
import { icons, useGeo, distanceKm, lempiras, minutes, TILE_URL, TILE_ATTRIBUTION } from './lib.js';
import { FitTo, PushToggle, Rate, SafetyBar, Stars } from './components.jsx';
import DriverDocs from './DriverDocs.jsx';

function Recenter({ pos }) {
  const map = useMap();
  useEffect(() => { if (pos) map.setView([pos.lat, pos.lng], 15); }, [!!pos]); // eslint-disable-line
  return null;
}

const NEXT = {
  accepted: { status: 'arrived', label: 'Ya llegué' },
  arrived: { status: 'started', label: 'Iniciar viaje' },
  started: { status: 'completed', label: 'Finalizar viaje' },
};

const STATUS = {
  accepted: 'Ve a recoger al pasajero',
  arrived: 'Esperando al pasajero',
  started: 'Viaje en curso',
  completed: 'Viaje finalizado',
  cancelled: 'El viaje fue cancelado',
};

export default function Driver({ socket, token, status }) {
  const { pos, setPos, denied } = useGeo();
  const [online, setOnline] = useState(false);
  const [requests, setRequests] = useState([]);
  const [sent, setSent] = useState({}); // rideId -> precio ofertado
  const [counter, setCounter] = useState({}); // rideId -> contraoferta
  const [ride, setRide] = useState(null);
  const [notApproved, setNotApproved] = useState(false);
  const posRef = useRef(pos);
  posRef.current = pos;

  useEffect(() => {
    socket.on('rides:open', setRequests);
    socket.on('ride:new', (r) => setRequests((cur) => [...cur.filter((x) => x.id !== r.id), r]));
    socket.on('ride:closed', ({ rideId }) => setRequests((cur) => cur.filter((x) => x.id !== rideId)));
    socket.on('offer:sent', ({ rideId, price }) => setSent((cur) => ({ ...cur, [rideId]: price })));
    socket.on('ride:state', setRide);
    socket.on('driver:denied', () => { setNotApproved(true); setOnline(false); });
    return () => ['rides:open', 'ride:new', 'ride:closed', 'offer:sent', 'ride:state', 'driver:denied'].forEach((e) => socket.off(e));
  }, [socket]);

  // Al reconectar, volver a ponerse en línea
  useEffect(() => {
    const onConnect = () => online && posRef.current && socket.emit('driver:online', posRef.current);
    socket.on('connect', onConnect);
    return () => socket.off('connect', onConnect);
  }, [socket, online]);

  // Enviar ubicación cada 3 s mientras está en línea o con viaje activo
  useEffect(() => {
    if (!pos) return;
    const id = setInterval(() => posRef.current && socket.emit('driver:location', posRef.current), 3000);
    return () => clearInterval(id);
  }, [socket, !!pos]); // eslint-disable-line

  // Si el admin aprueba la cuenta mientras la app está abierta, se quita el aviso
  useEffect(() => { if (status === 'active') setNotApproved(false); }, [status]);

  function toggle() {
    if (!pos) return;
    if (online) {
      socket.emit('driver:offline');
      setRequests([]);
      setSent({});
    } else {
      socket.emit('driver:online', pos);
    }
    setOnline(!online);
  }

  const active = ride && ['accepted', 'arrived', 'started'].includes(ride.status);
  // Si recarga la página con un viaje activo, queda como "en línea"
  useEffect(() => { if (active) setOnline(true); }, [active]);

  const offer = (r, price) => socket.emit('offer:make', { rideId: r.id, price: Number(price) });

  return (
    <div className="screen">
      <div className="map">
        {pos && (
          <MapContainer center={[pos.lat, pos.lng]} zoom={15} style={{ height: '100%' }}>
            <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
            <Recenter pos={pos} />
            <Marker
              position={[pos.lat, pos.lng]}
              icon={icons.car}
              draggable={denied}
              eventHandlers={{ dragend: (e) => setPos({ lat: e.target.getLatLng().lat, lng: e.target.getLatLng().lng }) }}
            />
            {!active && online && requests.map((r) => <Marker key={r.id} position={[r.origin_lat, r.origin_lng]} icon={icons.me} />)}
            {active && <Marker position={[ride.origin_lat, ride.origin_lng]} icon={icons.me} />}
            {active && <Marker position={[ride.dest_lat, ride.dest_lng]} icon={icons.dest} />}
            {active && ride.route && <Polyline positions={ride.route} pathOptions={{ color: '#0a7d4f', weight: 5, opacity: 0.85 }} />}
            {active && <FitTo points={ride.route?.length > 1 ? ride.route : [[ride.origin_lat, ride.origin_lng], [ride.dest_lat, ride.dest_lng]]} />}
          </MapContainer>
        )}
      </div>

      <div className="sheet">
        {denied && <div className="hint">Sin GPS: arrastra tu 🚕 para simular tu posición.</div>}

        {!active && (
          <>
            {ride && (ride.status === 'completed' || ride.status === 'cancelled') && (
              <div className="offer">
                <div>
                  <b>{STATUS[ride.status]}</b>
                  {ride.status === 'completed' && <div className="muted">Cobrar en efectivo: {lempiras(ride.final_price)}</div>}
                </div>
                <button className="primary sm" onClick={() => setRide(null)}>OK</button>
              </div>
            )}
            {ride?.status === 'completed' && ride.passenger && (
              <Rate token={token} rideId={ride.id} who={ride.passenger.name} />
            )}

            {(status === 'pending' || notApproved) && (
              <>
                <div className="hint">Tu cuenta está pendiente de aprobación. Cuando un administrador la apruebe podrás recibir viajes.</div>
                <DriverDocs token={token} socket={socket} />
              </>
            )}
            {!online && status !== 'pending' && <PushToggle token={token} why="Activa las notificaciones para recibir viajes cercanos y avisos aunque cierres la app." />}
            <button className={online ? 'danger' : 'primary'} onClick={toggle} disabled={!pos || status === 'pending'}>
              {online ? 'Desconectarme' : 'Ponerme disponible'}
            </button>

            {online && (
              <>
                <b>Solicitudes cercanas ({requests.length})</b>
                {requests.length === 0 && <div className="pulse">Esperando pasajeros…</div>}
                {requests.map((r) => {
                  const away = pos ? distanceKm(pos, { lat: r.origin_lat, lng: r.origin_lng }) : 0;
                  const c = counter[r.id] ?? String(Math.round(r.offered_price));
                  return (
                    <div className="req" key={r.id}>
                      <div className="row between">
                        <span><b>{r.passenger?.name}</b> <Stars rating={r.passenger?.rating} /></span>
                        <span className="tag">{lempiras(r.offered_price)}</span>
                      </div>
                      <div className="muted">Recogida a {away.toFixed(1)} km · viaje de {r.distance_km.toFixed(1)} km{r.duration_min ? ` (${minutes(r.duration_min)})` : ''}</div>
                      {r.dest_text && <div className="muted">Destino: {r.dest_text}</div>}
                      {sent[r.id] ? (
                        <div className="pulse">Ofertaste {lempiras(sent[r.id])}. Esperando respuesta…</div>
                      ) : (
                        <div className="row">
                          <button className="primary sm" onClick={() => offer(r, r.offered_price)}>Aceptar {lempiras(r.offered_price)}</button>
                          <input
                            className="mini"
                            inputMode="numeric"
                            value={c}
                            onChange={(e) => setCounter({ ...counter, [r.id]: e.target.value.replace(/\D/g, '') })}
                          />
                          <button className="sm" onClick={() => offer(r, c)}>Contraofertar</button>
                        </div>
                      )}
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}

        {active && (
          <>
            <div className="row between">
              <b>{STATUS[ride.status]}</b>
              <span className="tag">{lempiras(ride.final_price)}</span>
            </div>
            <div className="offer">
              <div>
                <b>{ride.passenger?.name}</b> <Stars rating={ride.passenger?.rating} />
                <div className="muted">{ride.dest_text ? `${ride.dest_text} · ` : ''}{ride.distance_km.toFixed(1)} km · efectivo</div>
              </div>
              <a className="primary sm" href={`tel:${ride.passenger?.phone}`}>Llamar</a>
            </div>
            <SafetyBar token={token} rideId={ride.id} socket={socket} getPos={() => pos} />
            {ride.status !== 'started' && (
              <button className="danger" onClick={() => window.confirm('¿Cancelar este viaje?') && socket.emit('ride:driver_cancel', { rideId: ride.id })}>
                Cancelar viaje
              </button>
            )}
            {NEXT[ride.status] && (
              <button className="primary" onClick={() => socket.emit('ride:status', { rideId: ride.id, status: NEXT[ride.status].status })}>
                {NEXT[ride.status].label}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
