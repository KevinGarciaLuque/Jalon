import { useEffect, useRef, useState } from 'react';
import { MapContainer, TileLayer, Marker, Polyline, useMap, useMapEvents } from 'react-leaflet';
import { icons, useGeo, apiGet, lempiras, minutes, TILE_URL, TILE_ATTRIBUTION } from './lib.js';
import { AddressSearch, FitTo, Rate, SafetyBar, Stars } from './components.jsx';

function Recenter({ pos }) {
  const map = useMap();
  useEffect(() => { if (pos) map.setView([pos.lat, pos.lng], map.getZoom() < 14 ? 15 : map.getZoom()); }, [!!pos]); // eslint-disable-line
  return null;
}

function Picker({ onPick, enabled }) {
  useMapEvents({ click: (e) => enabled && onPick({ lat: e.latlng.lat, lng: e.latlng.lng }) });
  return null;
}

const STATUS = {
  requested: 'Buscando conductor…',
  accepted: 'Tu conductor va en camino',
  arrived: 'Tu conductor llegó',
  started: 'Viaje en curso',
  completed: 'Viaje finalizado',
  cancelled: 'Viaje cancelado',
};

const CANCELLED = {
  passenger: 'Cancelaste el viaje',
  driver: 'El conductor canceló el viaje. Puedes pedir otro.',
  admin: 'El viaje fue cancelado por soporte',
  system: 'Nadie tomó tu viaje a tiempo. Intenta con un precio un poco mayor.',
};

const ROUTE_STYLE = { color: '#0a7d4f', weight: 5, opacity: 0.85 };

