import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { MapContainer, TileLayer, Marker, useMap, useMapEvents } from 'react-leaflet';
import { useGeo, apiGet, apiPost, lempiras, minutes, useChat, useNow, CATEGORIES, CATEGORY_LABEL, TILE_URL, TILE_ATTRIBUTION } from './lib.js';
import { CarMarker, FitTo, MapControls, RouteLine, icons, rotateOptions, showAt } from './mapParts.jsx';
import ReportForm from './ReportForm.jsx';
import Rentals from './Rentals.jsx';
import { AddressSearch, Avatar, Chat, PriceStepper, Rate, SafetyBar, Stars, TimeRing, Grab } from './components.jsx';

function Recenter({ pos }) {
  const map = useMap();
  useEffect(() => { if (pos) showAt(map, [pos.lat, pos.lng], map.getZoom() < 14 ? 15 : map.getZoom()); }, [!!pos]); // eslint-disable-line
  return null;
}

// El PIN del viaje: el pasajero se lo dice al conductor al subir (así sabe que es el carro correcto)
function TripPin({ ride, token }) {
  const [pin, setPin] = useState(null);
  useEffect(() => {
    let alive = true;
    apiGet(`rides/${ride.id}/pin`, token).then((r) => alive && setPin(r.pin)).catch(() => {});
    return () => { alive = false; };
  }, [ride.id, token]);
  if (ride.pinLocked) return <div className="hint danger" role="alert">⚠ El conductor no escribió tu PIN correcto. Si no es tu conductor, no te subas y cancela el viaje.</div>;
  if (!pin) return null;
  return (
    <div className="trip-pin" role="status">
      <span className="muted small">Tu PIN para empezar el viaje</span>
      <b aria-label={`PIN ${pin.split('').join(' ')}`}>{pin}</b>
      <span className="muted small">Díselo al conductor <b>cuando subas</b> al carro. Revisa que la placa sea la misma.</span>
    </div>
  );
}

// Aviso automático durante el viaje: el carro se desvió o lleva mucho detenido
const SAFETY_TEXT = { deviation: 'Notamos que el carro se desvió de la ruta.', stopped: 'Notamos que el carro lleva varios minutos detenido.' };
function SafetyCheck({ check, socket, onDone }) {
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState('');
  const answer = (a) => {
    setBusy(true);
    socket.emit('safety:answer', { eventId: check.eventId, answer: a }, () => { setBusy(false); if (a === 'help') setSent('help'); else onDone(); });
  };
  return createPortal(
    <div className="offer-pop safety-pop" role="alertdialog" aria-modal="true" aria-labelledby="safety-title">
      <div className="card">
        <b id="safety-title">{sent ? 'Avisamos al equipo de Ktracho GO' : '¿Todo bien en tu viaje?'}</b>
        {sent ? (
          <>
            <p>El equipo ya sabe dónde está tu viaje y te va a contactar. Si estás en peligro, <a href="tel:911"><b>llama al 911</b></a>.</p>
            <button className="primary" onClick={onDone}>Entendido</button>
          </>
        ) : (
          <>
            <p className="muted">{SAFETY_TEXT[check.kind]} Si no respondes en 2 minutos, avisamos al equipo de Ktracho GO.</p>
            <button className="primary" disabled={busy} onClick={() => answer('ok')}>Sí, todo bien</button>
            <button className="sos" disabled={busy} onClick={() => answer('help')}>🆘 Pedir ayuda</button>
          </>
        )}
      </div>
    </div>,
    document.body
  );
}

