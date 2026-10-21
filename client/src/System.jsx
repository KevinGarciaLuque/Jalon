import { useCallback, useEffect, useState } from 'react';
import { Loading } from './components.jsx';

// Estado del sistema (solo el superadmin): lo que falta antes de abrir al público y qué versión está publicada
const GROUPS = [['seguridad', 'Seguridad'], ['avisos', 'Registro y avisos'], ['datos', 'Datos'], ['mapas', 'Mapas'], ['version', 'Publicación']];
// Cada estado lleva palabra e ícono (no solo color)
const STATUS = { ok: ['active', '✓ Listo'], warn: ['pending', '! Revisar'], bad: ['blocked', '✕ Falta'], info: ['', 'i Dato'] };
const when = (d) => new Date(d).toLocaleString('es-HN', { dateStyle: 'medium', timeStyle: 'short' });

export default function System({ call, onError }) {
  const [data, setData] = useState(null);
  const load = useCallback(async () => {
    try {
      setData(await call('system'));
    } catch (e) {
      onError(e.message);
    }
  }, [call, onError]);
  useEffect(() => { load(); }, [load]);
  if (!data) return <Loading />;
  const { version, summary, items } = data;

  return (
    <>
      <div className="req">
        <b>Versión publicada</b>
        <span>{version.commit ? <>Commit <code>{version.commit}</code>{version.message ? ` · ${version.message}` : ''}</> : 'Sin dato de Railway (servidor local).'}</span>
        <span className="muted small">Encendido desde {when(version.startedAt)} · Node {version.node}</span>
        <span className="muted small">Si después de subir un cambio a GitHub este commit no cambia, Railway no lo publicó: revisa Deployments.</span>
      </div>
      <p className={summary.bad ? 'error' : 'muted'} role="status">
        {summary.bad ? `Faltan ${summary.bad} cosa(s) antes de abrir al público` : 'No falta nada indispensable'}{summary.warn ? ` y conviene revisar ${summary.warn}.` : '.'}
      </p>
      {GROUPS.map(([key, title]) => {
        const list = items.filter((i) => i.group === key);
        if (!list.length) return null;
        return (
          <section key={key} className="req" aria-label={title}>
            <b>{title}</b>
            {list.map((i) => (
              <div key={i.label} className="row between">
                <span>
                  <span>{i.label}</span>
                  <br />
                  <span className="muted small">{i.detail}</span>
                </span>
                <span className={`pill ${STATUS[i.status][0]}`}>{STATUS[i.status][1]}</span>
              </div>
            ))}
          </section>
        );
      })}
      <button onClick={load}>Volver a revisar</button>
    </>
  );
}
