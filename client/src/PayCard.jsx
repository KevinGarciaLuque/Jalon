import { lempiras } from './lib.js';
import { payLabel } from './payMethods.jsx';

// Tarjeta del cobro al terminar el viaje: lo primero que se ve, con el total grande.
// El pasajero ve cuánto paga; el conductor, cuánto cobra (todo en efectivo, la propina va incluida y es toda del conductor).
// `draftTip`: la propina que el pasajero está eligiendo y todavía no confirma; se suma al total para que vea cuánto pagaría.
const first = (name) => String(name || '').trim().split(/\s+/)[0];

export default function PayCard({ ride, role, draftTip = 0 }) {
  const driver = role === 'driver';
  const base = ride.toPay ?? ride.final_price;
  const given = Number(ride.tip) || 0;
  const tip = given || Number(draftTip) || 0; // la ya dada manda; si no, la que está eligiendo
  const pending = !given && tip > 0; // elegida pero todavía sin confirmar
  const discount = Number(ride.discount) || 0;
  const other = first(driver ? ride.passenger?.name : ride.driver?.name);
  const lines = discount > 0 || tip > 0; // sin descuento ni propina, «Viaje» solo repetiría el total
  return (
    <section className={`pay-card ${driver ? 'for-driver' : ''}`} role="status" aria-label={driver ? 'Cobro del viaje' : 'Pago del viaje'}>
      <div className="pay-head">
        <span className="pay-coin" aria-hidden="true">{payLabel(ride.pay_method).icon}</span>
        <span>{driver ? 'Cobra' : 'Paga'} en {payLabel(ride.pay_method).label.toLowerCase()}{other ? ` · ${other}` : ''}</span>
      </div>
      {/* key: si cambia el total (llega la propina o se elige otra), «late» otra vez */}
      <div className="pay-total" key={base + tip}>{lempiras(base + tip)}</div>
      {lines && (
        <ul className="pay-lines">
          <li><span>Viaje</span><b>{lempiras(ride.final_price)}</b></li>
          {discount > 0 && (
            <li className="disc">
              <span>{driver ? 'Descuento (lo recibes en tu saldo)' : `Código ${ride.promo?.code || ''}`.trim()}</span>
              <b>− {lempiras(discount)}</b>
            </li>
          )}
          {tip > 0 && <li className="tip"><span>💚 Propina {driver ? '(toda tuya)' : pending ? '(sin confirmar)' : ''}</span><b>+ {lempiras(tip)}</b></li>}
        </ul>
      )}
    </section>
  );
}
