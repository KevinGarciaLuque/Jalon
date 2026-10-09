import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { API, lempiras } from './lib.js';
import { PushToggle, Stars } from './components.jsx';
import DocsModal from './DocsModal.jsx';
import Topups from './Topups.jsx';
import Settings from './Settings.jsx';
import Monitor from './Monitor.jsx';
import UserDetail, { TempPassword, ROLE_LABEL, STATUS_LABEL, ACTION_LABEL, detailText, isStaffRole } from './UserDetail.jsx';

const RIDE_STATUS = {
  requested: 'Solicitado', accepted: 'Aceptado', arrived: 'Llegó', started: 'En curso',
  completed: 'Completado', cancelled: 'Cancelado',
};
const CANCELLED_BY = { passenger: 'pasajero', driver: 'conductor', admin: 'personal', system: 'sistema' };
const isActive = (s) => ['requested', 'accepted', 'arrived', 'started'].includes(s);
// Tres pitidos para llamar la atención (el navegador solo deja sonar tras un clic, por eso el botón "Activar avisos")
function beep(ctx) {
  [0, 0.35, 0.7].forEach((delay) => {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = 880;
    g.gain.value = 0.25;
    o.connect(g); g.connect(ctx.destination);
    o.start(ctx.currentTime + delay);
    o.stop(ctx.currentTime + delay + 0.22);
  });
}

const when = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' });

