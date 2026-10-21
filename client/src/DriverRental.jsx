import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, apiPut, lempiras, RENTAL_STATUS, RENTAL_PILL, PAYMENT_LABEL, PAYMENT_STATUS, vehicleText, dateHN, todayHN } from './lib.js';
import { Empty, Loading } from './components.jsx';

// Conductor: ofrecer su carro (con él como conductor) por días y atender las reservas
export default function DriverRental({ token, socket, onClose }) {
  const [data, setData] = useState(null);
  const [price, setPrice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');

  const load = useCallback(() => apiGet('driver/rental', token).then((d) => {
    setData(d);
    setPrice((cur) => cur || String(d.listing?.price || d.price.min));
  }).catch((e) => setError(e.message)), [token]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    if (!socket) return;
    socket.on('rental:update', load);
    return () => socket.off('rental:update', load);
  }, [socket, load]);

  async function run(fn, ok) {
    setBusy(true);
    setError('');
    setMsg('');
    try {
      await fn();
      if (ok) setMsg(ok);
      await load();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  const offer = (active) => run(() => apiPut('driver/rental', token, { active, price: Number(price) }), active ? 'Tu carro está publicado para alquiler.' : 'Tu carro ya no aparece para alquiler.');
  const act = (b, what, body) => run(() => apiPost(`driver/rentals/${b.id}/${what}`, token, body));
  const reject = (b) => {
    const note = window.prompt('¿Por qué no puedes? El pasajero lo verá (opcional):', '');
    if (note !== null) act(b, 'decide', { accept: false, note });
  };

  const body = () => {
    if (!data) return error ? <div className="error">{error}</div> : <Loading />;
    if (!data.enabled) return <Empty title="El alquiler de carros no está activo">Cuando el equipo lo active, podrás ofrecer tu carro por días.</Empty>;
    const today = todayHN();
    const listed = data.listing?.active;
    return (
      <>
        <div className="req">
          <b>Ofrece tu carro por días, contigo como conductor</b>
          {data.vehicle ? <div className="muted">{vehicleText(data.vehicle)} · placa {data.vehicle.plate}</div> : <div className="hint">Primero registra tu vehículo: pídelo a soporte.</div>}
          <label>Precio por día (de {lempiras(data.price.min)} a {lempiras(data.price.max)})
            <input inputMode="numeric" value={price} onChange={(e) => setPrice(e.target.value.replace(/\D/g, ''))} />
          </label>
          <p className="muted small">El pasajero paga en efectivo al empezar o por transferencia a Ktracho GO. Si el alquiler se paga en efectivo, Ktracho GO te descuenta su comisión del saldo; si se paga por transferencia, te acreditamos el total menos la comisión. Mientras dura un alquiler no recibes viajes.</p>
          <div className="row">
            <button className="primary grow" disabled={busy || !data.vehicle} onClick={() => offer(true)}>{listed ? 'Guardar precio' : 'Publicar mi carro'}</button>
            {listed && <button disabled={busy} onClick={() => offer(false)}>Dejar de ofrecer</button>}
          </div>
          {listed && <div className="hint ok">Publicado a {lempiras(data.listing.price)} por día.</div>}
        </div>

        {msg && <div className="hint ok">{msg}</div>}
        {error && <div className="error">{error}</div>}

        <b>Reservas de tu carro</b>
        {data.bookings.length === 0 && <Empty title="Todavía no tienes reservas" />}
        {data.bookings.map((b) => (
          <div className="req" key={b.id}>
            <div className="row between">
              <b>{b.renter_name}</b>
              <span className="tag">{lempiras(b.total)}</span>
            </div>
            <div className="row wrap">
              <span className={`pill ${RENTAL_PILL[b.status]}`}>{RENTAL_STATUS[b.status]}</span>
              <span className="muted small">{dateHN(b.start_date)}{b.days > 1 ? ` al ${dateHN(b.end_date)}` : ''} · {b.days} día{b.days > 1 ? 's' : ''} · {PAYMENT_LABEL[b.payment]}</span>
            </div>
            {b.pickup_text && <div className="muted small">Recoger en: {b.pickup_text}</div>}
            {b.note && <div className="muted small">Nota: {b.note}</div>}
            {b.renter_phone && <div className="muted small">Teléfono: <a href={`tel:${b.renter_phone}`}>{b.renter_phone}</a></div>}
            {b.payment === 'transfer' && ['requested', 'confirmed'].includes(b.status) && <div className={b.payment_status === 'approved' ? 'hint ok' : 'hint'}>{PAYMENT_STATUS[b.payment_status]}</div>}
            <div className="row wrap">
              {b.status === 'requested' && (
                <>
                  <button className="primary sm" disabled={busy} onClick={() => act(b, 'decide', { accept: true })}>Aceptar</button>
                  <button className="sm" disabled={busy} onClick={() => reject(b)}>No puedo</button>
                </>
              )}
              {b.status === 'confirmed' && b.start_date <= today && (b.payment === 'cash' || b.payment_status === 'approved') && (
                <button className="primary sm" disabled={busy} onClick={() => window.confirm(b.payment === 'cash' ? `¿Recibiste ${lempiras(b.total)} en efectivo? Al iniciar, no recibirás viajes hasta terminar.` : '¿Iniciar el alquiler? No recibirás viajes hasta terminarlo.') && act(b, 'start')}>
                  {b.payment === 'cash' ? 'Cobré y empecé' : 'Empezar'}
                </button>
              )}
              {b.status === 'confirmed' && b.start_date > today && <span className="muted small">Empieza el {dateHN(b.start_date)}.</span>}
              {b.status === 'active' && <button className="primary sm" disabled={busy} onClick={() => window.confirm('¿Terminar el alquiler?') && act(b, 'finish')}>Terminar alquiler</button>}
              {b.status === 'confirmed' && <button className="danger sm" disabled={busy} onClick={() => window.confirm('¿Cancelar esta reserva? El pasajero recibirá un aviso.') && act(b, 'cancel')}>Cancelar</button>}
            </div>
          </div>
        ))}
      </>
    );
  };

  return (
    <div className="overlay">
      <div className="overlay-head">
        <b>Alquiler de mi carro</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">{body()}</div>
    </div>
  );
}
