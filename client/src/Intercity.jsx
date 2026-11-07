import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, lempiras, minutes, wazeUrl } from './lib.js';
import { AddressSearch, Empty, Loading, PriceStepper, Stars } from './components.jsx';
import { Panel } from './Menu.jsx';
import { PayMethodPicker, payLabel } from './payMethods.jsx';

// Viajes entre ciudades (etapa 1: viaje privado).
// Pasajero: publica su viaje con fecha, personas y precio; recibe ofertas (tarifa y hora) y elige una.
// Conductor: ve los viajes publicados, acepta la tarifa u ofrece otra tarifa y hora, y ve sus reservas.

const WHEN = { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' };
export const tripWhen = (d) => {
  const t = new Date(d);
  const days = Math.round((new Date(t).setHours(0, 0, 0, 0) - new Date().setHours(0, 0, 0, 0)) / 864e5);
  const hour = t.toLocaleTimeString('es-HN', { hour: 'numeric', minute: '2-digit' });
  if (days === 0) return `Hoy, ${hour}`;
  if (days === 1) return `Mañana, ${hour}`;
  return t.toLocaleString('es-HN', WHEN);
};
// Fecha y hora local para <input type="datetime-local">
const localInput = (d) => {
  const t = new Date(d);
  return new Date(t.getTime() - t.getTimezoneOffset() * 6e4).toISOString().slice(0, 16);
};
const people = (n) => `${n} pasajero${n === 1 ? '' : 's'}`;

function Route({ origin, dest }) {
  return (
    <ul className="ic-route">
      <li><i className="ic-pt a">A</i><span>{origin}</span></li>
      <li><i className="ic-pt b">B</i><span>{dest}</span></li>
    </ul>
  );
}

function Tags({ t }) {
  return (
    <div className="ic-tags">
      <span className="ic-tag private">Viaje privado</span>
      <span className="ic-tag">{payLabel(t.payMethod).icon} Paga en {payLabel(t.payMethod).label.toLowerCase()}</span>
      {t.luggage && <span className="ic-tag">🧳 Con maletas</span>}
      {t.womenOnly && <span className="ic-tag women">🚺 Solo conductoras</span>}
    </div>
  );
}

// ---------- Pasajero ----------
function NewTrip({ token, pos, gender, onDone }) {
  const [origin, setOrigin] = useState(pos ? { ...pos, text: 'Mi ubicación' } : null);
  const [dest, setDest] = useState(null);
  const [asap, setAsap] = useState(false);
  const [at, setAt] = useState(() => { const t = new Date(Date.now() + 864e5); t.setHours(6, 0, 0, 0); return localInput(t); });
  const [seats, setSeats] = useState(1);
  const [luggage, setLuggage] = useState(false);
  const [womenOnly, setWomenOnly] = useState(false);
  const [payMethod, setPayMethod] = useState('cash'); // cómo va a pagar (hoy solo efectivo)
  const [note, setNote] = useState('');
  const [quote, setQuote] = useState(null);
  const [price, setPrice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setQuote(null);
    setError('');
    if (!origin || !dest) return;
    let live = true;
    apiPost('intercity/quote', token, { origin, dest })
      .then((q) => { if (live) { setQuote(q); setPrice(String(q.price)); } })
      .catch((e) => live && setError(e.message));
    return () => { live = false; };
  }, [origin, dest, token]);

  async function publish() {
    setBusy(true);
    setError('');
    try {
      await apiPost('intercity', token, {
        origin, dest, departAt: asap ? null : new Date(at).toISOString(), seats, luggage, womenOnly: gender === 'f' && womenOnly, note, price: Number(price), payMethod,
      });
      onDone();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="ic-form" aria-label="Publicar un viaje entre ciudades">
      <AddressSearch icon={<i className="dot-o" />} token={token} near={pos} placeholder="¿Desde dónde sales?" value={origin?.text || ''} onPick={setOrigin} />
      {pos && origin?.text !== 'Mi ubicación' && <button className="link left" onClick={() => setOrigin({ ...pos, text: 'Mi ubicación' })}>📍 Salir desde mi ubicación</button>}
      <AddressSearch icon={<i className="dot-d" />} token={token} near={pos} placeholder="¿A qué ciudad vas?" value={dest?.text || ''} onPick={setDest} />

      <div className="seg" role="radiogroup" aria-label="Salida">
        <button type="button" role="radio" aria-checked={!asap} className={!asap ? 'on' : ''} onClick={() => setAsap(false)}>📅 Fecha y hora</button>
        <button type="button" role="radio" aria-checked={asap} className={asap ? 'on' : ''} onClick={() => setAsap(true)}>⚡ Lo antes posible</button>
      </div>
      {!asap && (
        <label>Salida
          <input type="datetime-local" value={at} min={localInput(Date.now() + 30 * 6e4)} max={localInput(Date.now() + 14 * 864e5)} onChange={(e) => setAt(e.target.value)} />
        </label>
      )}
      <div className="row between ic-seats">
        <span><b>¿Cuántos viajan?</b>{seats > 4 && <span className="muted small"> · carro amplio</span>}</span>
        <div className="stepper">
          <button type="button" aria-label="Una persona menos" disabled={seats <= 1} onClick={() => setSeats(seats - 1)}>−</button>
          <b aria-live="polite">{seats}</b>
          <button type="button" aria-label="Una persona más" disabled={seats >= 6} onClick={() => setSeats(seats + 1)}>+</button>
        </div>
      </div>
      <label className="check switch-line">
        <span>🧳 Llevo maletas</span>
        <input type="checkbox" role="switch" className="switch" checked={luggage} onChange={(e) => setLuggage(e.target.checked)} />
      </label>
      {gender === 'f' && (
        <label className="check switch-line">
          <span>🚺 Solo conductoras</span>
          <input type="checkbox" role="switch" className="switch" checked={womenOnly} onChange={(e) => setWomenOnly(e.target.checked)} />
        </label>
      )}
      <input aria-label="Nota para el conductor" placeholder="Nota (opcional): dónde te recogen, si llevas mascota…" maxLength={160} value={note} onChange={(e) => setNote(e.target.value)} />

      {origin && dest && !quote && !error && <div className="pulse">Calculando la ruta…</div>}
      {quote && (
        <div className="ic-quote">
          <p className="muted small">{quote.distanceKm.toFixed(0)} km · unas {minutes(quote.durationMin)} de camino{quote.estimated && ' (estimado)'} · precio sugerido <b>{lempiras(quote.price)}</b></p>
          <PriceStepper value={price} onChange={setPrice} step={50} min={50} label="Lo que ofreces por el viaje" />
          <p className="muted small">Es por el carro entero (viaje privado), en efectivo al terminar. Los conductores pueden aceptar tu precio o proponerte otro.</p>
        </div>
      )}
      <PayMethodPicker value={payMethod} onChange={setPayMethod} />
      {error && <div className="error" role="alert">{error}</div>}
      <button className="primary" disabled={!quote || busy || !(Number(price) > 0)} onClick={publish}>{busy ? 'Publicando…' : 'Publicar mi viaje'}</button>
    </section>
  );
}

function MyTrip({ t, token, onChange }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(path, body) {
    setBusy(true);
    setError('');
    try { await apiPost(path, token, body); onChange(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  const cancel = () => window.confirm(t.status === 'booked' ? 'Ya tienes conductor. ¿Seguro que quieres cancelar el viaje?' : '¿Cancelar este viaje?') && act(`intercity/${t.id}/cancel`);
  return (
    <article className="ic-card mine">
      <div className="row between">
        <b className="ic-price">{lempiras(t.finalPrice ?? t.price)} <span className="muted">· {people(t.seats)}</span></b>
        <span className={`pill ${t.status === 'booked' ? 'ride-accepted' : 'ride-requested'}`}>{t.status === 'booked' ? 'Reservado' : 'Buscando conductor'}</span>
      </div>
      <b className="ic-when">{t.asap ? '⚡ Lo antes posible' : `📅 ${tripWhen(t.departAt)}`}</b>
      <Route origin={t.origin} dest={t.dest} />
      {t.status === 'booked' && t.driver && (
        <div className="ic-driver">
          <span><b>{t.driver.name}</b> <Stars rating={t.driver.rating} /></span>
          <span className="muted small">{[t.driver.vehicle, t.driver.plate].filter(Boolean).join(' · ')}</span>
          <span className="muted small">Te recordamos el viaje antes de la salida. 30 minutos antes lo verás venir en el mapa.</span>
        </div>
      )}
      {t.status === 'board' && (
        t.offers.length === 0
          ? <p className="pulse small">Esperando ofertas de conductores…</p>
          : (
            <ul className="ic-offers" aria-label="Ofertas">
              {t.offers.map((o) => (
                <li key={o.id}>
                  <span className="grow">
                    <b>{o.driver.name}</b> <Stars rating={o.driver.rating} />
                    <span className="muted small">{o.driver.vehicle || 'Vehículo registrado'} · sale {tripWhen(o.departAt)}</span>
                  </span>
                  <span className="ic-offer-side">
                    <b>{lempiras(o.price)}</b>
                    <button className="primary sm" disabled={busy} onClick={() => act(`intercity/${t.id}/accept`, { offerId: o.id })}>Elegir</button>
                  </span>
                </li>
              ))}
            </ul>
          )
      )}
      {error && <div className="error">{error}</div>}
      <button className="link left danger" disabled={busy} onClick={cancel}>Cancelar viaje</button>
    </article>
  );
}

export default function Intercity({ token, socket, pos, gender, onClose }) {
  const [trips, setTrips] = useState(null);
  const [tab, setTab] = useState('new');
  const [error, setError] = useState('');
  const load = useCallback(() => apiGet('intercity/mine', token).then((d) => { setTrips(d.trips); return d.trips; }).catch((e) => setError(e.message)), [token]);
  useEffect(() => { load().then((t) => { if (t?.length) setTab('mine'); }); }, [load]);
  useEffect(() => {
    if (!socket) return;
    socket.on('intercity:update', load);
    return () => socket.off('intercity:update', load);
  }, [socket, load]);
  const offers = (trips || []).reduce((n, t) => n + t.offers.length, 0);

  return (
    <Panel onClose={onClose} labelledBy="ic-title" className="ic-panel">
      <div className="overlay-head">
        <b id="ic-title">🛣 Viajes entre ciudades</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        <div className="seg tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'new'} className={tab === 'new' ? 'on' : ''} onClick={() => setTab('new')}>Nuevo viaje</button>
          <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'on' : ''} onClick={() => setTab('mine')}>
            Mis viajes{trips?.length ? ` (${trips.length})` : ''}{offers > 0 && <span className="ic-badge" aria-label={`${offers} ofertas`}>{offers}</span>}
          </button>
        </div>
        {error && <div className="error">{error}</div>}
        {tab === 'new' && (
          <>
            <p className="muted small">Publica tu viaje a otra ciudad: los conductores que van para allá te ofrecen tarifa y hora, y tú eliges.</p>
            <NewTrip token={token} pos={pos} gender={gender} onDone={() => { load(); setTab('mine'); }} />
          </>
        )}
        {tab === 'mine' && (
          <>
            {!trips && !error && <Loading />}
            {trips?.length === 0 && <Empty title="No tienes viajes entre ciudades">Publica uno en «Nuevo viaje» y te llegan ofertas de conductores.</Empty>}
            {trips?.map((t) => <MyTrip key={t.id} t={t} token={token} onChange={load} />)}
          </>
        )}
      </div>
    </Panel>
  );
}

// ---------- Conductor ----------
function BoardTrip({ t, token, onChange }) {
  const [offering, setOffering] = useState(false);
  const [price, setPrice] = useState(String(t.myOffer?.price ?? t.price));
  const [at, setAt] = useState(localInput(t.myOffer?.departAt || t.departAt || Date.now() + 60 * 6e4));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function send(body) {
    setBusy(true);
    setError('');
    try { await apiPost(`intercity/${t.id}/offer`, token, body); setOffering(false); onChange(); } catch (e) { setError(e.message); } finally { setBusy(false); }
  }
  async function withdraw() {
    setBusy(true);
    try { await apiPost(`intercity/${t.id}/offer/withdraw`, token); onChange(); } finally { setBusy(false); }
  }
  const leave = t.asap ? 'lo antes posible' : tripWhen(t.departAt);
  return (
    <article className="ic-card">
      <div className="row between">
        <b className="ic-price">{lempiras(t.price)} <span className="muted">para {people(t.seats)}</span></b>
        {t.awayKm != null && <span className="muted small">a {t.awayKm < 1 ? '<1' : Math.round(t.awayKm)} km de ti</span>}
      </div>
      <Tags t={t} />
      <b className="ic-when">{t.asap ? '⚡ Lo antes posible' : `📅 ${tripWhen(t.departAt)}`}</b>
      <Route origin={t.origin} dest={t.dest} />
      <p className="muted small">{Math.round(t.distanceKm)} km · unas {minutes(t.durationMin)} de camino{t.note && <> · «{t.note}»</>}</p>
      <p className="small"><b>{t.passenger.name}</b> <Stars rating={t.passenger.rating} /></p>
      {t.myOffer && !offering ? (
        <div className="ic-myoffer">
          <span>Tu oferta: <b>{lempiras(t.myOffer.price)}</b> · sale {tripWhen(t.myOffer.departAt)}. Esperando a que el pasajero elija.</span>
          <div className="row">
            <button className="sm" disabled={busy} onClick={() => setOffering(true)}>Cambiar</button>
            <button className="sm" disabled={busy} onClick={withdraw}>Retirar</button>
          </div>
        </div>
      ) : offering ? (
        <div className="ic-offer-form">
          <PriceStepper value={price} onChange={setPrice} step={50} min={50} label="Tu tarifa" />
          <label>Hora de salida
            <input type="datetime-local" value={at} min={localInput(Date.now() + 10 * 6e4)} onChange={(e) => setAt(e.target.value)} />
          </label>
          <div className="row">
            <button className="grow" disabled={busy} onClick={() => setOffering(false)}>Volver</button>
            <button className="primary grow" disabled={busy || !(Number(price) > 0)} onClick={() => send({ price: Number(price), departAt: new Date(at).toISOString() })}>Enviar oferta</button>
          </div>
        </div>
      ) : (
        <div className="ic-actions">
          <button className="primary ic-accept" disabled={busy} onClick={() => send({})}>
            Aceptar tarifa<span>{lempiras(t.price)} · sale {leave}</span>
          </button>
          <button disabled={busy} onClick={() => setOffering(true)}>Ofrecer tarifa y hora</button>
        </div>
      )}
      {error && <div className="error">{error}</div>}
    </article>
  );
}

function BookedTrip({ t, token, onChange }) {
  const [busy, setBusy] = useState(false);
  async function release() {
    if (!window.confirm('El viaje vuelve a publicarse para que otro conductor lo tome y se le avisa al pasajero. ¿Seguro?')) return;
    setBusy(true);
    try { await apiPost(`intercity/${t.id}/release`, token); onChange(); } finally { setBusy(false); }
  }
  return (
    <article className="ic-card mine">
      <div className="row between">
        <b className="ic-price">{lempiras(t.price)} <span className="muted">· {people(t.seats)}</span></b>
        <span className="pill ride-accepted">Reservado</span>
      </div>
      <b className="ic-when">📅 {tripWhen(t.departAt)}</b>
      <Route origin={t.origin} dest={t.dest} />
      <p className="small">Recoges a <b>{t.passenger.name}</b>{t.luggage && ' · lleva maletas'}{t.note && <> · «{t.note}»</>}</p>
      <p className="muted small">30 minutos antes de la salida el viaje aparece en tu pantalla como un viaje normal (con chat, PIN y botón de emergencia).</p>
      <div className="row">
        <a className="sm grow" href={wazeUrl(t.originPoint)} target="_blank" rel="noreferrer">Ver el punto de salida</a>
        <button className="sm grow" disabled={busy} onClick={release}>Ya no puedo</button>
      </div>
    </article>
  );
}

export function IntercityBoard({ token, socket, pos, onClose }) {
  const [tab, setTab] = useState('board');
  const [board, setBoard] = useState(null);
  const [booked, setBooked] = useState([]);
  const [error, setError] = useState('');
  const load = useCallback(() => {
    const at = pos ? `?lat=${pos.lat}&lng=${pos.lng}` : '';
    apiGet(`intercity/board${at}`, token).then((d) => setBoard(d.trips)).catch((e) => setError(e.message));
    apiGet('intercity/booked', token).then((d) => setBooked(d.trips)).catch(() => {});
  }, [token, pos?.lat, pos?.lng]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { load(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!socket) return;
    socket.on('intercity:update', load);
    socket.on('intercity:new', load);
    return () => { socket.off('intercity:update', load); socket.off('intercity:new', load); };
  }, [socket, load]);

  return (
    <Panel onClose={onClose} labelledBy="icb-title" className="ic-panel">
      <div className="overlay-head">
        <b id="icb-title">🛣 Viajes entre ciudades</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        <div className="seg tabs" role="tablist">
          <button role="tab" aria-selected={tab === 'board'} className={tab === 'board' ? 'on' : ''} onClick={() => setTab('board')}>Disponibles{board?.length ? ` (${board.length})` : ''}</button>
          <button role="tab" aria-selected={tab === 'booked'} className={tab === 'booked' ? 'on' : ''} onClick={() => setTab('booked')}>Mis reservas{booked.length ? ` (${booked.length})` : ''}</button>
        </div>
        {error && <div className="error">{error}</div>}
        {tab === 'board' && (
          <>
            {!board && !error && <Loading />}
            {board?.length === 0 && <Empty title="No hay viajes publicados ahora">Cuando un pasajero publique un viaje a otra ciudad te avisamos.</Empty>}
            {board?.map((t) => <BoardTrip key={`${t.id}-${t.myOffer?.price ?? ''}`} t={t} token={token} onChange={load} />)}
          </>
        )}
        {tab === 'booked' && (
          <>
            {booked.length === 0 && <Empty title="No tienes viajes reservados">Cuando un pasajero elija tu oferta, aparece aquí.</Empty>}
            {booked.map((t) => <BookedTrip key={t.id} t={t} token={token} onChange={load} />)}
          </>
        )}
        <p className="muted small">La comisión de Ktracho GO se descuenta de tu saldo al terminar el viaje, como en los viajes de la ciudad.</p>
      </div>
    </Panel>
  );
}
