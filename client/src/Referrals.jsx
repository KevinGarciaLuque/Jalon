import { useCallback, useEffect, useState } from 'react';
import { Empty, Loading, Tabs } from './components.jsx';
import { lempiras } from './lib.js';

// Referidos: las reglas (solo el superadmin lo enciende) y quién invitó a quién
const STATE = { pending: ['pending', 'Pendiente'], rewarded: ['active', '✓ Premiado'], rejected: ['blocked', 'Sin premio'] };
const day = (d) => new Date(d).toLocaleDateString('es-HN', { day: 'numeric', month: 'short', year: 'numeric' });

export default function Referrals({ call, onError, superadmin }) {
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null);
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const [tab, setTab] = useState('list');
  const load = useCallback(() => call('referrals').then((d) => {
    setData(d);
    setForm({ referral_reward: d.reward, referral_welcome: d.welcome, referral_driver_rides: d.driverRides, referral_monthly_max: d.monthlyMax });
  }).catch((e) => onError(e.message)), [call, onError]);
  useEffect(() => { load(); }, [load]);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function save(values) {
    setBusy(true);
    setMsg('');
    try {
      await call('settings', values, 'PUT');
      setMsg('✓ Guardado');
      load();
    } catch (err) {
      setMsg(err.message);
    } finally {
      setBusy(false);
    }
  }
  if (!data) return <Loading />;
  const { totals } = data;
  const panel = (k) => ({ role: 'tabpanel', id: `ref-panel-${k}`, 'aria-labelledby': `ref-tab-${k}`, className: 'tabpanel', hidden: tab !== k });

  return (
    <>
      <Tabs id="ref" tabs={[['list', '🎁 Invitaciones', totals.total || null], ['rules', '⚙ Reglas', !data.enabled || !data.commissionEnabled ? '•' : null]]} value={tab} onChange={setTab} label="Secciones de los referidos" />

      <section {...panel('rules')}>
      {!data.commissionEnabled && (
        <div className="hint danger" role="alert">
          ⚠ La comisión está apagada: los referidos no funcionan. Los premios son descuentos que se le pagan al conductor en su saldo, y ese saldo solo sirve con la comisión activa (Ajustes).
        </div>
      )}
      <form className="req settings" onSubmit={(e) => { e.preventDefault(); save(form); }} aria-label="Reglas de los referidos">
        <div className="row between">
          <b>Invita y gana</b>
          <span className={`pill ${data.enabled ? 'active' : ''}`}>{data.enabled ? '✓ Encendido' : 'Apagado'}</span>
        </div>
        <p className="muted small">
          Cada pasajero y conductor tiene un código para invitar. Cuando el invitado termina su primer viaje (si es conductor, sus primeros viajes), quien lo invitó gana:
          un <b>código de descuento</b> si es pasajero o <b>saldo</b> si es conductor. El pasajero invitado también recibe un descuento para su primer viaje.
        </p>
        <div className="row wrap">
          <label className="grow">Premio para quien invita (L)<input inputMode="decimal" value={form.referral_reward} onChange={set('referral_reward')} required /></label>
          <label className="grow">Bienvenida del pasajero invitado (L, 0 = sin)<input inputMode="decimal" value={form.referral_welcome} onChange={set('referral_welcome')} required /></label>
        </div>
        <div className="row wrap">
          <label className="grow">Viajes que debe terminar un conductor invitado<input inputMode="numeric" value={form.referral_driver_rides} onChange={set('referral_driver_rides')} required /></label>
          <label className="grow">Premios por persona al mes<input inputMode="numeric" value={form.referral_monthly_max} onChange={set('referral_monthly_max')} required /></label>
        </div>
        <p className="muted small">Si un conductor lleva a su propio invitado, ese viaje no cuenta. Los descuentos son de un solo uso y vencen a los 60 días.</p>
        {msg && <p className={msg.startsWith('✓') ? 'muted' : 'error'} role="status">{msg}</p>}
        <div className="row wrap">
          <button className="grow" disabled={busy}>Guardar reglas</button>
          {superadmin
            ? <button type="button" className={`grow ${data.enabled ? '' : 'primary'}`} disabled={busy || (!data.enabled && !data.commissionEnabled)} onClick={() => save({ referral_enabled: !data.enabled })}>{data.enabled ? 'Apagar los referidos' : 'Encender los referidos'}</button>
            : <span className="muted small grow">Solo el superadministrador puede encenderlos o apagarlos.</span>}
        </div>
      </form>
      </section>

      <section {...panel('list')}>
      {!data.enabled && <div className="hint">Los referidos están apagados. <button type="button" className="link" onClick={() => setTab('rules')}>Ver las reglas</button></div>}
      <div className="row wrap stats-row">
        <div className="req grow"><span className="muted small">Invitaciones</span><b>{totals.total}</b></div>
        <div className="req grow"><span className="muted small">Premiadas</span><b>{totals.rewarded}</b></div>
        <div className="req grow"><span className="muted small">Pagado en saldo</span><b>{lempiras(totals.walletPaid)}</b></div>
        <div className="req grow"><span className="muted small">Pagado en descuentos</span><b>{lempiras(totals.discountsPaid)}</b></div>
      </div>

      {data.referrals.length === 0 && <Empty title="Todavía no hay invitaciones">Cuando alguien se registre con el código de otra persona, aparecerá aquí.</Empty>}
      {data.referrals.map((r) => {
        const [cls, label] = STATE[r.status];
        return (
          <div className="req" key={r.id}>
            <div className="row between">
              <span><b>{r.referrer_name}</b> <span className="muted small">invitó a</span> <b>{r.referred_name}</b></span>
              <span className={`pill ${cls}`}>{label}</span>
            </div>
            <span className="muted small">
              {r.referred_role === 'driver' ? 'Conductor' : 'Pasajero'} · {day(r.created_at)}
              {r.status === 'rewarded' && ` · premio ${r.reward_kind === 'wallet' ? 'en saldo' : 'en código'} de ${lempiras(r.reward_amount)}`}
              {r.reason ? ` · ${r.reason}` : ''}
            </span>
          </div>
        );
      })}
      </section>
    </>
  );
}
