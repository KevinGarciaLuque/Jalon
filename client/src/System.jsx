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
  // Manda un error de prueba: si llega, en sentry.io aparece «Prueba de Sentry desde el panel»
  const [sentry, setSentry] = useState(null);
  async function testSentry() {
    setSentry({ busy: true });
    try {
      await call('system/sentry-test', {});
      setSentry({ ok: true, text: 'Enviado. En unos segundos aparece en sentry.io como «Prueba de Sentry desde el panel».' });
    } catch (e) {
      setSentry({ ok: false, text: e.message });
    }
  }
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
                  {i.label.includes('Sentry') && i.status === 'ok' && (
                    <>
                      <br />
                      <button className="small" onClick={testSentry} disabled={sentry?.busy}>{sentry?.busy ? 'Enviando…' : 'Probar Sentry'}</button>
                      {sentry?.text && <span className={`small ${sentry.ok ? 'muted' : 'error'}`} role="status"> {sentry.text}</span>}
                    </>
                  )}
                </span>
                <span className={`pill ${STATUS[i.status][0]}`}>{STATUS[i.status][1]}</span>
              </div>
            ))}
          </section>
        );
      })}
      <Backups call={call} onDone={load} />
      <button onClick={load}>Volver a revisar</button>
    </>
  );
}

const BACKUP_STATUS = { ok: ['active', '✓ Listo'], failed: ['blocked', '✕ Falló'], running: ['pending', '… Haciéndose'] };
const size = (b) => (b >= 1048576 ? `${(b / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(b / 1024))} kB`);

// Los últimos respaldos y el botón para hacer uno ahora (mientras se hace, se revisa cada 5 segundos)
function Backups({ call, onDone }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setData(await call('backups')); } catch (e) { setError(e.message); }
  }, [call]);
  useEffect(() => { load(); }, [load]);
  const running = data?.backups.some((b) => b.status === 'running');
  useEffect(() => {
    if (!running) return undefined;
    const t = setInterval(async () => {
      const next = await call('backups').catch(() => null);
      if (!next) return;
      setData(next);
      if (!next.backups.some((b) => b.status === 'running')) onDone();
    }, 5000);
    return () => clearInterval(t);
  }, [running, call, onDone]);
  async function now() {
    setError('');
    try {
      await call('backups/run', {});
      await load();
    } catch (e) {
      setError(e.message);
    }
  }
  if (!data) return null;
  return (
    <section className="req" aria-label="Respaldos">
      <b>Respaldos</b>
      <span className="muted small">
        {data.configured
          ? `Cada noche a las ${data.hour}:00 se respaldan la base y los documentos, cifrados y fuera de Railway. Se guardan ${data.keepDays} días.`
          : `Apagados: faltan ${data.missing.join(', ')} en Railway.`}
      </span>
      {data.backups.slice(0, 5).map((b) => (
        <div key={b.id} className="row between">
          <span>
            <span>{when(b.started_at)}{b.trigger === 'manual' ? ' · a mano' : ''}</span>
            <br />
            <span className="small muted">
              {b.status === 'ok' ? `Base ${size(b.bytes)} · ${b.rows_count} filas · ${b.files_uploaded} documento(s) nuevos de ${b.files_total}` : b.status === 'failed' ? `Motivo: ${b.error}` : 'Respaldando la base y los documentos…'}
            </span>
          </span>
          <span className={`pill ${BACKUP_STATUS[b.status][0]}`}>{BACKUP_STATUS[b.status][1]}</span>
        </div>
      ))}
      {data.configured && <button onClick={now} disabled={running}>{running ? 'Respaldando…' : 'Respaldar ahora'}</button>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
