import { useState } from 'react';
import { apiPost, lempiras } from './lib.js';
import { playSound } from './rideAlert.js';

// Propina al terminar el viaje: se da en efectivo al conductor y queda anotada (es toda suya, sin comisión)
const AMOUNTS = [10, 20, 50];
const MAX = 500;

export default function Tip({ token, ride, onDone }) {
  const [amount, setAmount] = useState(0);
  const [other, setOther] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const ok = Number.isInteger(amount) && amount >= 1 && amount <= MAX;

  async function give() {
    setBusy(true);
    setError('');
    try {
      const r = await apiPost(`rides/${ride.id}/tip`, token, { amount });
      playSound('propina'); // la propina quedó registrada
      onDone(r.ride);
    } catch (e) {
      setError(e.message);
      setBusy(false);
    }
  }

  return (
    <div className="req tip-box" aria-label="Propina">
      <b>¿Le dejas propina a {ride.driver.name}?</b>
      <span className="muted small">Es opcional. Se la das en efectivo junto con el viaje y es toda para tu conductor.</span>
      <div className="chips">
        {AMOUNTS.map((n) => (
          <button key={n} type="button" className={!other && amount === n ? 'on' : ''} aria-pressed={!other && amount === n} onClick={() => { setOther(false); setAmount(n); }}>{lempiras(n)}</button>
        ))}
        <button type="button" className={other ? 'on' : ''} aria-pressed={other} onClick={() => { setOther(true); setAmount(0); }}>Otra</button>
      </div>
      {other && (
        <label>¿Cuánto? (L 1 a L {MAX})
          <input inputMode="numeric" autoFocus maxLength={3} value={amount || ''} onChange={(e) => setAmount(Number(e.target.value.replace(/\D/g, '')) || 0)} />
        </label>
      )}
      {error && <div className="error" role="alert">{error}</div>}
      {ok && (
        <button className="primary" disabled={busy} onClick={give}>
          Dar {lempiras(amount)} de propina · total {lempiras((ride.toPay ?? ride.final_price) + amount)}
        </button>
      )}
    </div>
  );
}
