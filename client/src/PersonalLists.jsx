import { useCallback, useEffect, useState } from 'react';
import { apiGet, apiPost, API, authFetch } from './lib.js';

async function del(path) {
  await authFetch(`${API}/api/${path}`, { method: 'DELETE' });
}

// Contactos de confianza: reciben por SMS el enlace para seguir tu viaje cuando empieza
export function TrustedContacts({ token }) {
  const [list, setList] = useState(null);
  const [f, setF] = useState({ name: '', phone: '' });
  const [error, setError] = useState('');
  const load = useCallback(() => apiGet('contacts', token).then(setList).catch((e) => setError(e.message)), [token]);
  useEffect(() => { load(); }, [load]);

  async function add(e) {
    e.preventDefault();
    setError('');
    try {
      await apiPost('contacts', token, f);
      setF({ name: '', phone: '' });
      load();
    } catch (err) {
      setError(err.message);
    }
  }

  if (!list) return null;
  return (
    <div className="req">
      <b>Contactos de confianza</b>
      <p className="muted small">Cuando empiece cada viaje, estas personas recibirán un SMS con el enlace para seguirlo en vivo. Hasta 3.</p>
      {list.map((c) => (
        <div className="row between" key={c.id}>
          <span>{c.name} <span className="muted">· {c.phone}</span></span>
          <button className="link" onClick={async () => { await del(`contacts/${c.id}`); load(); }} aria-label={`Quitar a ${c.name}`}>✕</button>
        </div>
      ))}
      {list.length < 3 && (
        <form className="row wrap" onSubmit={add}>
          <input aria-label="Nombre (ej. Mamá)" placeholder="Nombre (ej. Mamá)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <input aria-label="Teléfono (8 dígitos)" placeholder="Teléfono (8 dígitos)" inputMode="tel" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} required />
          <button className="primary sm">Agregar</button>
        </form>
      )}
      {error && <div className="error small">{error}</div>}
    </div>
  );
}

// Lugares guardados (casa, trabajo…) para elegirlos con un toque al pedir un viaje
export function SavedPlaces({ token }) {
  const [list, setList] = useState(null);
  const load = useCallback(() => apiGet('favorites', token).then(setList).catch(() => setList([])), [token]);
  useEffect(() => { load(); }, [load]);
  if (!list) return null;
  return (
    <div className="req">
      <b>Lugares guardados</b>
      {list.length === 0 && <p className="muted small">Al elegir un destino toca «⭐ Guardar este lugar» para tenerlo a un toque la próxima vez.</p>}
      {list.map((p) => (
        <div className="row between" key={p.id}>
          <span>⭐ {p.label} <span className="muted small">· {p.text}</span></span>
          <button className="link" onClick={async () => { await del(`favorites/${p.id}`); load(); }} aria-label={`Borrar ${p.label}`}>✕</button>
        </div>
      ))}
    </div>
  );
}
