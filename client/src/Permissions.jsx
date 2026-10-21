import { useCallback, useEffect, useState } from 'react';
import { Loading } from './components.jsx';

const ROLE_COLUMNS = [['admin', 'Administrador'], ['support', 'Soporte'], ['driver', 'Conductor'], ['passenger', 'Pasajero']];
const GROUPS = [['panel', 'Panel del personal'], ['app', 'App de pasajeros y conductores']];

// Superadmin: qué módulos ve cada rol. Para una persona en particular, se cambia en su ficha.
export default function Permissions({ call, onError }) {
  const [cfg, setCfg] = useState(null);
  const [draft, setDraft] = useState(null); // { rol: Set(módulos) } con los cambios sin guardar
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);

  const load = useCallback(() => call('permissions').then((c) => {
    setCfg(c);
    setDraft(Object.fromEntries(Object.entries(c.roles).map(([r, p]) => [r, new Set(p)])));
  }).catch((e) => onError(e.message)), [call, onError]);
  useEffect(() => { load(); }, [load]);

  if (!cfg || !draft) return <Loading />;
  const toggle = (role, key) => {
    setSaved(false);
    const next = new Set(draft[role]);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    setDraft({ ...draft, [role]: next });
  };
  const changed = ROLE_COLUMNS.map(([r]) => r).filter((r) => [...draft[r]].sort().join() !== [...cfg.roles[r]].sort().join());

  async function save() {
    setBusy(true);
    try {
      for (const role of changed) await call(`permissions/${role}`, { perms: [...draft[role]] }, 'PUT');
      await load();
      setSaved(true);
    } catch (e) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="req">
      <b>Qué ve cada rol</b>
      <p className="muted small">El superadministrador ve todo. Ajustes y Personal son solo suyos. Para darle o quitarle un módulo a una persona en particular, ábrela en Usuarios o Personal.</p>
      <div className="tablewrap">
        <table className="perms">
          <thead>
            <tr><th>Módulo</th>{ROLE_COLUMNS.map(([r, label]) => <th key={r}>{label}</th>)}</tr>
          </thead>
          {GROUPS.map(([g, title]) => (
            <tbody key={g}>
              <tr className="group"><th colSpan={ROLE_COLUMNS.length + 1}>{title}</th></tr>
              {cfg.modules.filter((m) => m.group === g).map((m) => (
                <tr key={m.key}>
                  <th scope="row">{m.label}</th>
                  {ROLE_COLUMNS.map(([r, label]) => (
                    <td key={r}>
                      {m.roles.includes(r)
                        ? <input type="checkbox" aria-label={`${m.label}: ${label}`} checked={draft[r].has(m.key)} disabled={busy} onChange={() => toggle(r, m.key)} />
                        : <span className="muted" aria-hidden="true">—</span>}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>
      <button className="primary" disabled={busy || !changed.length} onClick={save}>{busy ? 'Guardando…' : changed.length ? 'Guardar cambios' : 'Sin cambios'}</button>
      {saved && <div className="hint ok">Permisos guardados. Cada persona los ve la próxima vez que abra la app o el panel.</div>}
    </div>
  );
}
