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
import PermsBar from './PermsBar.jsx';
import { playRideAlert, playTipSound, unlockRideAlert, rideSoundOn, setRideSound } from './rideAlert.js';
import Tips from './Tips.jsx';
import TipCelebration from './TipCelebration.jsx';
import { IntercityBoard } from './Intercity.jsx';

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

const POWER = <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden="true"><path d="M12 3v8M6.3 6.8a8 8 0 1 0 11.4 0" /></svg>;

const QUICK = ['Ya llegué', 'Estoy afuera', 'Voy en camino', 'Llego en 5 minutos', 'No te encuentro'];

export default function Driver({ socket, token, status, userId, perms = [], onWallet, intercity = false }) {
  const { pos, setPos, denied, guessed, course, retry: retryGeo } = useGeo();
  const [online, setOnline] = useState(false);
  const [sound, setSound] = useState(rideSoundOn); // sonido al llegar una solicitud (se puede silenciar)
  const seenIds = useRef(new Set()); // solicitudes que ya está viendo: solo suenan las nuevas
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
  const [showTips, setShowTips] = useState(false); // «Mis propinas» (desde el menú)
  const [showIntercity, setShowIntercity] = useState(false); // «Viajes entre ciudades»
  const [tipCele, setTipCele] = useState(null); // el pasajero acaba de dejar propina
  const tipSeen = useRef({}); // propina que ya conocía de cada viaje (para celebrar solo la nueva)
  const [menuNote, setMenuNote] = useState(''); // por qué no se abrió algo del menú
  const [pin, setPin] = useState(''); // el PIN que le dice el pasajero para iniciar el viaje
  const [selfie, setSelfie] = useState(false); // le toca tomarse una selfie para conectarse
  const [pinError, setPinError] = useState('');
  const [renting, setRenting] = useState(false); // tiene un alquiler en curso: no recibe viajes
  const [today, setToday] = useState(null); // lo que le quedó hoy y cuántos viajes (tarjeta «Hoy»)
  const posRef = useRef(pos);
  posRef.current = guessed ? null : pos; // sin GPS, el centro de Tegucigalpa no se manda como su ubicación

  const loadWallet = () => apiGet('driver/wallet', token).then(setWallet).catch(() => {});
  // «Mi saldo y recargas» en el menú, con el saldo a la vista
  const showsWallet = !!wallet?.enabled && status !== 'pending';
  useEffect(() => {
    onWallet?.(showsWallet ? { balance: wallet.balance, low: wallet.balance < wallet.minBalance } : null);
  }, [showsWallet, wallet?.balance, wallet?.minBalance]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => onWallet?.(null), []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (status !== 'pending') loadWallet(); }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
  const lowBalance = showsWallet && wallet.balance < wallet.minBalance;
  // Ganancias de hoy: al abrir y cada vez que termina un viaje
  // Llegó la propina de un viaje que ya estaba viendo sin propina: celebración con sonido (no al reabrir la app con una vieja)
  useEffect(() => {
    if (!ride) return;
    const before = tipSeen.current[ride.id];
    const tip = Number(ride.tip) || 0;
    if (before !== undefined && before === 0 && tip > 0) {
      playTipSound();
      setTipCele({ amount: tip, passenger: ride.passenger?.name?.trim().split(/\s+/)[0] || '', toCollect: (ride.toPay ?? ride.final_price) + tip });
    }
    tipSeen.current[ride.id] = tip;
  }, [ride?.id, ride?.tip]); // eslint-disable-line react-hooks/exhaustive-deps
  const doneRideId = ride?.status === 'completed' ? ride.id : 0;
  useEffect(() => {
    if (status === 'active') apiGet('driver/earnings?period=day', token).then(setToday).catch(() => {});
  }, [status, doneRideId]); // eslint-disable-line react-hooks/exhaustive-deps
  // La campanita: un aviso de recarga o de saldo abre «Mi saldo»
  useEffect(() => {
    const go = (e) => {
      if (e.detail === 'wallet') { loadWallet(); setShowWallet(true); }
      if (e.detail === 'earnings') setShowEarnings(true);
      if (e.detail === 'tips') setShowTips(true);
      if (e.detail === 'intercity' && intercity) setShowIntercity(true);
      // Desde el menú: el alquiler por días se arregla sin estar disponible ni en un viaje (igual que el botón de abajo)
      if (e.detail === 'rental') { if (online || ride) setMenuNote('Para alquilar tu carro por días, termina el viaje y desconéctate primero.'); else setShowRental(true); }
    };
    window.addEventListener('ktracho:go', go);
    return () => window.removeEventListener('ktracho:go', go);
  }); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    socket.on('rides:open', setRequests);
    socket.on('ride:new', (r) => {
      // Solicitud nueva (o que vuelve porque el pasajero subió el precio): suena y vibra
      if (!seenIds.current.has(r.id)) playRideAlert();
      setRequests((cur) => [...cur.filter((x) => x.id !== r.id), r]);
    });
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
    if (!pos || (guessed && !online)) return;
    unlockRideAlert(); // el toque permite que después suene el aviso de solicitudes
    if (online) {
      socket.emit('driver:offline');
      setRequests([]);
      setSent({});
    } else {
      socket.emit('driver:online', posRef.current);
    }
    setOnline(!online);
  }

  useEffect(() => { seenIds.current = new Set(requests.map((r) => r.id)); }, [requests]);
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
      <PermsBar token={token} role="driver" geoDenied={denied} onGeoRetry={retryGeo} hidden={!!active} />
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
              aura={online ? 'online' : 'offline'}
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

      <div className={`sheet${compact ? ' compact' : ''}${online && !active && requests.length ? ' has-requests' : ''}`}>
        <Grab compact={compact} setCompact={setCompact} />
        {showTips && <Tips token={token} onClose={() => setShowTips(false)} />}
        {showIntercity && <IntercityBoard token={token} socket={socket} pos={guessed ? null : pos} onClose={() => setShowIntercity(false)} />}
        {tipCele && <TipCelebration tip={tipCele} onClose={() => setTipCele(null)} />}
        {denied && guessed && !online && <div className="hint danger" role="alert">📍 <b>No tenemos tu ubicación.</b> Activa la ubicación para Ktracho GO, o arrastra tu carro en el mapa hasta donde estás, para ponerte disponible. <button type="button" className="link" onClick={() => window.dispatchEvent(new Event('ktracho:geo-help'))}>Cómo activar mi ubicación</button></div>}
        {denied && !guessed && <div className="hint">Sin GPS: tu posición es la que marcaste con el carro. Arrástralo si te mueves.</div>}

        {!active && (
          <>
            {ride && (ride.status === 'completed' || ride.status === 'cancelled') && (
              <div className="offer">
                <div>
                  <b>{STATUS[ride.status]}</b>
                  {ride.status === 'completed' && <div className="muted">Cobrar en efectivo: {lempiras((ride.toPay ?? ride.final_price) + (ride.tip || 0))}{ride.discount > 0 ? ` · Ktracho GO te puso ${lempiras(ride.discount)} en tu saldo` : ''}</div>}
                  {ride.status === 'completed' && ride.tip > 0 && <div className="tip-done" role="status">💚 Te dejó <b>{lempiras(ride.tip)}</b> de propina (ya va en el total). Es toda tuya.</div>}
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
            {selfie && <DriverSelfie onClose={() => setSelfie(false)} onDone={() => { setSelfie(false); if (posRef.current) { socket.emit('driver:online', posRef.current); setOnline(true); } }} />}
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
            {/* Estado en una línea: desconectado / en línea, y los avisos de este aparato */}
            {status !== 'pending' && (
              <div className="drv-status">
                <span className={`drv-dot${online ? ' on' : ''}`} aria-hidden="true" />
                <b className="grow">{online ? 'En línea · buscando viajes' : 'Estás desconectado'}</b>
                {/* En línea: «Desconectarme» pequeño aquí arriba, para dejarle espacio a las solicitudes */}
                {online && !active && <button type="button" className="sm danger" onClick={toggle}>Desconectarme</button>}
                {!online && <PushToggle token={token} compact why="Activa las notificaciones para recibir viajes cercanos y avisos aunque cierres la app." />}
              </div>
            )}
            {/* Desconectado: saldo y lo de hoy en dos tarjetas; en línea, en una sola línea para dejar espacio a las solicitudes */}
            {!online && (showsWallet || status === 'active') && (
              <div className="drv-cards">
                {showsWallet && (
                  <button type="button" className={`drv-card wallet${lowBalance ? ' low' : ''}`} onClick={() => setShowWallet(true)}>
                    <span>Saldo</span>
                    <b>{money2(wallet.balance)}</b>
                    <em>{lowBalance ? 'Recargar ahora' : 'Recargar'}</em>
                  </button>
                )}
                {status === 'active' && (
                  <button type="button" className="drv-card" onClick={() => setShowEarnings(true)}>
                    <span>Te quedó hoy</span>
                    <b>{today ? money2(today.net) : '—'}</b>
                    <em>{today ? `${today.rides} viaje${today.rides === 1 ? '' : 's'} · Ver más` : 'Mis ganancias'}</em>
                  </button>
                )}
              </div>
            )}
            {!online && showsWallet && <div className="muted small">Comisión {wallet.percent}% por viaje · mínimo {money2(wallet.minBalance)} para recibir viajes</div>}
            {online && (showsWallet || today) && !requests.length && (
              <div className="muted small drv-line">
                {showsWallet && <span>Saldo <b>{money2(wallet.balance)}</b></span>}
                {today && <span>Hoy <b>{money2(today.net)}</b></span>}
              </div>
            )}
            {lowBalance && <div className="hint danger">Tu saldo está por debajo del mínimo: recarga para volver a recibir viajes.</div>}
            {showEarnings && <Earnings token={token} onClose={() => setShowEarnings(false)} />}
            {status === 'active' && intercity && !active && !requests.length && <button type="button" className="ic-entry" onClick={() => setShowIntercity(true)}><span aria-hidden="true">🛣</span> <span className="grow"><b>Viajes entre ciudades</b><span className="muted small">Viajes largos publicados por pasajeros</span></span><span aria-hidden="true">›</span></button>}
            {status === 'active' && !online && perms.includes('rent.offer') && <button className="sm left" onClick={() => setShowRental(true)}>Alquiler de mi carro por días</button>}
            {online ? null : (
              <div className="ask-bar">
                <button className="primary go" onClick={toggle} disabled={!pos || guessed || status === 'pending'}>{POWER} Ponerme disponible</button>
              </div>
            )}

            {online && (
              <>
                <div className="row between">
                  <b>Solicitudes cercanas ({requests.length})</b>
                  <label className="sound-toggle" title={sound ? 'Silenciar el aviso de solicitudes' : 'Activar el sonido de solicitudes'}>
                    <span aria-hidden="true">{sound ? '🔔 Sonido' : '🔕 Silencio'}</span>
                    <input type="checkbox" role="switch" className="switch sm" aria-label="Sonido de las solicitudes" checked={sound}
                      onChange={(e) => { const on = e.target.checked; setRideSound(on); setSound(on); if (on) { unlockRideAlert(); playRideAlert(); } }} />
                  </label>
                </div>
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
                      {r.scheduled_for && <span className="pill">🗓 Programado: {new Date(r.scheduled_for).toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit' })}</span>}
                      {r.rider_name && <div className="small">Recoger a: <b>{r.rider_name}</b></div>}
                      {r.pickup_note && <div className="small">📍 {r.pickup_note}</div>}
                      {r.stops?.length > 0 && <div className="small">Con {r.stops.length} parada{r.stops.length === 1 ? '' : 's'}: {r.stops.map((p) => p.text || 'en el mapa').join(' → ')}</div>}
                      <div className="route-list">
                        <div><i className="dot-o" /><span className="addr" title={r.origin_text || ''}><span className="sr-only">Recoger en: </span>{r.origin_text || 'Punto marcado en el mapa'}</span><span className="muted small km">a {away.toFixed(1)} km</span></div>
                        <div><i className="dot-d" /><span className="addr" title={r.dest_text || ''}><span className="sr-only">Destino: </span>{r.dest_text || 'Punto marcado en el mapa'}</span><span className="muted small km">{r.distance_km.toFixed(1)} km{r.duration_min ? `, ${minutes(r.duration_min)}` : ''}</span></div>
                      </div>
                      <button className="link left route-toggle" onClick={() => setPreviewId(r.id === previewId ? null : r.id)}>
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
            {/* Con código promocional el pasajero paga menos en efectivo: la diferencia la pone Ktracho GO en su saldo */}
            {ride.discount > 0 && (
              <p className="promo-note small" role="status">🏷 El pasajero usa un código: cobra <b>{lempiras(ride.toPay)}</b> en efectivo. Los {lempiras(ride.discount)} restantes te los pone Ktracho GO en tu saldo al terminar.</p>
            )}
            <div className="offer">
              <Avatar name={ride.passenger?.name} />
              <div className="who">
                <span><b>{ride.passenger?.name}</b> <Stars rating={ride.passenger?.rating} /></span>
                {/* Mientras va por el pasajero importa dónde recogerlo; con el viaje en curso, a dónde va */}
                {ride.status === 'started'
                  ? <span className="small"><span className="muted">Destino:</span> {ride.dest_text || 'Punto marcado en el mapa'}</span>
                  : <span className="small"><span className="muted">Recoger en:</span> {ride.origin_text || 'Punto marcado en el mapa'}</span>}
                {ride.rider_name && ride.status !== 'started' && <span className="small"><span className="muted">Recoger a:</span> <b>{ride.rider_name}</b></span>}
                {ride.pickup_note && ride.status !== 'started' && <span className="small">📍 {ride.pickup_note}</span>}
                {ride.stops?.length > 0 && <span className="small"><span className="muted">Paradas:</span> {ride.stops.map((p, i) => `${i + 1}. ${p.text || 'en el mapa'}`).join(' · ')}</span>}
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