// Viaje para otra persona: se le manda el enlace para seguir el viaje por WhatsApp
function RiderShare({ ride, token }) {
  const [err, setErr] = useState('');
  async function send() {
    try {
      const [{ phone }, { token: t }] = await Promise.all([apiGet(`rides/${ride.id}/rider`, token), apiPost(`rides/${ride.id}/share`, token)]);
      const digits = String(phone || '').replace(/\D/g, '');
      const text = `Hola ${ride.rider_name}, te pedí un viaje en Ktracho GO. Síguelo aquí: ${window.location.origin}/t/${t}`;
      window.open(`https://wa.me/${digits.length === 8 ? `504${digits}` : digits}?text=${encodeURIComponent(text)}`, '_blank', 'noopener');
    } catch (e) {
      setErr(e.message);
    }
  }
  return (
    <div className="rider-box">
      <span>Viaje para <b>{ride.rider_name}</b></span>
      <button className="sm whatsapp" onClick={send}>Enviarle el seguimiento por WhatsApp</button>
      {err && <div className="error">{err}</div>}
    </div>
  );
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

const QUICK = ['Ya salgo', 'Dame 2 minutos', 'Estoy en la esquina', '¿Dónde estás?'];

export default function Passenger({ socket, token, userId, perms = [], gender = null }) {
  const { pos, setPos, denied, course } = useGeo();
  const [drivers, setDrivers] = useState([]);
  const [origin, setOrigin] = useState(null); // punto de recogida elegido a mano; null = mi GPS
  const [dest, setDest] = useState(null);
  const [preview, setPreview] = useState(null); // ruta, km, minutos y precio sugerido
  const [previewError, setPreviewError] = useState('');
  const [price, setPrice] = useState('');
  const [category, setCategory] = useState('car'); // moto, carro o carro amplio
  const priceEdited = useRef(false);
  const [ride, setRide] = useState(null);
  const [offers, setOffers] = useState([]);
  const [eta, setEta] = useState(null); // tiempo estimado de llegada del conductor
  const [favs, setFavs] = useState([]); // lugares guardados
  const [recent, setRecent] = useState([]); // destinos recientes (accesos directos)
  const [stops, setStops] = useState([]); // paradas en el camino (hasta 2)
  const [addingStop, setAddingStop] = useState(false);
  const [note, setNote] = useState(''); // punto de referencia para el conductor
  const [forOther, setForOther] = useState(false); // el viaje es para otra persona
  const [rider, setRider] = useState({ name: '', phone: '' });
  const [when, setWhen] = useState(''); // '' = ahora; si no, fecha y hora (datetime-local)
  const [scheduled, setScheduled] = useState([]); // viajes programados
  const [info, setInfo] = useState('');
  const [reporting, setReporting] = useState(false);
  const now = useNow();
  const [driverPos, setDriverPos] = useState(null);
  const [error, setError] = useState('');
  const [compact, setCompact] = useState(false); // en el celular, la hoja de abajo se puede achicar para ver más mapa
  const [renting, setRenting] = useState(false); // pantalla de alquilar un carro por días
  const [safety, setSafety] = useState(null); // «¿Todo bien?» durante el viaje
  const [womenOnly, setWomenOnly] = useState(false); // «Solo conductoras» (para pasajeras)
  useEffect(() => {
    const go = (e) => { if (e.detail === 'rentals' && perms.includes('rent')) setRenting(true); };
    window.addEventListener('ktracho:go', go);
    return () => window.removeEventListener('ktracho:go', go);
  }, [perms]);

  const chat = useChat(socket, ride, userId);
  const active = ride && ['requested', 'accepted', 'arrived', 'started'].includes(ride.status);
  const from = origin || (pos && { ...pos, text: 'Mi ubicación' });
  // Se redondea (~100 m) para no recalcular la ruta por pequeños saltos del GPS
  const fromKey = from && `${from.lat.toFixed(3)},${from.lng.toFixed(3)}`;
  const destKey = dest && `${dest.lat.toFixed(5)},${dest.lng.toFixed(5)}`;
  const stopsKey = stops.map((p) => `${p.lat.toFixed(5)},${p.lng.toFixed(5)}`).join('|');

  const loadFavs = () => apiGet('favorites', token).then(setFavs).catch(() => {});
  useEffect(() => { loadFavs(); }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    socket.on('drivers:nearby', setDrivers);
    socket.on('ride:state', (r) => {
      setRide(r);
      if (r.status !== 'requested') setOffers([]);
      setEta((cur) => (cur && cur.rideId === r.id ? cur : null));
    });
    // Cada oferta vale unos segundos (ttl): se guarda cuándo vence para mostrar la cuenta regresiva
    socket.on('offer:new', (o) => setOffers((cur) => [...cur.filter((x) => x.driver.id !== o.driver.id), { ...o, expiresAt: Date.now() + (o.ttl || 90) * 1000 }]));
    socket.on('offer:expired', ({ offerId }) => setOffers((cur) => cur.filter((x) => x.id !== offerId)));
    socket.on('ride:eta', setEta);
    socket.on('ride:driver_location', setDriverPos);
    // «¿Todo bien?» durante el viaje (y se cierra si respondió desde otro aparato o ya se avisó al equipo)
    socket.on('safety:check', (c) => setSafety(c));
    socket.on('safety:closed', ({ eventId, answer }) => {
      if (answer === 'help') return; // el aviso queda abierto mostrando «Avisamos al equipo»
      setSafety((cur) => (cur?.eventId === eventId ? null : cur));
      setRide((r) => (r?.safetyCheck?.eventId === eventId ? { ...r, safetyCheck: null } : r));
    });
    // El conductor ya no está disponible: se quita su oferta
    socket.on('offer:invalid', ({ offerId }) => {
      setOffers((cur) => cur.filter((x) => x.id !== offerId));
      setError('Ese conductor ya no está disponible. Elige otra oferta.');
    });
    return () => ['drivers:nearby', 'ride:state', 'offer:new', 'offer:expired', 'ride:eta', 'ride:driver_location', 'offer:invalid', 'safety:check', 'safety:closed'].forEach((e) => socket.off(e));
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
    apiGet(`route?from=${from.lat},${from.lng}&to=${dest.lat},${dest.lng}${stopsKey ? `&via=${stopsKey}` : ''}`, token)
      .then((r) => {
        if (stale) return;
        setPreview(r);
        if (!priceEdited.current) setPrice(String(r.prices?.[category] ?? r.suggestedPrice));
      })
      .catch((e) => !stale && setPreviewError(e.message));
    return () => { stale = true; };
  }, [fromKey, destKey, stopsKey, active]); // eslint-disable-line react-hooks/exhaustive-deps

  // Destinos recientes y viajes programados
  const loadScheduled = () => apiGet('rides/scheduled', token).then((r) => setScheduled(r.rides)).catch(() => {});
  useEffect(() => {
    apiGet('rides/recent-destinations', token).then((r) => setRecent(r.places)).catch(() => {});
    loadScheduled();
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  function pickDest(p) {
    priceEdited.current = false;
    setDest({ ...p, text: p.text || 'Destino en el mapa' });
    if (p.text) return;
    // Al tocar el mapa se busca el nombre de la calle o colonia
    apiGet(`reverse?lat=${p.lat}&lng=${p.lng}`, token)
      .then(({ text }) => text && setDest((cur) => (cur && cur.lat === p.lat && cur.lng === p.lng ? { ...cur, text } : cur)))
      .catch(() => {});
  }

  // Guarda el destino elegido con un nombre (Casa, Trabajo…) para tenerlo a un toque la próxima vez
  async function saveFav() {
    const suggestion = !favs.some((f) => f.label === 'Casa') ? 'Casa' : !favs.some((f) => f.label === 'Trabajo') ? 'Trabajo' : '';
    const label = window.prompt('¿Cómo quieres llamar a este lugar?', suggestion);
    if (!label?.trim()) return;
    try {
      await apiPost('favorites', token, { label, text: dest.text, lat: dest.lat, lng: dest.lng });
      loadFavs();
    } catch (e) {
      setError(e.message);
    }
  }

  function request() {
    setError('');
    setInfo('');
    const payload = {
      origin: { lat: from.lat, lng: from.lng, text: from.text }, dest: { lat: dest.lat, lng: dest.lng, text: dest.text }, price: Number(price), category,
      womenOnly: gender === 'f' && womenOnly,
      stops: stops.map((p) => ({ lat: p.lat, lng: p.lng, text: p.text })),
      pickupNote: note.trim() || undefined,
      rider: forOther ? { name: rider.name.trim(), phone: rider.phone.trim() } : undefined,
      scheduledFor: when ? new Date(when).toISOString() : undefined,
    };
    socket.emit('ride:request', payload, (res) => {
      if (res?.error) return setError(res.error);
      if (res?.scheduled) {
        setInfo(`✓ Viaje programado para el ${new Date(res.scheduled.scheduledFor).toLocaleString('es-HN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}. Te avisaremos cuando busquemos conductor.`);
        newTrip();
        loadScheduled();
      }
    });
  }
  async function cancelScheduled(r) {
    if (!window.confirm('¿Cancelar este viaje programado?')) return;
    try { await apiPost(`rides/${r.id}/cancel-scheduled`, token); loadScheduled(); } catch (e) { setError(e.message); }
  }
  // Mínimo y máximo para programar (30 minutos a 7 días), en la hora local del celular
  const localInput = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  const minWhen = localInput(new Date(Date.now() + 31 * 60000));
  const maxWhen = localInput(new Date(Date.now() + 7 * 86400000));

  function newTrip() {
    setRide(null);
    setDest(null);
    setStops([]);
    setAddingStop(false);
    setNote('');
    setForOther(false);
    setRider({ name: '', phone: '' });
    setWhen('');
    setPreview(null);
    setPrice('');
    setDriverPos(null);
    setEta(null);
    priceEdited.current = false;
  }

  const showDrivers = !active || ride?.status === 'requested';
  // Solo cuentan (y se ven) los conductores de la categoría elegida
  const wanted = active ? ride.category || 'car' : category;
  const near = drivers.filter((d) => (d.category || 'car') === wanted);
  // Al cambiar de categoría, el precio pasa al sugerido de esa categoría (si la persona no lo había cambiado a mano)
  const pickCategory = (c) => {
    setCategory(c);
    if (!priceEdited.current && preview?.prices) setPrice(String(preview.prices[c]));
  };
  const liveOffers = offers.filter((o) => o.expiresAt > now);
  // Mientras nadie acepta, se puede subir la oferta: los conductores cercanos ven el precio nuevo
  const raise = (inc) => socket.emit('ride:raise', { rideId: ride.id, price: Number(ride.offered_price) + inc }, (res) => setError(res?.error || ''));
  const routeLine = active ? ride.route : preview?.coords;
  const fitPoints = routeLine?.length > 1 ? routeLine : from && dest && !active ? [[from.lat, from.lng], [dest.lat, dest.lng]] : [];
  const ended = ride && !active;

  return (
    <div className="screen">
      <div className="map">
        {pos && (
          <MapContainer center={[pos.lat, pos.lng]} zoom={15} style={{ height: '100%' }} {...rotateOptions()}>
            <TileLayer url={TILE_URL} attribution={TILE_ATTRIBUTION} />
            <MapControls me={pos} course={course} modeKey="passenger" route={fitPoints.length > 1 ? fitPoints : null} />
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
            {showDrivers && near.map((d) => <CarMarker key={d.id} position={d} />)}
            {(dest || active) && (
              <Marker position={active ? [ride.dest_lat, ride.dest_lng] : [dest.lat, dest.lng]} icon={icons.dest} />
            )}
            {routeLine && <RouteLine positions={routeLine} />}
            {(active ? ride.stops || [] : stops).map((p, i) => <Marker key={`stop-${i}`} position={[p.lat, p.lng]} icon={icons.stop(i + 1)} />)}
            {active && driverPos && ride.status !== 'requested' && <CarMarker position={driverPos} />}
          </MapContainer>
        )}
      </div>

      <div className={`sheet${compact ? ' compact' : ''}`}>
        <Grab compact={compact} setCompact={setCompact} />
        {denied && <div className="hint">Sin GPS: arrastra el pin verde para fijar tu posición, o busca tu dirección.</div>}

        {!active && !ended && (
          <>
            <div className="row between">
              <b>{near.length}{drivers.length >= 25 ? '+' : ''} conductor{near.length === 1 ? '' : 'es'} de {CATEGORY_LABEL[category].toLowerCase()} cerca</b>
              <span className="dot" />
            </div>

            <AddressSearch icon={<i className="dot-o" />} token={token} near={pos} placeholder="¿Dónde te recogemos?" value={origin ? origin.text : 'Mi ubicación'} onPick={setOrigin} />
            {origin && <button className="link left" onClick={() => setOrigin(null)}>📍 Usar mi ubicación</button>}
            {(favs.length > 0 || recent.length > 0) && !dest && (
              <div className="quick">
                {favs.map((f) => <button key={f.id} className="sm" onClick={() => pickDest({ lat: f.lat, lng: f.lng, text: f.text })}>⭐ {f.label}</button>)}
                {recent.filter((r) => !favs.some((f) => Math.abs(f.lat - r.lat) < 1e-4 && Math.abs(f.lng - r.lng) < 1e-4)).map((r) => (
                  <button key={`${r.lat},${r.lng}`} className="sm recent" title={r.text} onClick={() => pickDest(r)}>🕘 {r.text.split(',')[0]}</button>
                ))}
              </div>
            )}
            <AddressSearch icon={<i className="dot-d" />} token={token} near={from} placeholder="¿A dónde vas? (o toca el mapa)" value={dest?.text || ''} onPick={pickDest} />
            {dest && !favs.some((f) => Math.abs(f.lat - dest.lat) < 1e-4 && Math.abs(f.lng - dest.lng) < 1e-4) && (
              <button className="link left" onClick={saveFav}>⭐ Guardar este lugar</button>
            )}

            {dest && (
              <div className="trip-extras">
                {stops.map((p, i) => (
                  <div key={i} className="stop-row">
                    <span className="stop-num">{i + 1}</span>
                    <span className="grow">{p.text || 'Parada en el mapa'}</span>
                    <button className="link" aria-label={`Quitar la parada ${i + 1}`} onClick={() => setStops(stops.filter((_, j) => j !== i))}>✕</button>
                  </div>
                ))}
                {addingStop && <AddressSearch icon={<span className="stop-num">{stops.length + 1}</span>} token={token} near={from} placeholder="¿Dónde es la parada?" value="" onPick={(p) => { setStops([...stops, { ...p, text: p.text || 'Parada' }]); setAddingStop(false); priceEdited.current = false; }} />}
                {stops.length < 2 && !addingStop && <button className="link left" onClick={() => setAddingStop(true)}>+ Agregar parada</button>}
                <input aria-label="Punto de referencia para el conductor" placeholder="Punto de referencia (opcional): frente a la pulpería, portón verde…" maxLength={160} value={note} onChange={(e) => setNote(e.target.value)} />
                <label className="check">
                  <input type="checkbox" checked={forOther} onChange={(e) => setForOther(e.target.checked)} />
                  <span>El viaje es <b>para otra persona</b></span>
                </label>
                {forOther && (
                  <div className="row wrap">
                    <input className="grow" aria-label="Nombre de quien viaja" placeholder="Nombre de quien viaja" maxLength={80} value={rider.name} onChange={(e) => setRider({ ...rider, name: e.target.value })} />
                    <input className="grow" aria-label="Teléfono de quien viaja" placeholder="Su teléfono (8 dígitos)" inputMode="tel" maxLength={15} value={rider.phone} onChange={(e) => setRider({ ...rider, phone: e.target.value })} />
                  </div>
                )}
                <div className="seg when-seg" role="radiogroup" aria-label="¿Cuándo?">
                  <button type="button" role="radio" aria-checked={!when} className={!when ? 'on' : ''} onClick={() => setWhen('')}>Ahora</button>
                  <button type="button" role="radio" aria-checked={!!when} className={when ? 'on' : ''} onClick={() => setWhen(when || minWhen)}>🗓 Programar</button>
                </div>
                {when && <input type="datetime-local" aria-label="Fecha y hora del viaje" min={minWhen} max={maxWhen} value={when} onChange={(e) => setWhen(e.target.value)} />}
              </div>
            )}
            {info && <div className="hint ok" role="status">{info}</div>}
            {scheduled.length > 0 && !dest && (
              <div className="req scheduled-list">
                <b>🗓 Tus viajes programados</b>
                {scheduled.map((r) => (
                  <div key={r.id} className="row between">
                    <span className="small"><b>{new Date(r.scheduled_for).toLocaleString('es-HN', { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}</b> · {r.dest_text || 'Destino'} · {lempiras(r.offered_price)}</span>
                    <button className="sm" onClick={() => cancelScheduled(r)}>Cancelar</button>
                  </div>
                ))}
              </div>
            )}
            {!dest && perms.includes('rent') && <button className="link left" onClick={() => setRenting(true)}>¿Necesitas un carro todo el día? Alquila uno con conductor</button>}
            {dest && !preview && !previewError && <div className="pulse">Calculando ruta…</div>}
            {previewError && <div className="error">{previewError}</div>}
            {dest && preview && (
              <>
                <div className="row between">
                  <span className="muted">{preview.distanceKm.toFixed(1)} km · {minutes(preview.durationMin)}{preview.estimated && ' (estimado)'}</span>
                  <span className="muted">Sugerido <b>{lempiras(preview.prices?.[category] ?? preview.suggestedPrice)}</b></span>
                </div>
                <div className="cats" role="radiogroup" aria-label="Tipo de vehículo">
                  {CATEGORIES.map(([k, label]) => (
                    <button type="button" key={k} role="radio" aria-checked={category === k} className={category === k ? 'on' : ''} onClick={() => pickCategory(k)}>
                      <span>{label}</span>
                      <b>{lempiras(preview.prices?.[k] ?? preview.suggestedPrice)}</b>
                    </button>
                  ))}
                </div>
                {gender === 'f' && (
                  <label className="check women-only">
                    <input type="checkbox" checked={womenOnly} onChange={(e) => setWomenOnly(e.target.checked)} />
                    <span><b>🚺 Solo conductoras</b> · {near.filter((d) => d.woman).length} cerca. Solo te ofrecerán viaje conductoras confirmadas por el equipo.</span>
                  </label>
                )}
                <PriceStepper value={price} label="Tu oferta en lempiras" onChange={(v) => { priceEdited.current = true; setPrice(v); }} />
                {error && <div className="error">{error}</div>}
                <button className="primary" disabled={!price} onClick={request}>{when ? 'Programar viaje por' : 'Pedir viaje por'} {lempiras(price || 0)}</button>
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
              {CATEGORY_LABEL[ride.category || 'car']}{ride.women_only ? ' · 🚺 Solo conductoras' : ''} · {ride.dest_text || 'Destino'} · {ride.distance_km.toFixed(1)} km{ride.duration_min ? ` · ${minutes(ride.duration_min)}` : ''}
            </p>
            {eta && eta.rideId === ride.id && ['accepted', 'started'].includes(ride.status) && (
              <p className="eta">
                {ride.status === 'accepted' ? '🚕 Tu conductor llega en' : '🏁 Llegan a tu destino en'} <b>~{eta.minutes} min</b>{' '}
                <span className="muted">({eta.km} km{eta.estimated ? ', aproximado' : ''})</span>
              </p>
            )}

            {['accepted', 'arrived'].includes(ride.status) && ride.pinRequired && <TripPin ride={ride} token={token} />}
            {ride.rider_name && ride.status !== 'requested' && <RiderShare ride={ride} token={token} />}
            {ride.stops?.length > 0 && <p className="muted small">Paradas: {ride.stops.map((p, i) => `${i + 1}. ${p.text || 'en el mapa'}`).join(' · ')}</p>}

            {ride.status === 'requested' && (
              <>
                <p className="muted">Ofreciste {lempiras(ride.offered_price)}. Elige una oferta cuando lleguen:</p>
                {error && <div className="error">{error}</div>}
                {liveOffers.length === 0 && <div className="pulse">Esperando ofertas de conductores…</div>}
                {liveOffers.length === 0 && now - new Date(ride.created_at).getTime() > 40000 && (
                  <div className="hint">Nadie ha ofertado todavía. Prueba subir tu precio para atraer conductores.</div>
                )}
                <div className="raise">
                  <span className="muted small">¿Nadie acepta? Sube tu oferta:</span>
                  <div className="row">
                    <button className="sm" onClick={() => raise(5)}>+ L5</button>
                    <button className="sm" onClick={() => raise(10)}>+ L10</button>
                  </div>
                </div>
                {liveOffers.map((o) => (
                  <div className="offer" key={o.id}>
                    <Avatar name={o.driver.name} />
                    <div className="who">
                      <span><b>{o.driver.name}</b> <Stars rating={o.driver.rating} /></span>
                      <span className="muted small">{o.driver.vehicle} · {o.driver.plate}{o.distanceToPickupKm != null && ` · a ${o.distanceToPickupKm.toFixed(1)} km`}</span>
                    </div>
                    <TimeRing left={(o.expiresAt - now) / 1000} total={o.ttl || 90} />
                    <button className="primary sm" aria-label={`Aceptar a ${o.driver.name} por ${lempiras(o.price)}`} onClick={() => socket.emit('offer:accept', { offerId: o.id })}>Aceptar · {lempiras(o.price)}</button>
                  </div>
                ))}
              </>
            )}

            {ride.driver && (
              <div className="offer">
                <Avatar name={ride.driver.name} />
                <div className="who">
                  <span><b>{ride.driver.name}</b> <Stars rating={ride.driver.rating} /></span>
                  <span className="muted small">{ride.driver.vehicle} · {ride.driver.plate}</span>
                </div>
                <div className="row">
                  {ride.driver.phone && <a className="sm" href={`tel:${ride.driver.phone}`}>Llamar</a>}
                  <button className="primary sm" onClick={chat.open ? chat.closeChat : chat.openChat}>💬 Chat{chat.unread ? ` (${chat.unread})` : ''}</button>
                </div>
              </div>
            )}
            {chat.open && <Chat chat={chat} meId={userId} quick={QUICK} />}

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
                {ride.driver && <Rate token={token} rideId={ride.id} who={ride.driver.name} title="¡Llegaste!" />}
                {chat.chatable && !chat.closed && (
                  <button onClick={chat.open ? chat.closeChat : chat.openChat}>💬 ¿Olvidaste algo? Escribe al conductor{chat.unread ? ` (${chat.unread})` : ''}</button>
                )}
                {chat.open && <Chat chat={chat} meId={userId} quick={['Creo que dejé algo en tu carro']} />}
              </>
            )}
            {ride.driver && <button onClick={() => setReporting(true)}>⚠ Reportar un problema con este viaje</button>}
            <button className="primary" onClick={newTrip}>Nuevo viaje</button>
            {reporting && <ReportForm rideId={ride.id} token={token} onClose={() => setReporting(false)} />}
          </>
        )}
      </div>
      {renting && <Rentals token={token} socket={socket} onClose={() => setRenting(false)} />}
      {(safety || ride?.safetyCheck) && ride?.status === 'started' && <SafetyCheck key={(safety || ride.safetyCheck).eventId} check={safety || ride.safetyCheck} socket={socket} onDone={() => { setSafety(null); setRide((r) => (r ? { ...r, safetyCheck: null } : r)); }} />}
    </div>
  );
}
