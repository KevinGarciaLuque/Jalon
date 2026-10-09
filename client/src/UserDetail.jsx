import { useCallback, useEffect, useState } from 'react';
import { lempiras } from './lib.js';
import { Stars } from './components.jsx';
import DocsModal from './DocsModal.jsx';

export const ROLE_LABEL = { passenger: 'Pasajero', driver: 'Conductor', admin: 'Administrador', superadmin: 'Superadministrador', support: 'Soporte' };
export const STATUS_LABEL = { pending: 'Pendiente', active: 'Activa', blocked: 'Bloqueada' };
export const isStaffRole = (r) => ['superadmin', 'admin', 'support'].includes(r);

export const ACTION_LABEL = {
  'staff.create': 'Creó una cuenta del personal',
  'staff.role': 'Cambió el rol',
  'user.approve': 'Aprobó al conductor',
  'user.block': 'Bloqueó la cuenta',
  'user.unblock': 'Desbloqueó la cuenta',
  'user.edit': 'Editó los datos',
  'user.reset_password': 'Restableció la contraseña',
  'user.delete': 'Eliminó la cuenta',
  'doc.reject': 'Rechazó un documento',
  'doc.view': 'Abrió los documentos',
  'chat.view': 'Leyó el chat de un viaje con emergencia o reporte',
  'report.resolve': 'Resolvió un reporte',
  'user.self_delete': 'Eliminó su propia cuenta',
  '2fa.enable': 'Activó la verificación en dos pasos',
  '2fa.reset': 'Restableció la verificación en dos pasos',
  '2fa.backup_codes': 'Generó códigos de respaldo nuevos',
  'alert.resolve': 'Atendió una emergencia',
  'ride.cancel': 'Canceló un viaje',
};

const FIELD = { name: 'nombre', phone: 'teléfono', vehicle: 'vehículo', plate: 'placa' };
const DOC = { photo: 'foto', license: 'licencia', registration: 'matrícula' };

// Resumen legible de los detalles de una anotación del registro
export function detailText(action, d) {
  if (!d) return '';
  if (action === 'staff.role') return `${ROLE_LABEL[d.from]} → ${ROLE_LABEL[d.to]}`;
  if (action === 'staff.create') return ROLE_LABEL[d.role];
  if (action === 'user.edit') return (d.changed || []).map((k) => FIELD[k] || k).join(', ');
  if (action === 'doc.reject') return `${DOC[d.type] || d.type}${d.note ? `: ${d.note}` : ''}`;
  if (action === 'ride.cancel' || action === 'chat.view') return `viaje #${d.ride}`;
  if (action === 'report.resolve') return `reporte #${d.report}`;
  if (action === 'alert.resolve') return `alerta #${d.alert}`;
  if (action === 'user.delete') return ROLE_LABEL[d.role] || '';
  return '';
}

const when = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' });

// Contraseña temporal: se muestra una sola vez
export function TempPassword({ who, password, onClose }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try { await navigator.clipboard.writeText(password); setCopied(true); } catch { window.prompt('Copia la contraseña:', password); }
  }
  return (
    <div className="overlay top">
      <div className="overlay-head"><b>Contraseña temporal</b></div>
      <div className="overlay-body">
        <p>Entrégale esta contraseña a <b>{who}</b>. <b>Solo se muestra ahora</b>; al entrar tendrá que cambiarla.</p>
        <div className="temp">{password}</div>
        <button className="primary" onClick={copy}>{copied ? '✓ Copiada' : 'Copiar'}</button>
        <button onClick={onClose}>Listo, ya la anoté</button>
      </div>
    </div>
  );
}

