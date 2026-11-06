import { useCallback, useEffect, useState } from 'react';
import { Empty, Loading } from './components.jsx';
import { lempiras } from './lib.js';

// Códigos promocionales: el pasajero paga menos en efectivo y Ktracho GO le pone la diferencia al conductor en su saldo
const EMPTY = { code: '', description: '', kind: 'fixed', value: '', max_discount: '', max_uses: '', first_ride_only: false, starts_at: '', expires_at: '' };
const day = (d) => new Date(d).toLocaleDateString('es-HN', { day: 'numeric', month: 'short', year: 'numeric' });
export const promoText = (p) => (p.kind === 'percent' ? `${Number(p.value)}% (hasta ${lempiras(p.max_discount)})` : `${lempiras(p.value)} menos`);

function stateOf(p) {
  if (!p.active) return ['', 'Apagado'];
  if (p.expired) return ['blocked', 'Vencido'];
  if (p.max_uses != null && p.used + p.in_progress >= p.max_uses) return ['pending', 'Agotado'];
  return ['active', '✓ Activo'];
}

export default function Promos({ call, onError }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(EMPTY);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => call('promos').then(setData).catch((e) => onError(e.message)), [call, onError]);
  useEffect(() => { load(); }, [load]);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });

  async function create(e) {
    e.preventDefault();
    setBusy(true);
    setMsg('');
    try {
      // Las fechas son de Honduras: el inicio a las 00:00 y el vencimiento al final del día
      const at = (d, end) => (d ? new Date(`${d}T${end ? '23:59:59' : '00:00:00'}-06:00`).toISOString() : null);
      await call('promos', { ...form, starts_at: at(form.starts_at), expires_at: at(form.expires_at, true), max_discount: form.kind === 'percent' ? form.max_discount : null });
      setMsg(`✓ Código ${form.code.toUpperCase()} creado`);
      setForm(EMPTY);
      load();
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }
  async function toggle(p) {
    try {
      await call(`promos/${p.id}`, { active: !p.active }, 'PUT');
      load();
    } catch (err) {
      onError(err.message);
    }
  }
  if (!data) return <Loading />;

  return (
    <>
      {!data.commissionEnabled && (
        <div className="hint danger" role="alert">
          ⚠ La comisión está apagada: los códigos no se pueden usar. El descuento se le paga al conductor en su saldo, y ese saldo solo sirve con la comisión activa (Ajustes).
        </div>
      )}
      <form className="req settings" onSubmit={create} aria-label="Nuevo código">
        <b>Nuevo código</b>
        <p className="muted small">El pasajero lo escribe al pedir el viaje y paga menos en efectivo. Al conductor no le cuesta nada: al terminar el viaje, Ktracho GO le pone el descuento en su saldo.</p>
        <div className="row wrap">
          <label className="grow">Código<input value={form.code} onChange={set('code')} maxLength={20} placeholder="PRIMERVIAJE" autoCapitalize="characters" required /></label>
          <label className="grow">Descripción (la ve el pasajero)<input value={form.description} onChange={set('description')} maxLength={120} placeholder="L 30 menos en tu primer viaje" /></label>
        </div>
        <div className="seg" role="radiogroup" aria-label="Tipo de descuento">
          <button type="button" role="radio" aria-checked={form.kind === 'fixed'} className={form.kind === 'fixed' ? 'on' : ''} onClick={() => setForm({ ...form, kind: 'fixed' })}>Monto fijo (L)</button>
          <button type="button" role="radio" aria-checked={form.kind === 'percent'} className={form.kind === 'percent' ? 'on' : ''} onClick={() => setForm({ ...form, kind: 'percent' })}>Porcentaje (%)</button>
        </div>
        <div className="row wrap">
          <label className="grow">{form.kind === 'percent' ? 'Porcentaje' : 'Descuento (L)'}<input inputMode="decimal" value={form.value} onChange={set('value')} required /></label>
          {form.kind === 'percent' && <label className="grow">Hasta (L)<input inputMode="decimal" value={form.max_discount} onChange={set('max_discount')} required /></label>}
          <label className="grow">Usos en total (vacío = sin límite)<input inputMode="numeric" value={form.max_uses} onChange={set('max_uses')} /></label>
        </div>
        <div className="row wrap">
          <label className="grow">Desde (opcional)<input type="date" value={form.starts_at} onChange={set('starts_at')} /></label>
          <label className="grow">Vence (opcional)<input type="date" value={form.expires_at} onChange={set('expires_at')} /></label>
        </div>
        <label className="check">
          <input type="checkbox" role="switch" className="switch" checked={form.first_ride_only} onChange={set('first_ride_only')} />
          <span>Solo para el <b>primer viaje</b> del pasajero</span>
        </label>
        <p className="muted small">Cada pasajero puede usar un mismo código una sola vez. Si el viaje se cancela, el uso se le devuelve.</p>
        {msg && <p className={msg.startsWith('✓') ? 'muted' : 'error'} role="status">{msg}</p>}
        <button className="primary" disabled={busy}>{busy ? 'Creando…' : 'Crear código'}</button>
      </form>

      {data.promos.length === 0 && <Empty title="Todavía no hay códigos">Crea el primero arriba, por ejemplo uno para el primer viaje.</Empty>}
      {data.promos.map((p) => {
        const [cls, label] = stateOf(p);
        return (
          <div className="req" key={p.id}>
            <div className="row between">
              <b className="promo-code">{p.code}</b>
              <span className={`pill ${cls}`}>{label}</span>
            </div>
            {p.description && <span>{p.description}</span>}
            <span className="muted small">
              {promoText(p)}{p.first_ride_only ? ' · solo primer viaje' : ''}
              {p.starts_at ? ` · desde ${day(p.starts_at)}` : ''}{p.expires_at ? ` · vence ${day(p.expires_at)}` : ''}
            </span>
            <span className="small">
              Usado <b>{p.used}</b>{p.max_uses != null ? ` de ${p.max_uses}` : ''} {p.used === 1 && p.max_uses == null ? 'vez' : 'veces'}{p.in_progress ? ` · ${p.in_progress} en viajes en curso` : ''} · Ktracho GO puso <b>{lempiras(p.total_discount)}</b>
            </span>
            <button className="sm" onClick={() => toggle(p)}>{p.active ? 'Apagar' : 'Encender'}</button>
          </div>
        );
      })}
    </>
  );
}
