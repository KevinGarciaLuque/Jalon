import { useCallback, useEffect, useState } from 'react';
import { API, lempiras } from './lib.js';
import { Stars } from './components.jsx';

const RIDE_STATUS = {
  requested: 'Solicitado', accepted: 'Aceptado', arrived: 'Llegó', started: 'En curso',
  completed: 'Completado', cancelled: 'Cancelado',
};
const CANCELLED_BY = { passenger: 'pasajero', driver: 'conductor', admin: 'admin', system: 'sistema' };
const USER_STATUS = { pending: 'Pendiente', active: 'Activo', blocked: 'Bloqueado' };
const ROLE = { passenger: 'Pasajero', driver: 'Conductor', admin: 'Admin' };
const DOC_LABEL = { photo: 'Foto del conductor', license: 'Licencia', registration: 'Matrícula' };
const isActive = (s) => ['requested', 'accepted', 'arrived', 'started'].includes(s);

export default function Admin({ token }) {
  const [tab, setTab] = useState('rides');
  const [stats, setStats] = useState(null);
  const [users, setUsers] = useState([]);
  const [rides, setRides] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [onlyPending, setOnlyPending] = useState(false);
  const [docsUser, setDocsUser] = useState(null);
  const [error, setError] = useState('');

  const call = useCallback(async (path, body) => {
    const res = await fetch(`${API}/api/admin/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Error');
    return data;
  }, [token]);

  const load = useCallback(
    () =>
      Promise.all([call('stats'), call('users'), call('rides'), call('alerts')])
        .then(([s, u, r, a]) => { setStats(s); setUsers(u); setRides(r); setAlerts(a); setError(''); })
        .catch((e) => setError(e.message)),
    [call]
  );

  useEffect(() => {
    load();
    const id = setInterval(load, 5000);
    return () => clearInterval(id);
  }, [load]);

  async function act(path, body, confirmMsg) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      await call(path, body ?? {});
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  const shownUsers = onlyPending ? users.filter((u) => u.role === 'driver' && u.status === 'pending') : users;

  return (
    <div className="admin">
      {error && <div className="error">{error}</div>}
      {alerts.map((a) => (
        <div className="sos-alert" key={a.id}>
          <div className="row between">
            <b>🆘 EMERGENCIA · viaje #{a.ride_id}</b>
            <span>{new Date(a.created_at).toLocaleTimeString('es-HN')}</span>
          </div>
          <div>
            Pidió ayuda: <b>{a.user_name}</b> ({a.user_role === 'driver' ? 'conductor' : 'pasajero'}) ·{' '}
            <a href={`tel:${a.user_phone}`}>{a.user_phone}</a>
          </div>
          <div>
            Pasajero: {a.passenger} <a href={`tel:${a.passenger_phone}`}>{a.passenger_phone}</a>
            {a.driver && <> · Conductor: {a.driver} <a href={`tel:${a.driver_phone}`}>{a.driver_phone}</a> · {a.vehicle} {a.plate}</>}
          </div>
          <div className="row">
            {a.lat != null && (
              <a className="primary sm" target="_blank" rel="noreferrer" href={`https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=17/${a.lat}/${a.lng}`}>Ver ubicación</a>
            )}
            <button className="sm" onClick={() => act(`alerts/${a.id}/resolve`, {}, '¿Marcar esta emergencia como atendida?')}>Atendida</button>
          </div>
        </div>
      ))}

      {stats && (
        <div className="stats">
          <div><b>{stats.driversFree}</b><span>Conductores libres</span></div>
          <div><b>{stats.driversOnline}</b><span>Conductores en línea</span></div>
          <div><b>{stats.rides.active}</b><span>Viajes activos</span></div>
          <div><b>{stats.rides.completed}</b><span>Completados</span></div>
          <div><b>{stats.passengers}</b><span>Pasajeros</span></div>
          <div><b>{stats.drivers}</b><span>Conductores</span></div>
          <div className={stats.pendingDrivers ? 'alert' : ''}><b>{stats.pendingDrivers}</b><span>Por aprobar</span></div>
          <div><b>{lempiras(stats.revenue)}</b><span>Movido en viajes</span></div>
        </div>
      )}

      <div className="seg">
        <button className={tab === 'rides' ? 'on' : ''} onClick={() => setTab('rides')}>Viajes</button>
        <button className={tab === 'users' ? 'on' : ''} onClick={() => setTab('users')}>
          Usuarios{stats?.pendingDrivers ? ` (${stats.pendingDrivers} por aprobar)` : ''}
        </button>
      </div>

      {tab === 'users' && (
        <label className="check">
          <input type="checkbox" checked={onlyPending} onChange={(e) => setOnlyPending(e.target.checked)} />
          Solo conductores por aprobar
        </label>
      )}

      <div className="tablewrap">
        {tab === 'rides' ? (
          <table>
            <thead><tr><th>#</th><th>Estado</th><th>Pasajero</th><th>Conductor</th><th>Km</th><th>Ofrecido</th><th>Final</th><th>Fecha</th><th></th></tr></thead>
            <tbody>
              {rides.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td>{RIDE_STATUS[r.status]}{r.cancelled_by && ` (${CANCELLED_BY[r.cancelled_by]})`}</td>
                  <td>{r.passenger}</td><td>{r.driver || '—'}</td>
                  <td>{r.distance_km.toFixed(1)}</td><td>{lempiras(r.offered_price)}</td>
                  <td>{r.final_price ? lempiras(r.final_price) : '—'}</td>
                  <td>{new Date(r.created_at).toLocaleString('es-HN')}</td>
                  <td>
                    {isActive(r.status) && (
                      <button className="danger sm" onClick={() => act(`rides/${r.id}/cancel`, {}, `¿Cancelar el viaje #${r.id}?`)}>Cancelar</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <table>
            <thead><tr><th>#</th><th>Nombre</th><th>Teléfono</th><th>Rol</th><th>Vehículo</th><th>Placa</th><th>Calificación</th><th>Cuenta</th><th>En línea</th><th></th></tr></thead>
            <tbody>
              {shownUsers.map((u) => (
                <tr key={u.id}>
                  <td>{u.id}</td><td>{u.name}</td><td>{u.phone}</td><td>{ROLE[u.role]}</td>
                  <td>{u.vehicle || '—'}</td><td>{u.plate || '—'}</td>
                  <td><Stars rating={u.rating} /></td>
                  <td><span className={`pill ${u.status}`}>{USER_STATUS[u.status]}</span></td>
                  <td>{u.online ? '🟢' : ''}</td>
                  <td className="actions">
                    {u.role === 'driver' && (
                      <button className="sm" onClick={() => setDocsUser(u)}>Documentos ({u.docs}/3)</button>
                    )}
                    {u.role !== 'admin' && u.status === 'pending' && (
                      <button
                        className="primary sm"
                        disabled={u.role === 'driver' && u.docs < 3}
                        title={u.role === 'driver' && u.docs < 3 ? 'Faltan documentos' : ''}
                        onClick={() => act(`users/${u.id}/status`, { status: 'active' })}
                      >Aprobar</button>
                    )}
                    {u.role !== 'admin' && u.status !== 'blocked' && (
                      <button className="danger sm" onClick={() => act(`users/${u.id}/status`, { status: 'blocked' }, `¿Bloquear a ${u.name}? Se cancelarán sus viajes activos.`)}>Bloquear</button>
                    )}
                    {u.role !== 'admin' && u.status === 'blocked' && (
                      <button className="sm" onClick={() => act(`users/${u.id}/status`, { status: 'active' })}>Desbloquear</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {docsUser && (
        <DocsModal
          user={users.find((u) => u.id === docsUser.id) || docsUser}
          call={call}
          token={token}
          onClose={() => setDocsUser(null)}
          onApprove={async () => { await act(`users/${docsUser.id}/status`, { status: 'active' }); setDocsUser(null); }}
          onChanged={load}
        />
      )}
    </div>
  );
}

// Revisión de los documentos de un conductor
function DocsModal({ user, call, token, onClose, onApprove, onChanged }) {
  const [docs, setDocs] = useState(null);
  const [images, setImages] = useState({});
  const [error, setError] = useState('');

  const refresh = useCallback(async () => {
    try {
      const list = await call(`users/${user.id}/documents`);
      setDocs(list);
      // Las imágenes exigen sesión de admin, por eso se bajan con fetch y se muestran como blob
      const urls = {};
      for (const d of list) {
        const res = await fetch(`${API}/api/admin/documents/${d.id}/file`, { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok) urls[d.id] = URL.createObjectURL(await res.blob());
      }
      setImages((old) => { Object.values(old).forEach(URL.revokeObjectURL); return urls; });
    } catch (e) {
      setError(e.message);
    }
  }, [call, token, user.id]);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => () => Object.values(images).forEach(URL.revokeObjectURL), []); // eslint-disable-line react-hooks/exhaustive-deps

  async function reject(d) {
    const note = window.prompt(`¿Por qué rechazas ${DOC_LABEL[d.type].toLowerCase()}? (el conductor verá este motivo)`, 'Foto borrosa o ilegible');
    if (note === null) return;
    try {
      await call(`documents/${d.id}/reject`, { note });
      await refresh();
      onChanged();
    } catch (e) {
      setError(e.message);
    }
  }

  const byType = Object.fromEntries((docs || []).map((d) => [d.type, d]));
  const ready = (docs || []).filter((d) => d.status === 'uploaded').length === 3;

  return (
    <div className="overlay">
      <div className="overlay-head">
        <b>Documentos de {user.name} · {user.vehicle} {user.plate}</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body wide">
        {error && <div className="error">{error}</div>}
        {!docs && !error && <div className="pulse">Cargando…</div>}
        <div className="docgrid">
          {Object.entries(DOC_LABEL).map(([type, label]) => {
            const d = byType[type];
            return (
              <div className="req" key={type}>
                <b>{label}</b>
                {!d && <div className="muted">No lo ha subido</div>}
                {d && images[d.id] && (
                  <a href={images[d.id]} target="_blank" rel="noreferrer"><img className="docimg" src={images[d.id]} alt={label} /></a>
                )}
                {d?.status === 'rejected' && <div className="error">Rechazado: {d.note}</div>}
                {d?.status === 'uploaded' && <button className="danger sm" onClick={() => reject(d)}>Rechazar</button>}
              </div>
            );
          })}
        </div>
        {user.status === 'pending' && (
          <button className="primary" disabled={!ready} onClick={onApprove}>
            {ready ? 'Aprobar conductor' : 'Faltan documentos para aprobar'}
          </button>
        )}
      </div>
    </div>
  );
}