export default function Admin({ token, onGate }) {
  const [tab, setTab] = useState('rides');
  const [stats, setStats] = useState(null);
  const [directory, setDirectory] = useState({ users: [], perms: [], me: { id: 0, role: '' } });
  const [rides, setRides] = useState([]);
  const [alerts, setAlerts] = useState([]);
  const [audit, setAudit] = useState([]);
  const [reports, setReports] = useState([]);
  const [repStatus, setRepStatus] = useState('open');
  const [topups, setTopups] = useState([]);
  const [topStatus, setTopStatus] = useState('pending');
  const [error, setError] = useState('');
  const [detailId, setDetailId] = useState(null);
  const [docsUser, setDocsUser] = useState(null);
  const [temp, setTemp] = useState(null);
  const [chatView, setChatView] = useState(null); // { rideId, messages } del chat de una emergencia
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [staffForm, setStaffForm] = useState({ name: '', phone: '', role: 'support' });
  const [alertsOn, setAlertsOn] = useState(false);
  const audio = useRef(null);
  const seen = useRef(null); // ids de emergencias ya vistas (null = todavía no se cargó la primera lista)

  const { users, perms, me } = directory;
  const can = (p) => perms.includes(p);

  const call = useCallback(async (path, body, method) => {
    const verb = method || (body ? 'POST' : 'GET');
    const res = await fetch(`${API}/api/admin/${path}`, {
      method: verb,
      headers: { Authorization: `Bearer ${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (data.code) onGate?.(data.code); // la cuenta tiene un paso pendiente (activar la verificación o cambiar la contraseña)
      throw new Error(data.error || 'Error');
    }
    return data;
  }, [token, onGate]);

  const load = useCallback(async () => {
    try {
      const [s, d, r, a, rp] = await Promise.all([call('stats'), call('users'), call('rides'), call('alerts'), call(`reports?status=${repStatus}`)]);
      setStats(s); setDirectory(d); setRides(r); setAlerts(a); setReports(rp); setError('');
      if (d.perms.includes('audit')) setAudit(await call('audit'));
      if (d.perms.includes('wallet')) setTopups(await call(`topups?status=${topStatus}`));
    } catch (e) {
      setError(e.message);
    }
  }, [call, repStatus, topStatus]);

  // Emergencia nueva mientras el panel está abierto: sonido, notificación del sistema y título parpadeando
  useEffect(() => {
    const ids = new Set(alerts.map((a) => a.id));
    if (seen.current) {
      const fresh = alerts.filter((a) => !seen.current.has(a.id));
      if (fresh.length) {
        if (audio.current) beep(audio.current);
        if ('Notification' in window && Notification.permission === 'granted') {
          new Notification('🆘 Emergencia en Jalón', { body: `${fresh[0].user_name} pidió ayuda (viaje #${fresh[0].ride_id})`, requireInteraction: true });
        }
      }
    }
    seen.current = ids;
    document.title = alerts.length ? `🆘 (${alerts.length}) EMERGENCIA · Jalón` : 'Jalón';
    return () => { document.title = 'Jalón'; };
  }, [alerts]);

  async function enableAlerts() {
    audio.current = new (window.AudioContext || window.webkitAudioContext)();
    await audio.current.resume();
    beep(audio.current); // prueba para que sepas cómo suena
    if ('Notification' in window && Notification.permission === 'default') await Notification.requestPermission();
    setAlertsOn(true);
  }

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

  async function openChat(rideId) {
    try {
      setChatView({ rideId, ...(await call(`rides/${rideId}/chat`)) });
    } catch (e) {
      setError(e.message);
    }
  }

  async function resolveReport(rp) {
    const resolution = window.prompt(`¿Cómo se resolvió? La persona (${rp.reporter}) verá esta respuesta:`, '');
    if (!resolution) return;
    try {
      await call(`reports/${rp.id}/resolve`, { resolution });
      await load();
    } catch (e) {
      setError(e.message);
    }
  }

  async function createStaff(e) {
    e.preventDefault();
    try {
      const r = await call('staff', staffForm);
      setTemp({ who: staffForm.name, password: r.tempPassword });
      setStaffForm({ name: '', phone: '', role: 'support' });
      await load();
    } catch (err) {
      setError(err.message);
    }
  }

  const live = users.filter((u) => !u.deleted_at);
  const pending = live.filter((u) => u.role === 'driver' && u.status === 'pending');
  const staff = users.filter((u) => isStaffRole(u.role));
  const shown = useMemo(() => {
    const text = q.trim().toLowerCase();
    return users.filter((u) => {
      if (isStaffRole(u.role)) return false;
      if (filter === 'passenger' && u.role !== 'passenger') return false;
      if (filter === 'driver' && u.role !== 'driver') return false;
      if (filter === 'blocked' && (u.status !== 'blocked' || u.deleted_at)) return false;
      if (!text) return true;
      return [u.name, u.phone, u.plate, u.vehicle].some((v) => (v || '').toLowerCase().includes(text));
    });
  }, [users, q, filter]);

  const tabs = [
    ['rides', 'Viajes'],
    ['users', 'Usuarios'],
    ['reports', `Reportes${stats?.openReports ? ` (${stats.openReports})` : ''}`],
    ...(can('wallet') ? [['topups', `Recargas${stats?.pendingTopups ? ` (${stats.pendingTopups})` : ''}`]] : []),
    ...(can('monitor') ? [['monitor', 'Mapa en vivo']] : []),
    ...(can('settings') ? [['settings', 'Ajustes']] : []),
    ...(can('staff.manage') ? [['staff', 'Personal']] : []),
    ...(can('audit') ? [['audit', 'Registro']] : []),
  ];

  return (
    <div className="admin">
      {error && <div className="error">{error}</div>}

      {stats && stats.sosPhones === 0 && can('staff.manage') && (
        <div className="hint">⚠ Ningún teléfono recibe las emergencias por SMS: si alguien pulsa el botón y nadie está mirando este panel, nadie se entera. Configura <b>SOS_ALERT_PHONES</b> en Railway.</div>
      )}
      {!alertsOn && (
        <button className="sm left" onClick={enableAlerts}>🔔 Activar avisos sonoros de emergencia</button>
      )}
      <PushToggle token={token} why="Recibe las emergencias y las solicitudes de conductores en este dispositivo, aunque no tengas el panel abierto." />

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
            <button className="sm" onClick={() => openChat(a.ride_id)}>💬 Ver chat del viaje</button>
            <button className="sm" onClick={() => act(`alerts/${a.id}/resolve`, {}, '¿Marcar esta emergencia como atendida?')}>Atendida</button>
          </div>
        </div>
      ))}

      {/* Solicitudes de conductores: siempre a la vista, sin buscarlas en una tabla */}
      {can('users.manage') && pending.length > 0 && (
        <section className="pending">
          <b>🔔 Solicitudes de conductores por aprobar ({pending.length})</b>
          {pending.map((u) => (
            <div className="ucard" key={u.id}>
              <div className="grow">
                <b>{u.name}</b> <span className="muted">· {u.phone}</span>
                <div className="muted">{u.vehicle} · {u.plate} · se registró el {when(u.created_at)}</div>
                <div className={u.docs === 3 ? 'ok small' : 'muted small'}>
                  {u.docs === 3 ? '✓ Subió los 3 documentos' : `Documentos: ${u.docs} de 3 (falta que los suba)`}
                </div>
              </div>
              <div className="row wrap">
                <button className="sm" onClick={() => setDocsUser(u)}>Revisar documentos</button>
                <button className="primary sm" disabled={u.docs < 3} title={u.docs < 3 ? 'Faltan documentos' : ''} onClick={() => act(`users/${u.id}/status`, { status: 'active' })}>Aprobar</button>
              </div>
            </div>
          ))}
        </section>
      )}

      {can('wallet') && stats?.pendingTopups > 0 && tab !== 'topups' && (
        <section className="pending">
          <div className="row between wrap">
            <b>💰 {stats.pendingTopups} recarga{stats.pendingTopups === 1 ? '' : 's'} esperando tu aprobación</b>
            <button className="primary sm" onClick={() => { setTopStatus('pending'); setTab('topups'); }}>Revisar</button>
          </div>
        </section>
      )}

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

      <div className="seg tabs">
        {tabs.map(([key, label]) => (
          <button key={key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab === 'rides' && (
        <div className="tablewrap">
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
                  <td>{when(r.created_at)}</td>
                  <td>{isActive(r.status) && can('rides.cancel') && (
                    <button className="danger sm" onClick={() => act(`rides/${r.id}/cancel`, {}, `¿Cancelar el viaje #${r.id}?`)}>Cancelar</button>
                  )}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {tab === 'users' && (
        <>
          <input placeholder="Buscar por nombre, teléfono o placa" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="chips">
            {[['all', 'Todos'], ['passenger', 'Pasajeros'], ['driver', 'Conductores'], ['blocked', 'Bloqueados']].map(([k, label]) => (
              <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
          {shown.length === 0 && <p className="muted">No hay usuarios con ese filtro.</p>}
          {shown.map((u) => (
            <button className="ucard click" key={u.id} onClick={() => setDetailId(u.id)}>
              <div className="grow left-text">
                <b>{u.name}</b> <span className="muted">· {u.phone}</span> {u.online && '🟢'}
                <div className="muted small">{ROLE_LABEL[u.role]}{u.vehicle ? ` · ${u.vehicle} ${u.plate}` : ''}</div>
              </div>
              <Stars rating={u.rating} />
              <span className={`pill ${u.status}`}>{u.deleted_at ? 'Eliminada' : STATUS_LABEL[u.status]}</span>
            </button>
          ))}
        </>
      )}

      {tab === 'topups' && <Topups topups={topups} status={topStatus} setStatus={setTopStatus} call={call} token={token} reload={load} onError={setError} />}
      {tab === 'settings' && <Settings call={call} onError={setError} />}
      {tab === 'monitor' && can('monitor') && <Monitor call={call} onError={setError} />}

      {tab === 'reports' && (
        <>
          <div className="chips">
            <button className={repStatus === 'open' ? 'on' : ''} onClick={() => setRepStatus('open')}>Abiertos</button>
            <button className={repStatus === 'resolved' ? 'on' : ''} onClick={() => setRepStatus('resolved')}>Resueltos</button>
          </div>
          {reports.length === 0 && <p className="muted">No hay reportes {repStatus === 'open' ? 'abiertos' : 'resueltos'}.</p>}
          {reports.map((rp) => (
            <div className="req" key={rp.id}>
              <div className="row between">
                <b>{rp.type_label} · viaje #{rp.ride_id}</b>
                <span className="muted small">{when(rp.created_at)}</span>
              </div>
              <div>{rp.text}</div>
              <div className="muted small">
                Reportó: <b>{rp.reporter}</b> ({rp.reporter_role === 'driver' ? 'conductor' : 'pasajero'}) <a href={`tel:${rp.reporter_phone}`}>{rp.reporter_phone}</a>
                {rp.other && <> · La otra persona: {rp.other} <a href={`tel:${rp.other_phone}`}>{rp.other_phone}</a></>}
              </div>
              {rp.resolution && <div className="hint ok">Respuesta: {rp.resolution}</div>}
              <div className="row wrap">
                <button className="sm" onClick={() => openChat(rp.ride_id)}>💬 Ver chat del viaje</button>
                {rp.status === 'open' && <button className="primary sm" onClick={() => resolveReport(rp)}>Marcar como resuelto</button>}
              </div>
            </div>
          ))}
        </>
      )}

      {tab === 'staff' && (
        <>
          <form className="req" onSubmit={createStaff}>
            <b>Agregar a una persona del personal</b>
            <input placeholder="Nombre" value={staffForm.name} onChange={(e) => setStaffForm({ ...staffForm, name: e.target.value })} required />
            <input placeholder="Teléfono (8 dígitos)" inputMode="tel" value={staffForm.phone} onChange={(e) => setStaffForm({ ...staffForm, phone: e.target.value })} required />
            <select value={staffForm.role} onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value })}>
              <option value="support">Soporte: ve usuarios y viajes y atiende emergencias</option>
              <option value="admin">Administrador: además aprueba, bloquea y revisa documentos</option>
            </select>
            <p className="muted small">Se genera una contraseña temporal que verás una sola vez; la persona la cambiará al entrar.</p>
            <button className="primary">Crear cuenta</button>
          </form>
          {staff.filter((u) => !u.deleted_at).map((u) => (
            <button className="ucard click" key={u.id} onClick={() => setDetailId(u.id)}>
              <div className="grow left-text">
                <b>{u.name}</b> <span className="muted">· {u.phone}</span>
                <div className="muted small">{ROLE_LABEL[u.role]}{u.must_change_password ? ' · aún no cambia su contraseña temporal' : ''}</div>
              </div>
              <span className={`pill ${u.status}`}>{STATUS_LABEL[u.status]}</span>
            </button>
          ))}
        </>
      )}

      {tab === 'audit' && (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Cuándo</th><th>Quién</th><th>Qué hizo</th><th>Sobre</th><th>Detalle</th></tr></thead>
            <tbody>
              {audit.map((l) => (
                <tr key={l.id}>
                  <td>{when(l.created_at)}</td>
                  <td>{l.actor} <span className="muted">({ROLE_LABEL[l.actor_role]})</span></td>
                  <td>{ACTION_LABEL[l.action] || l.action}</td>
                  <td>{l.target_name || '—'}</td>
                  <td>{detailText(l.action, l.details)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {audit.length === 0 && <p className="muted pad">Todavía no hay movimientos.</p>}
        </div>
      )}

      {detailId && (
        <UserDetail
          userId={detailId}
          me={me}
          perms={perms}
          call={call}
          token={token}
          onClose={() => setDetailId(null)}
          onChanged={load}
        />
      )}
      {docsUser && (
        <DocsModal
          user={users.find((u) => u.id === docsUser.id) || docsUser}
          call={call}
          token={token}
          canManage={can('users.manage')}
          onClose={() => setDocsUser(null)}
          onApprove={async () => { await act(`users/${docsUser.id}/status`, { status: 'active' }); setDocsUser(null); }}
          onChanged={load}
        />
      )}
      {chatView && (
        <div className="overlay top">
          <div className="overlay-head">
            <b>Chat del viaje #{chatView.rideId}</b>
            <button className="link" onClick={() => setChatView(null)}>Cerrar ✕</button>
          </div>
          <div className="overlay-body">
            <p className="muted small">Se muestra solo porque el viaje tiene una emergencia. Esta consulta queda anotada en el Registro.</p>
            {chatView.messages.length === 0 && <p className="muted">No escribieron mensajes.</p>}
            <div className="chat-list">
              {chatView.messages.map((m) => (
                <div key={m.id} className={`bubble ${m.senderId === chatView.driverId ? 'mine' : 'theirs'}`}>
                  <b className="small">{m.sender}</b>
                  <span>{m.text}</span>
                  <small>{when(m.at)}</small>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {temp && <TempPassword who={temp.who} password={temp.password} onClose={() => setTemp(null)} />}
    </div>
  );
}