// Ficha completa de un usuario con las acciones que el rol de quien mira permite
export default function UserDetail({ userId, me, perms, call, token, onClose, onChanged }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [edit, setEdit] = useState(null);
  const [temp, setTemp] = useState(null);
  const [showDocs, setShowDocs] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => call(`users/${userId}`).then(setData).catch((e) => setError(e.message)), [call, userId]);
  useEffect(() => { load(); }, [load]);

  async function run(fn, after) {
    setBusy(true);
    setError('');
    try {
      await fn();
      await load();
      onChanged();
      after?.();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }

  if (!data) {
    return (
      <div className="overlay top">
        <div className="overlay-head"><b>Usuario</b><button className="link" onClick={onClose}>Cerrar ✕</button></div>
        <div className="overlay-body">{error ? <div className="error">{error}</div> : <div className="pulse">Cargando…</div>}</div>
      </div>
    );
  }

  const { user: u, stats, rides, docs, history, rating } = data;
  const can = (p) => perms.includes(p);
  const staffTarget = isStaffRole(u.role);
  // Lo mismo que valida el servidor: no se toca a un superadmin ni a uno mismo, y el personal solo lo gestiona el superadmin
  const touchable = !u.deleted_at && u.id !== me.id && u.role !== 'superadmin' && (!staffTarget || can('staff.manage'));
  const set = (k) => (e) => setEdit({ ...edit, [k]: e.target.value });
  const fields = u.role === 'driver' ? ['name', 'phone', 'vehicle', 'plate'] : ['name', 'phone'];
  const placeholder = { name: 'Nombre', phone: 'Teléfono (8 dígitos)', vehicle: 'Vehículo', plate: 'Placa' };

  const status = (s) => run(() => call(`users/${u.id}/status`, { status: s }));
  const saveEdit = () => {
    const changes = Object.fromEntries(Object.entries(edit).filter(([k, v]) => v !== (u[k] ?? '')));
    run(() => call(`users/${u.id}`, changes, 'PATCH'), () => setEdit(null));
  };
  const reset = () => {
    if (!window.confirm(`¿Restablecer la contraseña de ${u.name}? Se cerrarán sus sesiones y tendrá que cambiarla al entrar.`)) return;
    run(async () => setTemp((await call(`users/${u.id}/reset-password`, {})).tempPassword));
  };
  const remove = () => {
    const word = window.prompt(`Esto elimina los datos personales y documentos de ${u.name} y no se puede deshacer.\nEscribe ELIMINAR para confirmar:`);
    if (word !== 'ELIMINAR') return;
    run(() => call(`users/${u.id}/delete`, {}), onClose);
  };
  const changeRole = (role) => run(() => call(`staff/${u.id}/role`, { role }));
  const reset2fa = () => {
    if (!window.confirm(`¿Restablecer la verificación en dos pasos de ${u.name}? Se cerrarán sus sesiones y tendrá que activarla de nuevo al entrar (úsalo si perdió su teléfono).`)) return;
    run(() => call(`users/${u.id}/reset-2fa`, {}));
  };

  return (
    <div className="overlay top">
      <div className="overlay-head">
        <b>{u.name}</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body wide">
        {error && <div className="error">{error}</div>}

        <div className="req">
          <div className="row between">
            <span><span className={`pill ${u.status}`}>{u.deleted_at ? 'Eliminada' : STATUS_LABEL[u.status]}</span> <b>{ROLE_LABEL[u.role]}</b></span>
            <Stars rating={rating} />
          </div>
          <div>📞 {u.phone}{u.online && ' · 🟢 en línea'}</div>
          {u.vehicle && <div className="muted">🚕 {u.vehicle} · {u.plate}</div>}
          <div className="muted small">
            Registrado el {when(u.created_at)}
            {u.terms_accepted_at && ` · aceptó los términos v${u.terms_version} el ${when(u.terms_accepted_at)}`}
          </div>
          {staffTarget && <div className={u.totp_enabled ? 'ok small' : 'muted small'}>{u.totp_enabled ? '🔐 Verificación en dos pasos activa' : 'Verificación en dos pasos: pendiente de activar'}</div>}
          {u.must_change_password ? <div className="hint">Tiene una contraseña temporal pendiente de cambiar.</div> : null}
        </div>

        <div className="stats">
          <div><b>{stats.asPassenger}</b><span>Viajes como pasajero</span></div>
          <div><b>{stats.asDriver}</b><span>Viajes como conductor</span></div>
          <div><b>{stats.completed}</b><span>Completados</span></div>
          <div><b>{stats.cancelled}</b><span>Cancelados</span></div>
          <div><b>{lempiras(stats.money)}</b><span>Movido en viajes</span></div>
        </div>

        {touchable && (
          <div className="actions-bar">
            {can('users.manage') && !edit && <button disabled={busy} onClick={() => setEdit(Object.fromEntries(fields.map((k) => [k, u[k] ?? ''])))}>✏️ Editar datos</button>}
            {u.role === 'driver' && can('docs') && <button onClick={() => setShowDocs(true)}>📄 Documentos ({docs?.filter((d) => d.status === 'uploaded').length ?? 0}/3)</button>}
            {can('users.manage') && u.status === 'pending' && (
              <button className="primary" disabled={busy || (u.role === 'driver' && (docs?.filter((d) => d.status === 'uploaded').length ?? 0) < 3)} onClick={() => status('active')}>✓ Aprobar</button>
            )}
            {can('users.manage') && u.status !== 'blocked' && (
              <button className="danger" disabled={busy} onClick={() => window.confirm(`¿Bloquear a ${u.name}? Se cancelarán sus viajes activos.`) && status('blocked')}>Bloquear</button>
            )}
            {can('users.manage') && u.status === 'blocked' && <button disabled={busy} onClick={() => status('active')}>Desbloquear</button>}
            {can('users.manage') && <button disabled={busy} onClick={reset}>🔑 Restablecer contraseña</button>}
            {staffTarget && can('staff.manage') && (
              <select value={u.role} disabled={busy} onChange={(e) => changeRole(e.target.value)} aria-label="Rol">
                <option value="admin">Administrador</option>
                <option value="support">Soporte</option>
              </select>
            )}
            {staffTarget && can('staff.manage') && u.totp_enabled ? <button disabled={busy} onClick={reset2fa}>🔐 Restablecer verificación en dos pasos</button> : null}
            {can('staff.manage') && <button className="danger" disabled={busy} onClick={remove}>🗑 Eliminar cuenta</button>}
          </div>
        )}
        {!touchable && !u.deleted_at && u.id !== me.id && u.role === 'superadmin' && <p className="muted small">Un superadministrador no se puede modificar.</p>}
        {u.id === me.id && <p className="muted small">Esta es tu cuenta: cambia tu contraseña desde Cuenta.</p>}

        {edit && (
          <div className="req">
            <b>Editar datos</b>
            {fields.map((k) => <input key={k} placeholder={placeholder[k]} value={edit[k]} onChange={set(k)} />)}
            <div className="row">
              <button className="primary" disabled={busy} onClick={saveEdit}>Guardar</button>
              <button disabled={busy} onClick={() => setEdit(null)}>Cancelar</button>
            </div>
          </div>
        )}

        <b>Últimos viajes</b>
        {rides.length === 0 && <p className="muted">Todavía no tiene viajes.</p>}
        {rides.map((r) => (
          <div className="req" key={r.id}>
            <div className="row between"><b>#{r.id} · {r.dest_text || 'Destino en el mapa'}</b><span className="tag">{lempiras(r.final_price ?? r.offered_price)}</span></div>
            <div className="muted small">{when(r.created_at)} · {r.distance_km.toFixed(1)} km · {r.status}{r.cancelled_by ? ` (${r.cancelled_by})` : ''}{r.other_name ? ` · con ${r.other_name}` : ''}</div>
          </div>
        ))}

        {history && (
          <>
            <b>Movimientos del personal sobre esta cuenta</b>
            {history.length === 0 && <p className="muted">Sin movimientos.</p>}
            {history.map((h) => (
              <div className="muted small" key={h.id}>
                {when(h.created_at)} · <b>{h.actor}</b>: {ACTION_LABEL[h.action] || h.action} {detailText(h.action, h.details)}
              </div>
            ))}
          </>
        )}
      </div>

      {temp && <TempPassword who={u.name} password={temp} onClose={() => setTemp(null)} />}
      {showDocs && (
        <DocsModal
          user={u}
          call={call}
          token={token}
          canManage={can('users.manage')}
          onClose={() => setShowDocs(false)}
          onApprove={async () => { await status('active'); setShowDocs(false); }}
          onChanged={() => { load(); onChanged(); }}
        />
      )}
    </div>
  );
}