export default function Passenger({ socket, token }) {
  const { pos, setPos, denied } = useGeo();
  const [drivers, setDrivers] = useState([]);
  const [origin, setOrigin] = useState(null); // punto de recogida elegido a mano; null = mi GPS
  const [dest, setDest] = useState(null);
  const [preview, setPreview] = useState(null); // ruta, km, minutos y precio sugerido
  const [previewError, setPreviewError] = useState('');
  const [price, setPrice] = useState('');
  const priceEdited = useRef(false);
  const [ride, setRide] = useState(null);
  const [offers, setOffers] = useState([]);
  const [driverPos, setDriverPos] = useState(null);
  const [error, setError] = useState('');

  const active = ride && ['requested', 'accepted', 'arrived', 'started'].includes(ride.status);
  const from = origin || (pos && { ...pos, text: 'Mi ubicación' });
  // Se redondea (~100 m) para no recalcular la ruta por pequeños saltos del GPS
  const fromKey = from && `${from.lat.toFixed(3)},${from.lng.toFixed(3)}`;
  const destKey = dest && `${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`;

  useEffect(() => {
    socket.on('drivers:nearby', setDrivers);
    socket.on('ride:state', (r) => {
      setRide(r);
      if (r.status !== 'requested') setOffers([]);
    });
    socket.on('offer:new', (o) => setOffers((cur) => [...cur.filter((x) => x.driver.id !== o.driver.id), o]));
    socket.on('ride:driver_location', setDriverPos);
    // El conductor ya no está disponible: se quita su oferta
    socket.on('offer:invalid', ({ offerId }) => {
      setOffers((cur) => cur.filter((x) => x.id !== offerId));
      setError('Ese conductor ya no está disponible. Elige otra oferta.');
    });
    return () => ['drivers:nearby', 'ride:state', 'offer:new', 'ride:driver_location', 'offer:invalid'].forEach((e) => socket.off(e));
  }, [socket]);

  // Los conductores cercanos se buscan alrededor del punto de recogida
  useEffect(() => {
    if (from) socket.emit('passenger:location', { lat: from.lat, lng: from.lng });
  }, [fromKey, socket]); // eslint-disable-line react-hooks/exhaustive-deps

  // Vista previa de la ruta por calles
  useEffect(() => {
    if (!from || !dest || active) return;
    let stale = false;
    setPreview(null);
    setPreviewError('');
    apiGet(`route?from=${from.lat},${from.lng}&to=${dest.lat},${dest.lng}`, token)
      .then((r) => {
        if (stale) return;
        setPreview(r);
        if (!priceEdited.current) setPrice(String(r.suggestedPrice));
      })
      .catch((e) => !stale && setPreviewError(e.message));
    return () => { stale = true; };
  }, [fromKey, destKey, active]); // eslint-disable-line react-hooks/exhaustive-deps

  function pickDest(p) {
    priceEdited.current = false;
    setDest({ ...p, text: p.text || 'Destino en el mapa' });
    if (p.text) return;
    // Al tocar el mapa se busca el nombre de la calle o colonia
    apiGet(`reverse?lat=${p.lat}&lng=${p.lng}`, token)
      .then(({ text }) => text && setDest((cur) => (cur && cur.lat === p.lat && cur.lng === p.lng ? { ...cur, text } : cur)))
      .catch(() => {});
  }

  function request() {
    setError('');
    socket.emit(
      'ride:request',
      { origin: { lat: from.lat, lng: from.lng, text: from.text }, dest: { lat: dest.lat, lng: dest.lng, text: dest.text }, price: Number(price) },
      (res) => res?.error && setError(res.error)
    );
  }

  function newTrip() {
    setRide(null);
    setDest(null);
    setPreview(null);
    setPrice('');
    setDriverPos(null);
    priceEdited.current = false;
  }

  const showDrivers = !active || ride?.status === 'requested';
  const routeLine = active ? ride.route : preview?.coords;
  const fitPoints = routeLine?.length > 1 ? routeLine : from && dest && !active ? [[from.lat, from.lng], [dest.lat, dest.lng]] : [];
  const ended = ride && !active;

  return (
    <div className="screen">
      <div className="map">
        {pos && (
          <MapContainer center={[pos.lat, pos.lng]} zoom={15} style={{ height: '100%' }}>
            <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
            <Recenter pos={pos} />
            <FitTo points={fitPoints} />
            <Picker onPick={pickDest} enabled={!active} />
            {from && (
              <Marker
                position={[from.lat, from.lng]}
                icon={icons.me}
                draggable={denied && !origin && !active}
                eventHandlers={{ dragend: (e) => setPos({ lat: e.target.getLatLng().lat, lng: e.target.getLatLng().lng }) }}
              />
            )}
            {showDrivers && drivers.map((d) => <Marker key={d.id} position={[d.lat, d.lng]} icon={icons.car} />)}
            {(dest || active) && (
              <Marker position={active ? [ride.dest_lat, ride.dest_lng] : [dest.lat, dest.lng]} icon={icons.dest} />
            )}
            {active && driverPos && ride.status !== 'requested' && <Marker position={[driverPos.lat, driverPos.lng]} icon={icons.car} />}
            {routeLine && <Polyline positions={routeLine} pathOptions={ROUTE_STYLE} />}
          </MapContainer>
        )}
      </div>

      <div className="sheet">
        {denied && <div className="hint">Sin GPS: arrastra el pin 📍 para fijar tu posición, o busca tu dirección.</div>}

        {!active && !ended && (
          <>
            <div className="row between">
              <b>{drivers.length} conductor{drivers.length === 1 ? '' : 'es'} libre{drivers.length === 1 ? '' : 's'} cerca</b>
              <span className="dot" />
            </div>

            <AddressSearch icon="🟢" token={token} near={pos} placeholder="¿Dónde te recogemos?" value={origin ? origin.text : 'Mi ubicación'} onPick={setOrigin} />
            {origin && <button className="link left" onClick={() => setOrigin(null)}>📍 Usar mi ubicación</button>}
            <AddressSearch icon="🏁" token={token} near={from} placeholder="¿A dónde vas? (o toca el mapa)" value={dest?.text || ''} onPick={pickDest} />

            {dest && !preview && !previewError && <div className="pulse">Calculando ruta…</div>}
            {previewError && <div className="error">{previewError}</div>}
            {dest && preview && (
              <>
                <p className="muted">
                  {preview.distanceKm.toFixed(1)} km · {minutes(preview.durationMin)}
                  {preview.estimated && ' (estimado)'} · sugerido {lempiras(preview.suggestedPrice)}
                </p>
                <div className="price">
                  <button onClick={() => { priceEdited.current = true; setPrice(String(Math.max(10, Number(price) - 5))); }}>−</button>
                  <input
                    value={price}
                    inputMode="numeric"
                    onChange={(e) => { priceEdited.current = true; setPrice(e.target.value.replace(/\D/g, '')); }}
                  />
                  <button onClick={() => { priceEdited.current = true; setPrice(String(Number(price) + 5)); }}>+</button>
                </div>
                {error && <div className="error">{error}</div>}
                <button className="primary" disabled={!price} onClick={request}>Pedir Jalón por {lempiras(price || 0)}</button>
              </>
            )}
          </>
        )}

        {active && (
          <>
            <div className="row between">
              <b>{STATUS[ride.status]}</b>
              <span className="tag">{lempiras(ride.final_price ?? ride.offered_price)}</span>
            </div>
            <p className="muted">
              {ride.dest_text || 'Destino'} · {ride.distance_km.toFixed(1)} km{ride.duration_min ? ` · ${minutes(ride.duration_min)}` : ''}
            </p>

            {ride.status === 'requested' && (
              <>
                <p className="muted">Ofreciste {lempiras(ride.offered_price)}. Elige una oferta cuando lleguen:</p>
                {error && <div className="error">{error}</div>}
                {offers.length === 0 && <div className="pulse">Esperando ofertas de conductores…</div>}
                {offers.map((o) => (
                  <div className="offer" key={o.id}>
                    <div>
                      <b>{o.driver.name}</b> <Stars rating={o.driver.rating} />
                      <div className="muted">{o.driver.vehicle} · {o.driver.plate}{o.distanceToPickupKm != null && ` · a ${o.distanceToPickupKm.toFixed(1)} km`}</div>
                    </div>
                    <button className="primary sm" onClick={() => socket.emit('offer:accept', { offerId: o.id })}>{lempiras(o.price)}</button>
                  </div>
                ))}
              </>
            )}

            {ride.driver && (
              <div className="offer">
                <div>
                  <b>{ride.driver.name}</b> <Stars rating={ride.driver.rating} />
                  <div className="muted">{ride.driver.vehicle} · {ride.driver.plate}</div>
                </div>
                <a className="primary sm" href={`tel:${ride.driver.phone}`}>Llamar</a>
              </div>
            )}

            {ride.status !== 'requested' && <SafetyBar token={token} rideId={ride.id} socket={socket} getPos={() => pos} />}

            {ride.status !== 'started' && (
              <button className="danger" onClick={() => socket.emit('ride:cancel', { rideId: ride.id })}>Cancelar viaje</button>
            )}
          </>
        )}

        {ended && (
          <>
            <b>{ride.status === 'cancelled' ? CANCELLED[ride.cancelled_by] || STATUS.cancelled : STATUS[ride.status]}</b>
            {ride.status === 'completed' && (
              <>
                <p>Total a pagar en efectivo: <b>{lempiras(ride.final_price)}</b></p>
                {ride.driver && <Rate token={token} rideId={ride.id} who={ride.driver.name} />}
              </>
            )}
            <button className="primary" onClick={newTrip}>Nuevo viaje</button>
          </>
        )}
      </div>
    </div>
  );
}
