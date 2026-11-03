import { useState } from 'react';
import { apiPost } from './lib.js';
import { VehicleFields } from './components.jsx';
import { Panel } from './Menu.jsx';

// Un pasajero pide ser conductor: registra su vehículo y después sube sus documentos (en «Mi solicitud de conductor»)
export default function DriverApply({ token, onDone, onClose }) {
  const [v, setV] = useState({ category: 'car', make: '', model: '', color: '', year: '', plate: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const { user } = await apiPost('me/apply-driver', token, v);
      onDone(user);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <Panel onClose={onClose} labelledBy="apply-title">
      <div className="overlay-head">
        <b id="apply-title">Quiero ser conductor</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
      <form className="req" onSubmit={submit}>
        <p className="muted">Gana dinero manejando con Ktracho GO. Usas tu misma cuenta: tu historial y tus datos de pasajero se quedan igual.</p>
        <b className="small">Tu vehículo</b>
        <VehicleFields value={v} onChange={setV} />
        <p className="muted small">Después subirás tu foto, licencia y matrícula. Cuando revisemos tu cuenta te avisamos; mientras tanto sigues pidiendo viajes como pasajero.</p>
        {error && <div className="error">{error}</div>}
        <button className="primary" disabled={busy}>{busy ? 'Enviando…' : 'Enviar solicitud'}</button>
      </form>
      </div>
    </Panel>
  );
}
