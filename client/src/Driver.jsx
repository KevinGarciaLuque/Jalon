import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, useMap } from 'react-leaflet';
import { useGeo, distanceKm, lempiras, minutes, useChat, useNow, wazeUrl, mapsUrl, apiGet, money2, TILE_URL, TILE_ATTRIBUTION } from './lib.js';
import { CarMarker, FitTo, MapControls, RouteLine, icons, rotateOptions, showAt } from './mapParts.jsx';
import DriverWallet from './DriverWallet.jsx';
import DriverRental from './DriverRental.jsx';
import Earnings from './Earnings.jsx';
import { Avatar, Chat, PriceStepper, PushToggle, Rate, SafetyBar, Stars, TimeRing, Grab } from './components.jsx';
import ReportForm from './ReportForm.jsx';
import DriverDocs from './DriverDocs.jsx';
import DriverSelfie from './DriverSelfie.jsx';

function Recenter({ pos }) {
  const map = useMap();
  useEffect(() => { if (pos) showAt(map, [pos.lat, pos.lng], 15); }, [!!pos]); // eslint-disable-line
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

const QUICK = ['Ya llegué', 'Estoy afuera', 'Voy en camino', 'Llego en 5 minutos', 'No te encuentro'];

export default function Driver({ socket, token, status, userId, perms = [], onWallet }) {
  const { pos, setPos, denied, course } = useGeo();
  const [online, setOnline] = useState(false);
  const [requests, setRequests] = useState([]);
  const [sent, setSent] = useState({}); // rideId -> { price, until } de la oferta hecha (vale unos segundos)
  const [eta, setEta] = useState(null); // tiempo y camino hacia el pasajero (o al destino)
  const now = useNow();
  const [counter, setCounter] = useState({}); // rideId -> contraoferta
  const [ride, setRide] = useState(null);
  const chat = useChat(socket, ride, userId);
  const [reporting, setReporting] = useState(false);
  const [wallet, setWallet] = useState(null); // saldo, datos para transferir y movimientos (solo si la comisión está activa)
  const [showWallet, setShowWallet] = useState(false);
  const [previewId, setPreviewId] = useState(null); // solicitud que el conductor está mirando en el mapa (origen, destino y ruta)
  const [notApproved, setNotApproved] = useState(false);
  const [compact, setCompact] = useState(false); // en el celular, la hoja de abajo se puede achicar para ver más mapa
  const [showRental, setShowRental] = useState(false); // alquiler de su carro por días
  const [showEarnings, setShowEarnings] = useState(false); // mis ganancias por día, semana o mes
  const [menuNote, setMenuNote] = useState(''); // por qué no se abrió algo del menú
  const [pin, setPin] = useState(''); // el PIN que le dice el pasajero para iniciar el viaje
  const [selfie, setSelfie] = useState(false); // le toca tomarse una selfie para conectarse
  const [pinError, setPinError] = useState('');
  const [renting, setRenting] = useState(false); // tiene un alquiler en curso: no recibe viajes
  const posRef = useRef(pos);
  posRef.current = pos;

  const loadWallet = () => apiGet('driver/wallet', token).then(setWallet).catch(() => {});
  // «Mi saldo y recargas» en el menú, con el saldo a la vista
  const showsWallet = !!wallet?.enabled && status !== 'pending';
  useEffect(() => {
    onWallet?.(showsWallet ? { balance: wallet.balance, low: wallet.balance < wallet.minBalance } : null);
  }, [showsWallet, wallet?.balance, wallet?.minBalance]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onWallet?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (status !== 'pending') loadWallet(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  // La campanita: un aviso de recarga o de saldo abre «Mi saldo»
  useEffect(() => {
    const go = (e) => {
      if (e.detail === 'wallet') { loadWallet(); setShowWallet(true); }
      if (e.detail === 'earnings') setShowEarnings(true);
      // Desde el menú: el alquiler por días se arregla sin estar disponible ni en un viaje (igual que el botón de abajo)
      if (e.detail === 'rental') { if (online || ride) setMenuNote('Para alquilar tu carro por días, termina el viaje y desconéctate primero.'); else setShowRental(true); }
    };
    window.addEventListener('ktracho:go', go);
    return () => window.removeEventListener('ktracho:go', go);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    socket.on('rides:open', setRequests);
    socket.on('ride:new', (r) => setRequests((cur) => [...cur.filter((x) => x.id !== r.id), r]));
    socket.on('ride:closed', ({ rideId }) => setRequests((cur) => cur.filter((x) => x.id !== rideId)));
    socket.on('offer:sent', ({ rideId, price, ttl }) => setSent((cur) => ({ ...cur, [rideId]: { price, ttl: ttl || 90, until: Date.now() + (ttl || 90) * 1000 } })));
    // Si la oferta venció sin respuesta, puede volver a ofertar
    socket.on('offer:expired', ({ rideId }) => setSent((cur) => { const { [rideId]: _gone, ...rest } = cur; return rest; }));
    socket.on('ride:eta', setEta);
    socket.on('ride:state', setRide);
    // Sin saldo suficiente el servidor no lo deja ponerse disponible: se abre la pantalla para recargar
    socket.on('driver:denied', (d) => {
      setOnline(false);
      if (d?.status === 'balance') { loadWallet(); setShowWallet(true); } else if (d?.status === 'rental') setRenting(true); else if (d?.status === 'selfie') setSelfie(true); else setNotApproved(true);
    });
    socket.on('wallet:update', loadWallet);
    socket.on('wallet:low', () => { setOnline(false); loadWallet(); });
    return () => ['rides:open', 'ride:new', 'ride:closed', 'offer:sent', 'offer:expired', 'ride:eta', 'ride:state', 'driver:denied', 'wallet:update', 'wallet:low'].forEach((e) => socket.off(e));
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
  const preview = requests.find((q) => q.id === previewId) || null;
  // Si recarga la página con un viaje activo, queda como "en línea"
  useEffect(() => { if (active) setOnline(true); }, [active]);

  const offer = (r, price) => socket.emit('offer:make', { rideId: r.id, price: Number(price) });
  // Rechazar: deja de verla (el servidor la vuelve a mandar si el pasajero sube el precio)
  const decline = (r) => {
    socket.emit('ride:decline', { rideId: r.id });
    setRequests((cur) => cur.filter((x) => x.id !== r.id));
    if (previewId === r.id) setPreviewId(null);
  };

  return (
    <div className="screen">
      <div className="map">
        {pos && (
          <MapContainer center={[pos.lat, pos.lng]} zoom={15} style={{ height: '100%' }} {...rotateOptions()}>
            <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
            <MapControls
              me={pos}
              course={course}
              modeKey="driver"
              defaultMode="heading"
              follow
              resumeOn={ride?.status === 'started' ? ride.id : null}
              route={active ? (ride.route?.length > 1 ? ride.route : [[ride.origin_lat, ride.origin_lng], [ride.dest_lat, ride.dest_lng]]) : online && preview?.route?.length > 1 ? preview.route : null}
            />
            <Recenter pos={pos} />
            <CarMarker
              position={pos}
              duration={900}
              draggable={denied}
              eventHandlers={{ dragend: (e) => setPos({ lat: e.target.getLatLng().lat, lng: e.target.getLatLng().lng }) }}
            />
            {!active && online && requests.map((r) => (
              <Marker key={r.id} position={[r.origin_lat, r.origin_lng]} icon={icons.me} eventHandlers={{ click: () => setPreviewId(r.id) }} />
            ))}
            {!active && online && preview && (
              <>
                <Marker position={[preview.dest_lat, preview.dest_lng]} icon={icons.dest} />
                {preview.route?.length > 1 && <RouteLine positions={preview.route} color="#f59e0b" />}
                <FitTo points={preview.route?.length > 1 ? preview.route : [[preview.origin_lat, preview.origin_lng], [preview.dest_lat, preview.dest_lng]]} />
              </>
            )}
            {active && <Marker position={[ride.origin_lat, ride.origin_lng]} icon={icons.me} />}
            {active && <Marker position={[ride.dest_lat, ride.dest_lng]} icon={icons.dest} />}
            {active && ride.route && <RouteLine positions={ride.route} />}
            {active && ride.status === 'accepted' && eta?.rideId === ride.id && eta.coords && <RouteLine positions={eta.coords} color="#2563eb" dashed />}
            {active && <FitTo points={ride.route?.length > 1 ? ride.route : [[ride.origin_lat, ride.origin_lng], [ride.dest_lat, ride.dest_lng]]} />}
          </MapContainer>
        )}
      </div>

      <div className={`sheet${compact ? ' compact' : ''}`}>
        <Grab compact={compact} setCompact={setCompact} />
        {denied && <div className="hint">Sin GPS: arrastra tu carro para simular tu posición.</div>}

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
            {ride?.status === 'completed' && ride.passenger && chat.chatable && !chat.closed && (
              <button onClick={chat.open ? chat.closeChat : chat.openChat}>💬 Chat con el pasajero{chat.unread ? ` (${chat.unread})` : ''}</button>
            )}
            {ride?.status === 'completed' && <button onClick={() => setReporting(true)}>⚠ Reportar un problema con este viaje</button>}
            {showWallet && wallet && <DriverWallet wallet={wallet} reload={loadWallet} onClose={() => setShowWallet(false)} />}
            {showRental && <DriverRental token={token} socket={socket} onClose={() => { setShowRental(false); setRenting(false); }} />}
            {selfie && <DriverSelfie onClose={() => setSelfie(false)} onDone={() => { setSelfie(false); if (pos) { socket.emit('driver:online', pos); setOnline(true); } }} />}
            {menuNote && <div className="hint" role="status">{menuNote} <button className="link" onClick={() => setMenuNote('')}>Entendido</button></div>}
            {renting && <div className="hint">Tienes un alquiler en curso: no recibes viajes hasta terminarlo en «Alquiler de mi carro».</div>}
            {reporting && ride && <ReportForm rideId={ride.id} token={token} onClose={() => setReporting(false)} />}
            {ride?.status === 'completed' && chat.open && <Chat chat={chat} meId={userId} quick={['Encontré tu objeto, ¿dónde nos vemos?']} />}
            {ride?.status === 'completed' && ride.passenger && (
              <Rate token={token} rideId={ride.id} who={ride.passenger.name} title="¡Viaje terminado!" />
            )}

            {(status === 'pending' || notApproved) && (
              <>
                <div className="hint">Tu cuenta está pendiente de aprobación. Cuando un administrador la apruebe podrás recibir viajes.</div>
                <DriverDocs token={token} socket={socket} />
              </>
            )}
            {wallet?.enabled && status !== 'pending' && (
              <div className="wallet-chip">
                <div>
                  <b>💰 Saldo: {money2(wallet.balance)}</b>
                  <div className="muted small">Comisión {wallet.percent}% por viaje · mínimo {money2(wallet.minBalance)} para recibir viajes</div>
                </div>
                <button className={wallet.balance < wallet.minBalance ? 'primary sm' : 'sm'} onClick={() => setShowWallet(true)}>Recargar</button>
              </div>
            )}
            {wallet?.enabled && wallet.balance < wallet.minBalance && <div className="hint danger">Tu saldo está por debajo del mínimo: recarga para volver a recibir viajes.</div>}
            {status === 'active' && !online && <button className="sm left" onClick={() => setShowEarnings(true)}>Mis ganancias</button>}
            {showEarnings && <Earnings token={token} onClose={() => setShowEarnings(false)} />}
            {status === 'active' && !online && perms.includes('rent.offer') && <button className="sm left" onClick={() => setShowRental(true)}>Alquiler de mi carro por días</button>}
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
                  // Con el mismo precio del pasajero es aceptar; con otro, una contraoferta
                  const same = Number(c) === Math.round(r.offered_price);
                  const waiting = sent[r.id] && sent[r.id].until > now;
                  return (
                    <div className={`req ${r.id === previewId ? 'picked' : ''}`} key={r.id}>
                      <div className="row between">
                        <span className="row"><Avatar name={r.passenger?.name} /><span><b>{r.passenger?.name}</b> <Stars rating={r.passenger?.rating} /></span></span>
                        <span className="tag">{lempiras(r.offered_price)}</span>
                      </div>
                      {!!r.women_only && <span className="pill women">🚺 Solo conductoras</span>}
                      <div className="route-list">
                        <div><i className="dot-o" /><span><span className="sr-only">Recoger en: </span>{r.origin_text || 'Punto marcado en el mapa'} <span className="muted small">· a {away.toFixed(1)} km</span></span></div>
                        <div><i className="dot-d" /><span><span className="sr-only">Destino: </span>{r.dest_text || 'Punto marcado en el mapa'} <span className="muted small">· {r.distance_km.toFixed(1)} km{r.duration_min ? `, ${minutes(r.duration_min)}` : ''}</span></span></div>
                      </div>
                      <button className="sm" onClick={() => setPreviewId(r.id === previewId ? null : r.id)}>
                        {r.id === previewId ? 'Ocultar ruta' : 'Ver ruta en el mapa'}
                      </button>
                      {waiting ? (
                        <div className="row">
                          <TimeRing left={(sent[r.id].until - now) / 1000} total={sent[r.id].ttl} />
                          <span className="muted">Ofertaste <b>{lempiras(sent[r.id].price)}</b>. Esperando respuesta del pasajero…</span>
                        </div>
                      ) : (
                        <>
                          <PriceStepper value={c} label="Tu precio en lempiras" onChange={(v) => setCounter({ ...counter, [r.id]: v })} />
                          <div className="row">
                            <button onClick={() => decline(r)}>Rechazar</button>
                            <button className="primary grow" disabled={!Number(c)} onClick={() => offer(r, same ? r.offered_price : c)}>
                              {same ? `Aceptar ${lempiras(r.offered_price)}` : `Ofertar ${lempiras(c)}`}
                            </button>
                          </div>
                        </>
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
              <Avatar name={ride.passenger?.name} />
              <div className="who">
                <span><b>{ride.passenger?.name}</b> <Stars rating={ride.passenger?.rating} /></span>
                {/* Mientras va por el pasajero importa dónde recogerlo; con el viaje en curso, a dónde va */}
                {ride.status === 'started'
                  ? <span className="small"><span className="muted">Destino:</span> {ride.dest_text || 'Punto marcado en el mapa'}</span>
                  : <span className="small"><span className="muted">Recoger en:</span> {ride.origin_text || 'Punto marcado en el mapa'}</span>}
                <span className="muted small">{ride.distance_km.toFixed(1)} km de viaje · efectivo</span>
              </div>
              <div className="row">
                {ride.passenger?.phone && <a className="sm" href={`tel:${ride.passenger.phone}`}>Llamar</a>}
                <button className="primary sm" onClick={chat.open ? chat.closeChat : chat.openChat}>💬 Chat{chat.unread ? ` (${chat.unread})` : ''}</button>
              </div>
            </div>
            {chat.open && <Chat chat={chat} meId={userId} quick={QUICK} />}
            {eta && eta.rideId === ride.id && ['accepted', 'started'].includes(ride.status) && (
              <p className="eta">{ride.status === 'started' ? '🏁 Al destino' : '📍 Al pasajero'}: <b>~{eta.minutes} min</b> <span className="muted">({eta.km} km)</span></p>
            )}
            {ride.status !== 'completed' && (() => {
              const target = ride.status === 'started' ? { lat: ride.dest_lat, lng: ride.dest_lng } : { lat: ride.origin_lat, lng: ride.origin_lng };
              return (
                <div className="row nav">
                  <a className="sm" target="_blank" rel="noreferrer" href={wazeUrl(target)}>🧭 Waze</a>
                  <a className="sm" target="_blank" rel="noreferrer" href={mapsUrl(target)}>🗺 Google Maps</a>
                </div>
              );
            })()}
            <SafetyBar token={token} rideId={ride.id} socket={socket} getPos={() => pos} />
            {ride.status !== 'started' && (
              <button className="danger" onClick={() => window.confirm('¿Cancelar este viaje?') && socket.emit('ride:driver_cancel', { rideId: ride.id })}>
                Cancelar viaje
              </button>
            )}
            {ride.status === 'accepted' && ride.pinRequired && <p className="muted small">Cuando suba el pasajero, pídele su PIN de 4 dígitos para iniciar el viaje.</p>}
            {ride.status === 'arrived' && ride.pinRequired && !ride.pinLocked && (
              <label className="pin-input">
                <span>PIN del pasajero</span>
                <input className="code" inputMode="numeric" autoComplete="off" maxLength={4} aria-label="PIN del pasajero (4 dígitos)" placeholder="• • • •" value={pin} onChange={(e) => { setPin(e.target.value.replace(/\D/g, '')); setPinError(''); }} />
              </label>
            )}
            {(pinError || (ride.status === 'arrived' && ride.pinLocked)) && <div className="error">{pinError || 'Se equivocaron demasiadas veces con el PIN: este viaje no se puede iniciar. Cancélalo o escribe a soporte.'}</div>}
            {NEXT[ride.status] && !(ride.status === 'arrived' && ride.pinLocked) && (
              <button
                className="primary"
                disabled={ride.status === 'arrived' && ride.pinRequired && pin.length !== 4}
                onClick={() => socket.emit('ride:status', { rideId: ride.id, status: NEXT[ride.status].status, pin }, (r) => { if (r?.error) setPinError(r.error); else setPin(''); })}
              >
                {NEXT[ride.status].label}
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}
