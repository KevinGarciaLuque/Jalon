import { useEffect, useState } from 'react';
import { Loading } from './components.jsx';
import { CATEGORIES } from './lib.js';

// Ajustes de la comisión y de la cuenta bancaria a la que transfieren los conductores (solo superadmin)
export default function Settings({ call, onError }) {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call('settings').then(setS).catch((e) => onError(e.message)); }, [call, onError]);
  if (!s) return <Loading />;
  const set = (k) => (e) => { setSaved(false); setS({ ...s, [k]: e.target.type === 'checkbox' ? (e.target.checked ? '1' : '0') : e.target.value }); };

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      setS(await call('settings', { ...s, commission_enabled: s.commission_enabled === '1', rental_enabled: s.rental_enabled === '1' }, 'PUT'));
      setSaved(true);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="req settings" onSubmit={save}>
      <b>Comisión y saldo de los conductores</b>
      <label className="check">
        <input type="checkbox" checked={s.commission_enabled === '1'} onChange={set('commission_enabled')} />
        <span><b>Cobrar comisión</b>: los conductores necesitan saldo para recibir viajes y se les descuenta la comisión de cada viaje en efectivo.</span>
      </label>
      <label>Comisión por viaje (%)<input inputMode="decimal" value={s.commission_percent} onChange={set('commission_percent')} /></label>
      <label>Crédito de bienvenida al aprobar a un conductor (L)<input inputMode="decimal" value={s.welcome_credit} onChange={set('welcome_credit')} /></label>
      <label>Saldo mínimo para poder recibir viajes (L)<input inputMode="decimal" value={s.min_balance} onChange={set('min_balance')} /></label>
      <p className="muted small">Si lo pones en 0, con saldo 0 todavía pueden trabajar, pero al pasar a negativo quedan sin viajes hasta recargar. Un número negativo les permite deber un poco.</p>
      <div className="row">
        <label className="grow">Recarga mínima (L)<input inputMode="decimal" value={s.topup_min} onChange={set('topup_min')} /></label>
        <label className="grow">Recarga máxima (L)<input inputMode="decimal" value={s.topup_max} onChange={set('topup_max')} /></label>
      </div>

      <b>Tarifas sugeridas por tipo de vehículo</b>
      <p className="muted small">Precio sugerido = base + por km + por minuto, redondeado de 5 en 5 y nunca menos que la mínima. El pasajero puede ofrecer otro precio.</p>
      <div className="tablewrap">
        <table className="fares">
          <thead><tr><th>Tipo</th><th>Base (L)</th><th>Por km (L)</th><th>Por minuto (L)</th><th>Mínima (L)</th></tr></thead>
          <tbody>
            {CATEGORIES.map(([c, label]) => (
              <tr key={c}>
                <th scope="row">{label}</th>
                {['base', 'km', 'min', 'minimum'].map((k) => (
                  <td key={k}><input aria-label={`${label}: ${{ base: 'tarifa base', km: 'por km', min: 'por minuto', minimum: 'tarifa mínima' }[k]}`} inputMode="decimal" value={s[`fare_${c}_${k}`]} onChange={set(`fare_${c}_${k}`)} /></td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <b>Alquiler de carros por días</b>
      <label className="check">
        <input type="checkbox" checked={s.rental_enabled === '1'} onChange={set('rental_enabled')} />
        <span><b>Activar el alquiler</b>: los conductores pueden ofrecer su carro (con ellos como conductor) y los pasajeros alquilarlo por días. También se alquilan los carros de la flota de Ktracho GO.</span>
      </label>
      <div className="row">
        <label className="grow">Precio mínimo por día (L)<input inputMode="decimal" value={s.rental_price_min} onChange={set('rental_price_min')} /></label>
        <label className="grow">Precio máximo por día (L)<input inputMode="decimal" value={s.rental_price_max} onChange={set('rental_price_max')} /></label>
      </div>
      <div className="row">
        <label className="grow">Días máximos por alquiler<input inputMode="numeric" value={s.rental_max_days} onChange={set('rental_max_days')} /></label>
        <label className="grow">Reservar hasta con (días de anticipación)<input inputMode="numeric" value={s.rental_advance_days} onChange={set('rental_advance_days')} /></label>
      </div>
      <p className="muted small">La comisión de los alquileres es la misma de los viajes. El pago por transferencia usa la cuenta de Ktracho GO de abajo.</p>

      <b>Cuenta de Ktracho GO para recibir las transferencias</b>
      <label>Banco<input value={s.bank_name} onChange={set('bank_name')} placeholder="Ej. BAC Credomatic" /></label>
      <label>Tipo de cuenta<input value={s.bank_account_type} onChange={set('bank_account_type')} placeholder="Ahorros o Cheques" /></label>
      <label>Número de cuenta<input value={s.bank_account} onChange={set('bank_account')} /></label>
      <label>A nombre de<input value={s.bank_holder} onChange={set('bank_holder')} placeholder="Nombre de la empresa" /></label>
      <label>Indicaciones para el conductor (opcional)<textarea rows={3} maxLength={400} value={s.bank_note} onChange={set('bank_note')} placeholder="Ej. Escribe tu nombre completo en la referencia" /></label>

      <b>Seguridad del personal</b>
      <label className="check">
        <input type="checkbox" checked={s.staff_2fa_required !== '0'} onChange={set('staff_2fa_required')} />
        <span><b>Exigir verificación en dos pasos</b> al superadmin, administradores y soporte. Si la apagas, entran solo con su contraseña (quien ya la tenía configurada la vuelve a usar si la enciendes de nuevo).</span>
      </label>

      <button className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar ajustes'}</button>
      {saved && <div className="hint ok">Ajustes guardados. Los conductores ya ven los cambios.</div>}
    </form>
  );
}
