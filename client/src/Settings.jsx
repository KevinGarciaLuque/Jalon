import { useEffect, useState } from 'react';
import { Loading } from './components.jsx';
import { CATEGORIES } from './lib.js';
import BankAccounts from './BankAccounts.jsx';

// Ajustes de la app (solo superadmin), por pestañas. Todas las pestañas son un solo formulario:
// «Guardar ajustes» guarda todo lo cambiado, aunque esté en otra pestaña.
const TABS = [
  ['commission', '💰 Comisión y saldo'],
  ['fares', '🚗 Tarifas'],
  ['rides', '🧭 Viajes'],
  ['security', '🛡 Seguridad'],
  ['rentals', '🔑 Alquiler'],
  ['banks', '🏦 Cuentas bancarias'],
];
const TAB_KEY = 'jalon-settings-tab';
const savedTab = () => { try { const t = localStorage.getItem(TAB_KEY); return TABS.some(([k]) => k === t) ? t : 'commission'; } catch { return 'commission'; } };

export default function Settings({ call, onError }) {
  const [activeBanks, setActiveBanks] = useState(null); // cuántas cuentas bancarias activas hay
  const [s, setS] = useState(null);
  const [first, setFirst] = useState(null); // lo guardado, para marcar las pestañas con cambios sin guardar
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [tab, setTabState] = useState(savedTab);
  useEffect(() => { call('settings').then((r) => { setS(r); setFirst(r); }).catch((e) => onError(e.message)); }, [call, onError]);
  const setTab = (t) => { setTabState(t); try { localStorage.setItem(TAB_KEY, t); } catch { /* sin almacenamiento */ } };
  if (!s) return <Loading />;
  const set = (k) => (e) => { setSaved(false); setS({ ...s, [k]: e.target.type === 'checkbox' ? (e.target.checked ? '1' : '0') : e.target.value }); };

  async function save(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const r = await call('settings', { ...s, commission_enabled: s.commission_enabled === '1', rental_enabled: s.rental_enabled === '1' }, 'PUT');
      setS(r);
      setFirst(r);
      setSaved(true);
    } catch (err) {
      onError(err.message);
    } finally {
      setBusy(false);
    }
  }

  // Qué ajustes van en cada pestaña (para marcar con • la que tiene cambios sin guardar)
  const KEYS = {
    commission: ['commission_enabled', 'commission_percent', 'welcome_credit', 'min_balance', 'topup_min', 'topup_max'],
    fares: Object.keys(s).filter((k) => k.startsWith('fare_')),
    rides: ['tips_enabled', 'map_rotation'],
    security: ['staff_2fa_required', 'ride_pin_required', 'ride_safety_checks', 'driver_selfie_required', 'driver_selfie_hours'],
    rentals: ['rental_enabled', 'rental_price_min', 'rental_price_max', 'rental_max_days', 'rental_advance_days'],
    banks: [],
  };
  const dirty = (t) => first && KEYS[t].some((k) => String(s[k]) !== String(first[k]));
  const anyDirty = TABS.some(([t]) => dirty(t));

  // Con la comisión (o los alquileres por transferencia) activa hace falta al menos una cuenta activa para asignar
  const needsBank = s.commission_enabled === '1' || s.rental_enabled === '1';
  const bankWarning = needsBank && activeBanks === 0 && (
    <div className="hint danger" role="alert">
      ⚠ No hay ninguna cuenta bancaria activa: los conductores no podrían recibir una para transferir, y la comisión no se puede activar.{' '}
      <button type="button" className="link" onClick={() => setTab('banks')}>Agregar una cuenta</button>
    </div>
  );
  const on = (k) => s[k] !== '0';

  return (
    <>
      <div className="seg tabs settings-tabs" role="tablist" aria-label="Secciones de los ajustes">
        {TABS.map(([k, label]) => (
          <button key={k} type="button" role="tab" id={`set-tab-${k}`} aria-selected={tab === k} aria-controls={`set-panel-${k}`} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {label}{dirty(k) && <span className="tab-dirty" aria-label="(cambios sin guardar)"> •</span>}
          </button>
        ))}
      </div>

      <form className="req settings" onSubmit={save} hidden={tab === 'banks'}>
        <section role="tabpanel" id="set-panel-commission" aria-labelledby="set-tab-commission" hidden={tab !== 'commission'}>
          <b>Comisión y saldo de los conductores</b>
          <label className="check">
            <input type="checkbox" role="switch" className="switch" checked={s.commission_enabled === '1'} onChange={set('commission_enabled')} />
            <span><b>Cobrar comisión</b>: los conductores necesitan saldo para recibir viajes y se les descuenta la comisión de cada viaje en efectivo.</span>
          </label>
          {bankWarning}
          <div className="row wrap">
            <label className="grow">Comisión por viaje (%)<input inputMode="decimal" value={s.commission_percent} onChange={set('commission_percent')} /></label>
            <label className="grow">Crédito de bienvenida al aprobar a un conductor (L)<input inputMode="decimal" value={s.welcome_credit} onChange={set('welcome_credit')} /></label>
          </div>
          <label>Saldo mínimo para poder recibir viajes (L)<input inputMode="decimal" value={s.min_balance} onChange={set('min_balance')} /></label>
          <p className="muted small">Si lo pones en 0, con saldo 0 todavía pueden trabajar, pero al pasar a negativo quedan sin viajes hasta recargar. Un número negativo les permite deber un poco.</p>
          <div className="row wrap">
            <label className="grow">Recarga mínima (L)<input inputMode="decimal" value={s.topup_min} onChange={set('topup_min')} /></label>
            <label className="grow">Recarga máxima (L)<input inputMode="decimal" value={s.topup_max} onChange={set('topup_max')} /></label>
          </div>
        </section>

        <section role="tabpanel" id="set-panel-fares" aria-labelledby="set-tab-fares" hidden={tab !== 'fares'}>
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
        </section>

        <section role="tabpanel" id="set-panel-rides" aria-labelledby="set-tab-rides" hidden={tab !== 'rides'}>
          <b>Propinas</b>
          <label className="check">
            <input type="checkbox" role="switch" className="switch" checked={on('tips_enabled')} onChange={set('tips_enabled')} />
            <span><b>Dejar que el pasajero dé propina</b> al terminar el viaje (en efectivo, en los primeros 15 minutos). La propina es toda del conductor: no se le cobra comisión.</span>
          </label>
          <b>Mapa</b>
          <label className="check">
            <input type="checkbox" role="switch" className="switch" checked={on('map_rotation')} onChange={set('map_rotation')} />
            <span><b>El mapa puede girar</b> según hacia dónde va la persona (como Waze) y con dos dedos. Si en algún celular da problemas, apágalo: el mapa queda con el norte arriba (se aplica al volver a abrir la app).</span>
          </label>
        </section>

        <section role="tabpanel" id="set-panel-security" aria-labelledby="set-tab-security" hidden={tab !== 'security'}>
          <b>Seguridad de los viajes</b>
          <label className="check">
            <input type="checkbox" role="switch" className="switch" checked={on('ride_pin_required')} onChange={set('ride_pin_required')} />
            <span><b>Pedir el PIN en todos los viajes</b>: el pasajero ve un PIN de 4 dígitos y se lo dice al conductor al subir; sin él no se puede iniciar el viaje. Apagado, se usa solo para quien lo activó en Mi cuenta y en los viajes «Solo conductoras».</span>
          </label>
          <label className="check">
            <input type="checkbox" role="switch" className="switch" checked={on('ride_safety_checks')} onChange={set('ride_safety_checks')} />
            <span><b>Preguntar «¿Todo bien?» durante el viaje</b> si el carro se desvía de la ruta o se queda detenido mucho tiempo. Si el pasajero pide ayuda o no responde en 2 minutos, se crea una alerta como la de emergencia.</span>
          </label>
          <label className="check">
            <input type="checkbox" role="switch" className="switch" checked={on('driver_selfie_required')} onChange={set('driver_selfie_required')} />
            <span><b>Pedir selfie al conductor para ponerse disponible</b>: se la toma con la cámara frontal y la revisas en «Selfies» comparándola con su foto aprobada. Apagado, se conecta sin selfie.</span>
          </label>
          {on('driver_selfie_required') && (
            <label>Cada cuántas horas se pide la selfie<input inputMode="numeric" value={s.driver_selfie_hours} onChange={set('driver_selfie_hours')} /></label>
          )}
          <b>Seguridad del personal</b>
          <label className="check">
            <input type="checkbox" role="switch" className="switch" checked={on('staff_2fa_required')} onChange={set('staff_2fa_required')} />
            <span><b>Exigir verificación en dos pasos</b> al superadmin, administradores y soporte. Si la apagas, entran solo con su contraseña (quien ya la tenía configurada la vuelve a usar si la enciendes de nuevo).</span>
          </label>
        </section>

        <section role="tabpanel" id="set-panel-rentals" aria-labelledby="set-tab-rentals" hidden={tab !== 'rentals'}>
          <b>Alquiler de carros por días</b>
          <label className="check">
            <input type="checkbox" role="switch" className="switch" checked={s.rental_enabled === '1'} onChange={set('rental_enabled')} />
            <span><b>Activar el alquiler</b>: los conductores pueden ofrecer su carro (con ellos como conductor) y los pasajeros alquilarlo por días. También se alquilan los carros de la flota de Ktracho GO.</span>
          </label>
          {s.rental_enabled === '1' && bankWarning}
          <div className="row wrap">
            <label className="grow">Precio mínimo por día (L)<input inputMode="decimal" value={s.rental_price_min} onChange={set('rental_price_min')} /></label>
            <label className="grow">Precio máximo por día (L)<input inputMode="decimal" value={s.rental_price_max} onChange={set('rental_price_max')} /></label>
          </div>
          <div className="row wrap">
            <label className="grow">Días máximos por alquiler<input inputMode="numeric" value={s.rental_max_days} onChange={set('rental_max_days')} /></label>
            <label className="grow">Reservar hasta con (días de anticipación)<input inputMode="numeric" value={s.rental_advance_days} onChange={set('rental_advance_days')} /></label>
          </div>
          <p className="muted small">La comisión de los alquileres es la misma de los viajes. El pago por transferencia usa la primera cuenta activa de la pestaña «Cuentas bancarias».</p>
        </section>

        <div className="settings-save">
          <button className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar ajustes'}</button>
          {anyDirty && !busy && <span className="muted small">Tienes cambios sin guardar{TABS.filter(([t]) => t !== tab && dirty(t)).length ? ` (también en ${TABS.filter(([t]) => t !== tab && dirty(t)).map(([, l]) => `«${l.replace(/^\S+\s/, '')}»`).join(', ')})` : ''}.</span>}
          {saved && !anyDirty && <div className="hint ok" role="status">Ajustes guardados. Los conductores ya ven los cambios.</div>}
        </div>
      </form>

      {/* Siempre montada (aunque oculta) para saber cuántas cuentas activas hay */}
      <div role="tabpanel" id="set-panel-banks" aria-labelledby="set-tab-banks" hidden={tab !== 'banks'}>
        <BankAccounts call={call} onError={onError} onCount={setActiveBanks} />
      </div>
    </>
  );
}
