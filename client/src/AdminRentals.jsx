import { useCallback, useEffect, useState } from 'react';
import { API, lempiras, RENTAL_STATUS, RENTAL_PILL, PAYMENT_LABEL, PAYMENT_STATUS, vehicleText, dateHN, CATEGORY_LABEL } from './lib.js';
import { Empty, Loading, VehicleFields } from './components.jsx';

const FILTERS = [['pay', 'Pagos por revisar'], ['requested', 'Pedidos'], ['confirmed', 'Confirmados'], ['active', 'En curso'], ['completed', 'Terminados'], ['cancelled', 'Cancelados']];

// El comprobante se baja con la sesión del personal y se muestra como imagen
function Proof({ id, token }) {
  const [src, setSrc] = useState(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let url;
    fetch(`${API}/api/admin/rentals/${id}/receipt`, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : Promise.reject()))
      .then((b) => { url = URL.createObjectURL(b); setSrc(url); })
      .catch(() => setFailed(true));
    return () => url && URL.revokeObjectURL(url);
  }, [id, token]);
  if (failed) return <div className="muted small">El comprobante ya no está disponible.</div>;
  return src ? <a href={src} target="_blank" rel="noreferrer"><img className="docimg" src={src} alt="Comprobante de la transferencia del alquiler" /></a> : <div className="muted small">Cargando comprobante…</div>;
}

