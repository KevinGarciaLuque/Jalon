import { useCallback, useEffect, useRef, useState } from 'react';
import { API, lempiras } from './lib.js';
import { Avatar, Empty, Loading, PushToggle, Stars } from './components.jsx';
import DocsModal from './DocsModal.jsx';
import Topups from './Topups.jsx';
import Settings from './Settings.jsx';
import Monitor from './Monitor.jsx';
import AdminRentals from './AdminRentals.jsx';
import Permissions from './Permissions.jsx';
import Metrics from './Metrics.jsx';
import UserDetail, { TempPassword, ROLE_LABEL, STATUS_LABEL, ACTION_LABEL, detailText } from './UserDetail.jsx';

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

// Listas del panel por páginas: la primera al abrir la pestaña (o al cambiar el filtro) y «Ver más» para las siguientes
const PAGE = 50;
function usePaged(call, path, active, onError) {
  const [items, setItems] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const read = (r) => (Array.isArray(r) ? { list: r, more: r.length === PAGE } : { list: r.users, more: !!r.hasMore });
  const sep = path.includes('?') ? '&' : '?';
  const reload = useCallback(async () => {
    if (!active) return;
    try {
      const { list, more } = read(await call(`${path}${sep}limit=${PAGE}`));
      setItems(list);
      setHasMore(more);
    } catch (e) {
      onError(e.message);
    }
  }, [call, path, sep, active, onError]);
  useEffect(() => { reload(); }, [reload]);
  async function loadMore() {
    setBusy(true);
    try {
      const { list, more } = read(await call(`${path}${sep}limit=${PAGE}&offset=${items.length}`));
      setItems([...items, ...list]);
      setHasMore(more);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return { items: items || [], loaded: items !== null, hasMore, busy, reload, loadMore };
}

function MoreButton({ list }) {
  return list.hasMore ? <button disabled={list.busy} onClick={list.loadMore}>{list.busy ? 'Cargando…' : 'Ver más'}</button> : null;
}

export default function Admin({ token, onGate }) {
  const [tab, setTab] = useState('rides');
  const [stats, setStats] = useState(null);
  const [directory, setDirectory] = useState({ users: [], perms: [], me: { id: 0, role: '' } });
  const [rideFilter, setRideFilter] = useState('all');
  const [alerts, setAlerts] = useState([]);
  const [reports, setReports] = useState([]);
  const [repStatus, setRepStatus] = useState('open');
  const [topups, setTopups] = useState([]);
  const [topStatus, setTopStatus] = useState('pending');
  const [error, setError] = useState('');
  const [detailId, setDetailId] = useState(null);
  const [docsUser, setDocsUser] = useState(null);
  const [temp, setTemp] = useState(null);
  const [newPass, setNewPass] = useState(null); // formulario para agregar un pasajero (solo superadmin)
  const [chatView, setChatView] = useState(null); // { rideId, messages } del chat de una emergencia
  const [q, setQ] = useState('');
  const [query, setQuery] = useState(''); // la búsqueda se manda al servidor un momento después de dejar de escribir
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
      const [s, d, a, rp] = await Promise.all([call('stats'), call('users?filter=pending&limit=50'), call('alerts'), call(`reports?status=${repStatus}`)]);
      setStats(s); setDirectory(d); setAlerts(a); setReports(rp); setError('');
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

  // Listas largas (por páginas, solo la de la pestaña abierta)
  const USER_FILTER = { all: 'people', passenger: 'passenger', driver: 'driver', blocked: 'blocked' };
  useEffect(() => { const t = setTimeout(() => setQuery(q.trim()), 350); return () => clearTimeout(t); }, [q]);
  const ridesList = usePaged(call, `rides?status=${rideFilter}`, tab === 'rides', setError);
  const usersList = usePaged(call, `users?filter=${USER_FILTER[filter]}&q=${encodeURIComponent(query)}`, tab === 'users', setError);
  const staffList = usePaged(call, 'users?filter=staff', tab === 'staff', setError);
  const auditList = usePaged(call, 'audit', tab === 'audit' && perms.includes('audit'), setError);
  const reloadTab = () => ({ rides: ridesList, users: usersList, staff: staffList, audit: auditList })[tab]?.reload();

  async function act(path, body, confirmMsg) {
    if (confirmMsg && !window.confirm(confirmMsg)) return;
    try {
      await call(path, body ?? {});
      await load();
      reloadTab();
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
      staffList.reload();
    } catch (err) {
      setError(err.message);
    }
  }

  async function createPassenger(e) {
    e.preventDefault();
    try {
      const r = await call('users', newPass);
      setTemp({ who: newPass.name, password: r.tempPassword });
      setNewPass(null);
      setError('');
      await load();
      usersList.reload();
    } catch (err) {
      setError(err.message);
    }
  }

  const pending = users; // la carga periódica trae los conductores por aprobar
  const staff = staffList.items;
  const shown = usersList.items;

  const tabs = [
    ...(can('metrics') ? [['metrics', 'Indicadores']] : []),
    ['rides', 'Viajes'],
    ['users', 'Usuarios'],
    ['reports', `Reportes${stats?.openReports ? ` (${stats.openReports})` : ''}`],
    ...(can('wallet') ? [['topups', `Recargas${stats?.pendingTopups ? ` (${stats.pendingTopups})` : ''}`]] : []),
    ...(can('rentals') ? [['rentals', 'Alquileres']] : []),
    ...(can('monitor') ? [['monitor', 'Mapa en vivo']] : []),
    ...(can('settings') ? [['settings', 'Ajustes']] : []),
    ...(can('staff.manage') ? [['staff', 'Personal']] : []),
    ...(can('staff.manage') ? [['perms', 'Permisos']] : []),
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

      <div className="seg tabs" role="tablist" aria-label="Secciones del panel">
        {tabs.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={tab === key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>{label}</button>
        ))}
      </div>

      {tab === 'metrics' && can('metrics') && <Metrics call={call} token={token} can={can} onError={setError} />}

      {tab === 'rides' && (
        <div className="chips">
          {[['all', 'Todos'], ['active', 'Activos'], ['completed', 'Completados'], ['cancelled', 'Cancelados']].map(([k, l]) => (
            <button key={k} className={rideFilter === k ? 'on' : ''} onClick={() => setRideFilter(k)}>{l}</button>
          ))}
        </div>
      )}
      {tab === 'rides' && !ridesList.loaded && <Loading />}
      {tab === 'rides' && ridesList.loaded && ridesList.items.length === 0 && <Empty title="No hay viajes con ese filtro" />}
      {tab === 'rides' && ridesList.items.length > 0 && (
        <div className="tablewrap">
          <table>
            <thead><tr><th>#</th><th>Estado</th><th>Pasajero</th><th>Conductor</th><th>Km</th><th>Ofrecido</th><th>Final</th><th>Fecha</th><th></th></tr></thead>
            <tbody>
              {ridesList.items.map((r) => (
                <tr key={r.id}>
                  <td>{r.id}</td>
                  <td><span className={`pill ride-${r.status}`}>{RIDE_STATUS[r.status]}</span>{r.cancelled_by && <span className="muted small"> ({CANCELLED_BY[r.cancelled_by]})</span>}</td>
                  <td>{r.passenger}</td><td>{r.driver || '—'}</td>
                  <td className="num">{r.distance_km.toFixed(1)}</td><td className="num">{lempiras(r.offered_price)}</td>
                  <td className="num">{r.final_price ? lempiras(r.final_price) : '—'}</td>
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
      {tab === 'rides' && <MoreButton list={ridesList} />}

      {tab === 'users' && (
        <>
          {can('users.create') && !newPass && <button className="sm left" onClick={() => setNewPass({ name: '', phone: '', email: '' })}>➕ Agregar pasajero</button>}
          {newPass && (
            <form className="req" onSubmit={createPassenger}>
              <b>Agregar un pasajero</b>
              <input aria-label="Nombre" placeholder="Nombre" value={newPass.name} onChange={(e) => setNewPass({ ...newPass, name: e.target.value })} required />
              <input aria-label="Teléfono (8 dígitos)" placeholder="Teléfono (8 dígitos)" inputMode="tel" value={newPass.phone} onChange={(e) => setNewPass({ ...newPass, phone: e.target.value })} required />
              <input aria-label="Correo electrónico (opcional)" placeholder="Correo electrónico (opcional)" type="email" inputMode="email" value={newPass.email} onChange={(e) => setNewPass({ ...newPass, email: e.target.value })} />
              <p className="muted small">Se genera una contraseña temporal que verás una sola vez; la persona la cambiará al entrar. Con el correo podrá recuperar su contraseña sola.</p>
              <div className="row">
                <button className="primary grow">Crear cuenta</button>
                <button type="button" onClick={() => setNewPass(null)}>Cancelar</button>
              </div>
            </form>
          )}
          <input aria-label="Buscar por nombre, teléfono o placa" placeholder="Buscar por nombre, teléfono o placa" value={q} onChange={(e) => setQ(e.target.value)} />
          <div className="chips">
            {[['all', 'Todos'], ['passenger', 'Pasajeros'], ['driver', 'Conductores'], ['blocked', 'Bloqueados']].map(([k, label]) => (
              <button key={k} className={filter === k ? 'on' : ''} onClick={() => setFilter(k)}>{label}</button>
            ))}
          </div>
          {!usersList.loaded && <Loading />}
          {usersList.loaded && shown.length === 0 && <Empty title="No hay usuarios con ese filtro">Prueba con otro filtro o búsqueda.</Empty>}
          {shown.map((u) => (
            <button className="ucard click" key={u.id} onClick={() => setDetailId(u.id)}>
              <Avatar name={u.name} />
              <div className="grow left-text">
                <b>{u.name}</b> <span className="muted">· {u.phone}</span> {u.online && <span className="online" title="En línea" aria-label="En línea" />}
                <div className="muted small">{ROLE_LABEL[u.role]}{u.vehicle ? ` · ${u.vehicle} ${u.plate}` : ''}</div>
              </div>
              <Stars rating={u.rating} />
              <span className={`pill ${u.status}`}>{u.deleted_at ? 'Eliminada' : STATUS_LABEL[u.status]}</span>
            </button>
          ))}
          <MoreButton list={usersList} />
        </>
      )}

      {tab === 'topups' && <Topups topups={topups} status={topStatus} setStatus={setTopStatus} call={call} token={token} reload={load} onError={setError} />}
      {tab === 'settings' && <Settings call={call} onError={setError} />}
      {tab === 'rentals' && can('rentals') && <AdminRentals call={call} token={token} can={can} onError={setError} />}
      {tab === 'monitor' && can('monitor') && <Monitor call={call} onError={setError} />}

      {tab === 'reports' && (
        <>
          <div className="chips">
            <button className={repStatus === 'open' ? 'on' : ''} onClick={() => setRepStatus('open')}>Abiertos</button>
            <button className={repStatus === 'resolved' ? 'on' : ''} onClick={() => setRepStatus('resolved')}>Resueltos</button>
          </div>
          {reports.length === 0 && <Empty title={`No hay reportes ${repStatus === 'open' ? 'abiertos' : 'resueltos'}`} />}
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
            <input aria-label="Nombre" placeholder="Nombre" value={staffForm.name} onChange={(e) => setStaffForm({ ...staffForm, name: e.target.value })} required />
            <input aria-label="Teléfono (8 dígitos)" placeholder="Teléfono (8 dígitos)" inputMode="tel" value={staffForm.phone} onChange={(e) => setStaffForm({ ...staffForm, phone: e.target.value })} required />
            <select aria-label="Rol" value={staffForm.role} onChange={(e) => setStaffForm({ ...staffForm, role: e.target.value })}>
              <option value="support">Soporte: ve usuarios y viajes y atiende emergencias</option>
              <option value="admin">Administrador: además aprueba, bloquea y revisa documentos</option>
            </select>
            <p className="muted small">Se genera una contraseña temporal que verás una sola vez; la persona la cambiará al entrar.</p>
            <button className="primary">Crear cuenta</button>
          </form>
          {!staffList.loaded && <Loading />}
          {staff.filter((u) => !u.deleted_at).map((u) => (
            <button className="ucard click" key={u.id} onClick={() => setDetailId(u.id)}>
              <Avatar name={u.name} />
              <div className="grow left-text">
                <b>{u.name}</b> <span className="muted">· {u.phone}</span>
                <div className="muted small">{ROLE_LABEL[u.role]}{u.must_change_password ? ' · aún no cambia su contraseña temporal' : ''}</div>
              </div>
              <span className={`pill ${u.status}`}>{STATUS_LABEL[u.status]}</span>
            </button>
          ))}
        </>
      )}

      {tab === 'perms' && can('staff.manage') && <Permissions call={call} onError={setError} />}
      {tab === 'audit' && !auditList.loaded && <Loading />}
      {tab === 'audit' && (
        <div className="tablewrap">
          <table>
            <thead><tr><th>Cuándo</th><th>Quién</th><th>Qué hizo</th><th>Sobre</th><th>Detalle</th></tr></thead>
            <tbody>
              {auditList.items.map((l) => (
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
          {auditList.loaded && auditList.items.length === 0 && <Empty title="Todavía no hay movimientos" />}
        </div>
      )}
      {tab === 'audit' && <MoreButton list={auditList} />}

      {detailId && (
        <UserDetail
          userId={detailId}
          me={me}
          perms={perms}
          call={call}
          token={token}
          onClose={() => setDetailId(null)}
          onChanged={() => { load(); reloadTab(); }}
        />
      )}
      {docsUser && (
        <DocsModal
          user={[...pending, ...shown].find((u) => u.id === docsUser.id) || docsUser}
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
