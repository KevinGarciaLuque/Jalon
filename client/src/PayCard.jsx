import { lempiras } from './lib.js';
import { payLabel } from './payMethods.jsx';

// Tarjeta del cobro al terminar el viaje: lo primero que se ve, con el total grande.
// El pasajero ve cuánto paga; el conductor, cuánto cobra (todo en efectivo, la propina va incluida y es toda del conductor).
const first = (name) => String(name || '').trim().split(/\s+/)[0];

export default function PayCard({ ride, role }) {
  const driver = role === 'driver';
  const base = ride.toPay ?? ride.final_price;
  const tip = Number(ride.tip) || 0;
  const discount = Number(ride.discount) || 0;
  const other = first(driver ? ride.passenger?.name : ride.driver?.name);
  return (
    <section className={`pay-card ${driver ? 'for-driver' : ''}`} role="status" aria-label={driver ? 'Cobro del viaje' : 'Pago del viaje'}>
      <div className="pay-head">
        <span className="pay-coin" aria-hidden="true">{payLabel(ride.pay_method).icon}</span>
        <span>{driver ? 'Cobra' : 'Paga'} en {payLabel(ride.pay_method).label.toLowerCase()}{other ? ` · ${other}` : ''}</span>
      </div>
      {/* key: si llega la propina, el total «late» otra vez */}
      <div className="pay-total" key={base + tip}>{lempiras(base + tip)}</div>
      <ul className="pay-lines">
        <li><span>Viaje</span><b>{lempiras(ride.final_price)}</b></li>
        {discount > 0 && (
          <li className="disc">
            <span>{driver ? 'Descuento (lo recibes en tu saldo)' : `Código ${ride.promo?.code || ''}`.trim()}</span>
            <b>− {lempiras(discount)}</b>
          </li>
        )}
        {tip > 0 && <li className="tip"><span>💚 Propina {driver ? '(toda tuya)' : ''}</span><b>+ {lempiras(tip)}</b></li>}
      </ul>
    </section>
  );
}
