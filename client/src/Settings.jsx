import { useEffect, useState } from 'react';

// Ajustes de la comisión y de la cuenta bancaria a la que transfieren los conductores (solo superadmin)
export default function Settings({ call, onError }) {
  const [s, setS] = useState(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { call('settings').then(setS).catch((e) => onError(e.message)); }, [call, onError]);
  if (!s) return <div className="pulse">Cargando…</div>;
  const set = (k) => (e) => { setSaved(false); setS({ ...s, [k]: e.target.type === 'checkbox' ? (e.target.checked ? '1' : '0') : e.target.value }); };

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      setS(await call('settings', { ...s, commission_enabled: s.commission_enabled === '1' }, 'PUT'));
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

      <b>Cuenta de Jalón para recibir las transferencias</b>
      <label>Banco<input value={s.bank_name} onChange={set('bank_name')} placeholder="Ej. BAC Credomatic" /></label>
      <label>Tipo de cuenta<input value={s.bank_account_type} onChange={set('bank_account_type')} placeholder="Ahorros o Cheques" /></label>
      <label>Número de cuenta<input value={s.bank_account} onChange={set('bank_account')} /></label>
      <label>A nombre de<input value={s.bank_holder} onChange={set('bank_holder')} placeholder="Nombre de la empresa" /></label>
      <label>Indicaciones para el conductor (opcional)<textarea rows={3} maxLength={400} value={s.bank_note} onChange={set('bank_note')} placeholder="Ej. Escribe tu nombre completo en la referencia" /></label>

      <button className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar ajustes'}</button>
      {saved && <div className="hint ok">Ajustes guardados. Los conductores ya ven los cambios.</div>}
    </form>
  );
}
