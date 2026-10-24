import { useEffect, useState } from 'react';
import { Loading } from './components.jsx';
import { CATEGORIES } from './lib.js';
import BankAccounts from './BankAccounts.jsx';

// Ajustes de la comisión y de la cuenta bancaria a la que transfieren los conductores (solo superadmin)
export default function Settings({ call, onError }) {
  const [activeBanks, setActiveBanks] = useState(null); // cuántas cuentas bancarias activas hay
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

  // Con la comisión (o el pago de alquileres por transferencia) activa, los conductores necesitan saber a qué cuenta transferir
  // Con la comisión (o los alquileres por transferencia) activa hace falta al menos una cuenta activa para asignar
  const needsBank = s.commission_enabled === '1' || s.rental_enabled === '1';
  const bankWarning = needsBank && activeBanks === 0 && (
    <div className="hint danger" role="alert">⚠ No hay ninguna cuenta bancaria activa: los conductores no podrían recibir una para transferir, y la comisión no se puede activar. Agrégala en «Cuentas bancarias» más abajo.</div>
  );

  return (
    <>
    <form className="req settings" onSubmit={save}>
      <b>Comisión y saldo de los conductores</b>
      <label className="check">
        <input type="checkbox" checked={s.commission_enabled === '1'} onChange={set('commission_enabled')} />
        <span><b>Cobrar comisión</b>: los conductores necesitan saldo para recibir viajes y se les descuenta la comisión de cada viaje en efectivo.</span>
      </label>
      {bankWarning}
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
      <p className="muted small">La comisión de los alquileres es la misma de los viajes. El pago por transferencia usa la primera cuenta activa de «Cuentas bancarias» (abajo).</p>


      <b>Seguridad del personal</b>
      <label className="check">
        <input type="checkbox" checked={s.staff_2fa_required !== '0'} onChange={set('staff_2fa_required')} />
        <span><b>Exigir verificación en dos pasos</b> al superadmin, administradores y soporte. Si la apagas, entran solo con su contraseña (quien ya la tenía configurada la vuelve a usar si la enciendes de nuevo).</span>
      </label>

      <b>Seguridad de los viajes</b>
      <label className="check">
        <input type="checkbox" checked={s.ride_pin_required !== '0'} onChange={set('ride_pin_required')} />
        <span><b>Pedir el PIN en todos los viajes</b>: el pasajero ve un PIN de 4 dígitos y se lo dice al conductor al subir; sin él no se puede iniciar el viaje. Apagado, se usa solo para quien lo activó en Mi cuenta y en los viajes «Solo conductoras».</span>
      </label>

      <label className="check">
        <input type="checkbox" checked={s.ride_safety_checks !== '0'} onChange={set('ride_safety_checks')} />
        <span><b>Preguntar «¿Todo bien?» durante el viaje</b> si el carro se desvía de la ruta o se queda detenido mucho tiempo. Si el pasajero pide ayuda o no responde en 2 minutos, se crea una alerta como la de emergencia.</span>
      </label>

      <label className="check">
        <input type="checkbox" checked={s.driver_selfie_required !== '0'} onChange={set('driver_selfie_required')} />
        <span><b>Pedir selfie al conductor para ponerse disponible</b>: se la toma con la cámara frontal y la revisas en «Selfies» comparándola con su foto aprobada. Apagado, se conecta sin selfie.</span>
      </label>
      {s.driver_selfie_required !== '0' && (
        <label>Cada cuántas horas se pide la selfie<input inputMode="numeric" value={s.driver_selfie_hours} onChange={set('driver_selfie_hours')} /></label>
      )}

      <b>Mapa</b>
      <label className="check">
        <input type="checkbox" checked={s.map_rotation !== '0'} onChange={set('map_rotation')} />
        <span><b>El mapa puede girar</b> según hacia dónde va la persona (como Waze) y con dos dedos. Si en algún celular da problemas, apágalo: el mapa queda con el norte arriba (se aplica al volver a abrir la app).</span>
      </label>

      <button className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar ajustes'}</button>
      {saved && <div className="hint ok">Ajustes guardados. Los conductores ya ven los cambios.</div>}
    </form>
    <BankAccounts call={call} onError={onError} onCount={setActiveBanks} />
    </>
  );
}
