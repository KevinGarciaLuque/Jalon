import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, lempiras, toJpeg, RENTAL_STATUS, RENTAL_PILL, PAYMENT_LABEL, PAYMENT_STATUS, vehicleText, dateHN, todayHN } from './lib.js';
import { Empty, Loading } from './components.jsx';

const addDays = (d, n) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);

// Comprobante de la transferencia de un alquiler: datos de la cuenta de Ktracho GO y el formulario para subirlo
function TransferProof({ booking, bank, token, onDone }) {
  const [f, setF] = useState({ bank: '', reference: '' });
  const [file, setFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function submit(e) {
    e.preventDefault();
    if (!file) return setError('Elige la foto o captura del comprobante');
    setBusy(true);
    setError('');
    try {
      await apiPost(`rentals/${booking.id}/receipt`, token, { ...f, image: await toJpeg(file) });
      onDone();
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <form className="req" onSubmit={submit}>
      <b>Transfiere {lempiras(booking.total)} a la cuenta de Ktracho GO</b>
      <div className="bank">
        <div><span className="muted">Banco</span> <b>{bank.name}</b></div>
        {bank.type && <div><span className="muted">Tipo</span> <b>{bank.type}</b></div>}
        <div><span className="muted">Cuenta</span> <b>{bank.account}</b></div>
        <div><span className="muted">A nombre de</span> <b>{bank.holder}</b></div>
        {bank.note && <div className="muted small">{bank.note}</div>}
      </div>
      <input aria-label="Banco desde el que transferiste" placeholder="Banco desde el que transferiste" value={f.bank} onChange={(e) => setF({ ...f, bank: e.target.value })} required />
      <input aria-label="Número de referencia" placeholder="Número de referencia o de transacción" value={f.reference} onChange={(e) => setF({ ...f, reference: e.target.value })} required />
      <label className={`upload ${busy ? 'disabled' : ''}`}>
        {file ? `✓ ${file.name}` : 'Foto o captura del comprobante'}
        <input type="file" accept="image/*" disabled={busy} onChange={(e) => setFile(e.target.files[0] || null)} />
      </label>
      {error && <div className="error">{error}</div>}
      <button className="primary" disabled={busy}>{busy ? 'Enviando…' : 'Enviar comprobante'}</button>
      <p className="muted small">El equipo lo revisa; el alquiler empieza cuando el pago está aprobado.</p>
    </form>
  );
}

// Pasajero: buscar un carro por fechas, reservarlo y seguir sus alquileres
export default function Rentals({ token, socket, onClose }) {
  const today = todayHN();
  const [q, setQ] = useState({ start: addDays(today, 1), days: '1' });
  const [found, setFound] = useState(null); // resultado de la búsqueda
  const [info, setInfo] = useState(null); // si está activo, días máximos, anticipación y si hay transferencia
  const [pick, setPick] = useState(null); // carro elegido para reservar
  const [form, setForm] = useState({ payment: 'cash', pickup: '', note: '' });
  const [mine, setMine] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState('');
  const [proof, setProof] = useState(null); // reserva a la que se le sube el comprobante

  const loadMine = useCallback(() => apiGet('rentals/mine', token).then(setMine).catch((e) => setError(e.message)), [token]);
  useEffect(() => {
    apiGet('rentals/search', token).then(setInfo).catch((e) => setError(e.message));
    loadMine();
  }, [token, loadMine]);
  // Cuando el conductor (o el equipo) responde, la lista se actualiza sola
  useEffect(() => {
    if (!socket) return;
    socket.on('rental:update', loadMine);
    return () => socket.off('rental:update', loadMine);
  }, [socket, loadMine]);

  async function search(e) {
    e?.preventDefault();
    setError('');
    setPick(null);
    setBusy(true);
    try {
      setFound(await apiGet(`rentals/search?start=${q.start}&days=${q.days}`, token));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  async function book(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await apiPost('rentals', token, { listingId: pick.listingId, start: found.start, days: found.days, ...form });
      setMsg(form.payment === 'transfer'
        ? 'Listo: pediste el alquiler. Cuando lo confirmen, sube aquí el comprobante de tu transferencia.'
        : 'Listo: pediste el alquiler. Te avisaremos cuando lo confirmen.');
      setPick(null);
      setFound(null);
      loadMine();
    } catch (err) {
      setError(err.message);
      if (/reservado/.test(err.message)) search();
    } finally {
      setBusy(false);
    }
  }

  async function cancel(b) {
    if (!window.confirm('¿Cancelar este alquiler?')) return;
    try { await apiPost(`rentals/${b.id}/cancel`, token); loadMine(); } catch (err) { setError(err.message); }
  }

  if (!info) return <Overlay onClose={onClose}>{error ? <div className="error">{error}</div> : <Loading />}</Overlay>;
  const maxStart = addDays(today, info.advanceDays);

  return (
    <Overlay onClose={onClose}>
      {!info.enabled && <Empty title="El alquiler de carros no está disponible por ahora">Pronto podrás alquilar un carro con conductor por días.</Empty>}
      {info.enabled && (
        <form className="req" onSubmit={search}>
          <b>Alquila un carro con conductor por días</b>
          <p className="muted small">Ideal para un viaje fuera de la ciudad o un día de mandados. El conductor va contigo todo el día.</p>
          <div className="row">
            <label className="grow">Desde
              <input type="date" min={today} max={maxStart} value={q.start} onChange={(e) => setQ({ ...q, start: e.target.value })} required />
            </label>
            <label>Días
              <select aria-label="Días" value={q.days} onChange={(e) => setQ({ ...q, days: e.target.value })}>
                {Array.from({ length: info.maxDays }, (_, i) => <option key={i + 1} value={i + 1}>{i + 1}</option>)}
              </select>
            </label>
          </div>
          <button className="primary" disabled={busy}>{busy && !pick ? 'Buscando…' : 'Ver carros disponibles'}</button>
        </form>
      )}

      {msg && <div className="hint ok">{msg}</div>}
      {error && <div className="error">{error}</div>}

      {found && !pick && (
        <>
          <b>{found.results.length ? `Disponibles ${found.days > 1 ? `del ${dateHN(found.start)} al ${dateHN(found.end)}` : `para el ${dateHN(found.start)}`}` : 'Sin carros libres'}</b>
          {found.results.length === 0 && <Empty title="No hay carros libres en esas fechas">Prueba con otro día o con menos días.</Empty>}
          {found.results.map((r) => (
            <div className="req" key={r.listingId}>
              <div className="row between">
                <b>{vehicleText(r.vehicle)}</b>
                <span className="tag">{lempiras(r.total)}</span>
              </div>
              <div className="muted small">
                {r.vehicle.categoryLabel} · {r.owner === 'fleet' ? 'Carro de Ktracho GO, con conductor' : `Con su dueño, ${r.driverName}`}{r.rating ? ` · ★ ${r.rating}` : ''} · {lempiras(r.priceDay)} por día
              </div>
              {r.notes && <div className="muted small">{r.notes}</div>}
              <button className="primary sm" onClick={() => setPick(r)}>Reservar</button>
            </div>
          ))}
        </>
      )}

      {pick && (
        <form className="req picked" onSubmit={book}>
          <div className="row between">
            <b>{vehicleText(pick.vehicle)}</b>
            <span className="tag">{lempiras(pick.total)}</span>
          </div>
          <div className="muted small">{found.days > 1 ? `${found.days} días: del ${dateHN(found.start)} al ${dateHN(found.end)}` : `1 día: ${dateHN(found.start)}`} · {lempiras(pick.priceDay)} por día</div>
          <input aria-label="Dónde te recogen" placeholder="¿Dónde te recogen? (dirección o punto de referencia)" maxLength={200} value={form.pickup} onChange={(e) => setForm({ ...form, pickup: e.target.value })} required />
          <fieldset className="pay">
            <legend>¿Cómo vas a pagar?</legend>
            <label className="check"><input type="radio" name="pay" checked={form.payment === 'cash'} onChange={() => setForm({ ...form, payment: 'cash' })} /> <span><b>Efectivo</b>: pagas al conductor al empezar.</span></label>
            <label className="check"><input type="radio" name="pay" disabled={!info.transfer} checked={form.payment === 'transfer'} onChange={() => setForm({ ...form, payment: 'transfer' })} /> <span><b>Transferencia</b>: a la cuenta de Ktracho GO; subes el comprobante y el equipo lo aprueba.{!info.transfer && ' (No disponible por ahora.)'}</span></label>
          </fieldset>
          <textarea aria-label="Nota para el conductor" placeholder="Nota para el conductor (opcional): a dónde quieres ir, horario…" rows={2} maxLength={300} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
          <div className="row">
            <button type="button" onClick={() => setPick(null)}>Volver</button>
            <button className="primary grow" disabled={busy}>{busy ? 'Enviando…' : `Pedir alquiler por ${lempiras(pick.total)}`}</button>
          </div>
        </form>
      )}

      <b>Mis alquileres</b>
      {!mine && <Loading />}
      {mine && mine.bookings.length === 0 && <Empty title="Todavía no tienes alquileres" />}
      {mine?.bookings.map((b) => (
        <div className="req" key={b.id}>
          <div className="row between">
            <b>{vehicleText(b.vehicle)}</b>
            <span className="tag">{lempiras(b.total)}</span>
          </div>
          <div className="row wrap">
            <span className={`pill ${RENTAL_PILL[b.status]}`}>{RENTAL_STATUS[b.status]}</span>
            <span className="muted small">{dateHN(b.start_date)}{b.days > 1 ? ` al ${dateHN(b.end_date)}` : ''} · {PAYMENT_LABEL[b.payment]}</span>
          </div>
          {['confirmed', 'active'].includes(b.status) && (
            <div className="muted small">
              {b.fleet ? `Conductor: ${b.assigned_driver}` : <>Conductor: {b.driver_name} · <a href={`tel:${b.driver_phone}`}>{b.driver_phone}</a></>} · placa {b.vehicle.plate}
            </div>
          )}
          {b.payment === 'transfer' && ['requested', 'confirmed', 'active'].includes(b.status) && (
            <div className={b.payment_status === 'approved' ? 'hint ok' : b.payment_status === 'rejected' ? 'hint danger' : 'hint'}>
              {PAYMENT_STATUS[b.payment_status]}{b.payment_note ? `: ${b.payment_note}` : ''}
            </div>
          )}
          {b.status === 'rejected' && b.decline_note && <div className="muted small">Motivo: {b.decline_note}</div>}
          <div className="row wrap">
            {b.payment === 'transfer' && ['requested', 'confirmed'].includes(b.status) && ['none', 'rejected'].includes(b.payment_status) && proof !== b.id && (
              <button className="primary sm" onClick={() => setProof(b.id)}>Subir comprobante</button>
            )}
            {['requested', 'confirmed'].includes(b.status) && !(b.status === 'confirmed' && b.start_date <= today) && (
              <button className="danger sm" onClick={() => cancel(b)}>Cancelar</button>
            )}
          </div>
          {proof === b.id && <TransferProof booking={b} bank={mine.bank} token={token} onDone={() => { setProof(null); setMsg('Recibimos tu comprobante. Te avisaremos cuando el equipo lo apruebe.'); loadMine(); }} />}
        </div>
      ))}
    </Overlay>
  );
}

function Overlay({ onClose, children }) {
  return (
    <div className="overlay">
      <div className="overlay-head">
        <b>Alquilar un carro</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">{children}</div>
    </div>
  );
}
