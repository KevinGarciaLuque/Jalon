// Formas de pago al pedir un viaje. Por ahora solo se puede pagar en efectivo; transferencia y tarjeta se ven pero están deshabilitadas.
// Para habilitar una, se pone enabled: true aquí y en server/src/config.js (PAY_METHODS), y se construye el cobro (hoy no existe).
export const PAY_METHODS = [
  { id: 'cash', icon: '💵', label: 'Efectivo', enabled: true },
  { id: 'transfer', icon: '🏦', label: 'Transferencia', enabled: false },
  { id: 'card', icon: '💳', label: 'Tarjeta', enabled: false },
];

export const payLabel = (id) => PAY_METHODS.find((m) => m.id === id) || PAY_METHODS[0];

export function PayMethodPicker({ value, onChange }) {
  return (
    <div className="pay-methods" role="radiogroup" aria-label="¿Cómo vas a pagar?">
      <span className="pay-methods-title">¿Cómo vas a pagar?</span>
      <div className="seg">
        {PAY_METHODS.map((m) => (
          <button key={m.id} type="button" role="radio" aria-checked={value === m.id} className={value === m.id ? 'on' : ''} disabled={!m.enabled}
            onClick={() => m.enabled && onChange(m.id)}>
            <span>{m.icon} {m.label}</span>
            {!m.enabled && <small>Próximamente</small>}
          </button>
        ))}
      </div>
    </div>
  );
}
