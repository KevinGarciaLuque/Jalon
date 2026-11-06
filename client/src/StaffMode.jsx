import { useState } from 'react';
import { VehicleFields } from './components.jsx';
import { Panel } from './Menu.jsx';

// Modo de prueba del superadmin: usar la app como pasajero o conductor (y volver al panel).

export const STAFF_MODE_LABEL = { panel: 'Panel', passenger: 'Pasajero', driver: 'Conductor' };

// Aviso fijo mientras está en modo de prueba: los viajes son reales y el panel está cerrado
export function TestModeBar({ mode, busy, onBack }) {
  return (
    <div className="test-mode-bar" role="status">
      <span><b>🧪 Modo de prueba: {mode === 'driver' ? 'conductor' : 'pasajero'}.</b> Los viajes son reales.</span>
      <button className="sm" disabled={busy} onClick={onBack}>{busy ? 'Volviendo…' : 'Volver al panel'}</button>
    </div>
  );
}

// La primera vez que el superadmin entra como conductor: el vehículo con el que va a probar
export function StaffVehicle({ onSave, onClose }) {
  const [v, setV] = useState({ category: 'car', make: '', model: '', color: '', year: '', plate: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await onSave(v);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Panel onClose={onClose} labelledBy="staff-vehicle-title">
      <div className="overlay-head">
        <b id="staff-vehicle-title">Tu vehículo de prueba</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        <form className="req" onSubmit={submit}>
          <p className="muted">Para usar la app como conductor necesitas un vehículo. Como eres el superadministrador no subes documentos ni esperas aprobación.</p>
          <VehicleFields value={v} onChange={setV} />
          <p className="muted small">Los pasajeros reales cercanos pueden verte disponible. La comisión de cada viaje se descuenta de tu saldo, igual que a cualquier conductor.</p>
          {error && <div className="error">{error}</div>}
          <button className="primary" disabled={busy}>{busy ? 'Guardando…' : 'Guardar y entrar como conductor'}</button>
        </form>
      </div>
    </Panel>
  );
}