// Personal: reservas de alquiler (pagos por transferencia, reservas de la flota) y carros de la flota de Jalón
export default function AdminRentals({ call, token, can, onError }) {
  const [filter, setFilter] = useState('pay');
  const [list, setList] = useState(null);
  const [fleet, setFleet] = useState(null);
  const [adding, setAdding] = useState(null); // formulario de un carro nuevo de la flota
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      setList(await call(`rentals${filter === 'pay' ? '?payment=pending' : `?status=${filter}`}`));
      setFleet(await call('fleet'));
    } catch (e) {
      onError(e.message);
    }
  }, [call, filter, onError]);
  useEffect(() => { setList(null); load(); }, [load]);

  async function run(fn) {
    setBusy(true);
    try { await fn(); await load(); } catch (e) { onError(e.message); } finally { setBusy(false); }
  }
  const payment = (b, approve) => {
    if (approve) return window.confirm(`¿El comprobante muestra ${lempiras(b.total)} en la cuenta de Jalón?`) && run(() => call(`rentals/${b.id}/payment`, { approve: true }));
    const note = window.prompt('¿Por qué se rechaza? La persona verá este motivo:', 'El comprobante no se lee o no coincide con el total');
    if (note) run(() => call(`rentals/${b.id}/payment`, { approve: false, note }));
  };
  const confirmFleet = (b) => {
    const who = window.prompt('¿Quién manejará el carro? Nombre y teléfono (el pasajero lo verá):', '');
    if (who) run(() => call(`rentals/${b.id}/decide`, { accept: true, assignedDriver: who }));
  };
  const rejectFleet = (b) => {
    const note = window.prompt('¿Por qué no se puede? El pasajero lo verá (opcional):', '');
    if (note !== null) run(() => call(`rentals/${b.id}/decide`, { accept: false, note }));
  };
  const saveFleet = (v, body) => run(() => call(`fleet/${v.id}`, body, 'PUT'));
  const addFleet = (e) => {
    e.preventDefault();
    run(async () => { await call('fleet', { ...adding, price: Number(adding.price) }); setAdding(null); });
  };

  return (
    <>
      <div className="chips">
        {FILTERS.map(([k, label]) => <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{label}</button>)}
      </div>
      {!list && <Loading />}
      {list && list.length === 0 && <Empty title={filter === 'pay' ? 'No hay pagos por revisar' : `No hay alquileres ${FILTERS.find(([k]) => k === filter)[1].toLowerCase()}`} />}
      {list?.map((b) => (
        <div className="req" key={b.id}>
          <div className="row between">
            <b>#{b.id} · {vehicleText(b.vehicle)} · {b.vehicle.plate}</b>
            <span className="tag">{lempiras(b.total)}</span>
          </div>
          <div className="row wrap">
            <span className={`pill ${RENTAL_PILL[b.status]}`}>{RENTAL_STATUS[b.status]}</span>
            <span className="muted small">{dateHN(b.start_date)}{b.days > 1 ? ` al ${dateHN(b.end_date)}` : ''} · {b.days} día{b.days > 1 ? 's' : ''} · {PAYMENT_LABEL[b.payment]}{b.payment === 'transfer' ? ` (${PAYMENT_STATUS[b.payment_status].toLowerCase()})` : ''}</span>
          </div>
          <div className="muted small">
            Cliente: {b.renter_name} <a href={`tel:${b.renter_phone}`}>{b.renter_phone}</a> · {b.fleet ? `Flota de Jalón${b.assigned_driver ? ` · maneja ${b.assigned_driver}` : ''}` : <>Dueño: {b.driver_name} <a href={`tel:${b.driver_phone}`}>{b.driver_phone}</a></>}
          </div>
          {b.pickup_text && <div className="muted small">Recoger en: {b.pickup_text}</div>}
          {b.payment_status === 'pending' && (
            <>
              <div className="muted small">Transferencia: {b.bank} · ref. {b.reference}</div>
              <Proof id={b.id} token={token} />
              <div className="row">
                <button className="primary sm" disabled={busy} onClick={() => payment(b, true)}>Aprobar pago</button>
                <button className="sm" disabled={busy} onClick={() => payment(b, false)}>Rechazar</button>
              </div>
            </>
          )}
          <div className="row wrap">
            {b.fleet && b.status === 'requested' && <><button className="primary sm" disabled={busy} onClick={() => confirmFleet(b)}>Confirmar</button><button className="sm" disabled={busy} onClick={() => rejectFleet(b)}>No se puede</button></>}
            {b.fleet && b.status === 'confirmed' && <button className="primary sm" disabled={busy} onClick={() => run(() => call(`rentals/${b.id}/start`, {}))}>Entregado (empezó)</button>}
            {b.fleet && b.status === 'active' && <button className="primary sm" disabled={busy} onClick={() => run(() => call(`rentals/${b.id}/finish`, {}))}>Terminar</button>}
            {['requested', 'confirmed', 'active'].includes(b.status) && <button className="danger sm" disabled={busy} onClick={() => window.confirm(`¿Cancelar el alquiler #${b.id}? Se avisa a las dos personas.`) && run(() => call(`rentals/${b.id}/cancel`, {}))}>Cancelar</button>}
          </div>
        </div>
      ))}

      <b>Flota de Jalón</b>
      <p className="muted small">Carros de la empresa que se alquilan con un conductor que el equipo asigna al confirmar.</p>
      {fleet && fleet.length === 0 && !adding && <Empty title="Todavía no hay carros de la flota" />}
      {fleet?.map((v) => (
        <div className="ucard" key={v.id}>
          <div className="grow left-text">
            <b>{vehicleText(v)}</b> <span className="muted">· {v.plate}</span>
            <div className="muted small">{CATEGORY_LABEL[v.category]} · {v.price_with_driver ? `${lempiras(v.price_with_driver)} por día` : 'sin precio'}{v.notes ? ` · ${v.notes}` : ''}</div>
          </div>
          <span className={`pill ${v.active ? 'active' : 'blocked'}`}>{v.active ? 'Se alquila' : 'Pausado'}</span>
          {can('fleet') && (
            <div className="row">
              <button className="sm" disabled={busy} onClick={() => { const p = window.prompt('Precio por día (L):', String(v.price_with_driver || '')); if (p) saveFleet(v, { price: Number(p), active: v.active, notes: v.notes || '' }); }}>Precio</button>
              <button className="sm" disabled={busy} onClick={() => saveFleet(v, { price: v.price_with_driver, active: !v.active, notes: v.notes || '' })}>{v.active ? 'Pausar' : 'Activar'}</button>
            </div>
          )}
        </div>
      ))}
      {can('fleet') && !adding && <button className="sm left" onClick={() => setAdding({ category: 'car', make: '', model: '', color: '', year: '', plate: '', price: '', notes: '' })}>Agregar carro de la flota</button>}
      {adding && (
        <form className="req" onSubmit={addFleet}>
          <b>Carro nuevo de la flota</b>
          <VehicleFields value={adding} onChange={(v) => setAdding({ ...adding, ...v })} />
          <input aria-label="Precio por día" placeholder="Precio por día (L)" inputMode="numeric" value={adding.price} onChange={(e) => setAdding({ ...adding, price: e.target.value.replace(/\D/g, '') })} required />
          <input aria-label="Nota para el cliente" placeholder="Nota para el cliente (opcional): capacidad, aire acondicionado…" maxLength={300} value={adding.notes} onChange={(e) => setAdding({ ...adding, notes: e.target.value })} />
          <div className="row">
            <button className="primary grow" disabled={busy}>Agregar</button>
            <button type="button" onClick={() => setAdding(null)}>Cancelar</button>
          </div>
        </form>
      )}
    </>
  );
}
