import { useEffect, useState } from 'react';
import { apiGet, pushState, pushSupported, enablePush } from './lib.js';
import GeoHelp, { IOS, STANDALONE, geoPermission } from './GeoHelp.jsx';

// Barra que avisa cuando la ubicación o las notificaciones están apagadas, con un botón para arreglarlo.
// Una sola a la vez (primero la ubicación). «Ahora no» la esconde 3 días. No sale durante un viaje (`hidden`).
// Si la persona bloqueó el permiso, el celular ya no deja volver a preguntar: se abre la pantalla guiada (GeoHelp) con los pasos
// para su teléfono. Se abre sola una vez por sesión, y desde cualquier pantalla con el evento «ktracho:geo-help».
const LATER_MS = 3 * 24 * 60 * 60 * 1000;
const laterKey = (kind) => `jalon-perms-later-${kind}`;
const snoozed = (kind) => { try { return Date.now() - Number(localStorage.getItem(laterKey(kind)) || 0) < LATER_MS; } catch { return false; } };
const snooze = (kind) => { try { localStorage.setItem(laterKey(kind), String(Date.now())); } catch { /* sin almacenamiento: solo por esta vez */ } };


const STEPS = {
  push: IOS
    ? ['Abre «Ajustes» del iPhone → «Notificaciones» → «Ktracho GO».', 'Activa «Permitir notificaciones».', 'Vuelve aquí y toca «Activar».']
    : ['Si usas Chrome: toca el candado 🔒 junto a la dirección → «Permisos» → «Notificaciones» → «Permitir».', 'Si la instalaste: mantén presionado el ícono de Ktracho GO → «Información de la app» → «Notificaciones» → actívalas.', 'Vuelve aquí y toca «Activar».'],
  install: ['En Safari, toca el botón Compartir ⬆️ (abajo).', 'Elige «Agregar a pantalla de inicio» y toca «Agregar».', 'Abre Ktracho GO desde ese ícono nuevo y activa los avisos.'],
};

const HELP_SEEN = 'jalon-geo-help-shown';
const helpShown = () => { try { return sessionStorage.getItem(HELP_SEEN) === '1'; } catch { return false; } };
const markHelp = () => { try { sessionStorage.setItem(HELP_SEEN, '1'); } catch { /* sin almacenamiento */ } };

export default function PermsBar({ token, role, geoDenied, onGeoRetry, hidden }) {
  const [geo, setGeo] = useState(null);
  const [push, setPush] = useState(null); // 'off' | 'denied' | 'install' | null (todo bien o no aplica)
  const [later, setLater] = useState({ geo: snoozed('geo'), push: snoozed('push') });
  const [steps, setSteps] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [help, setHelp] = useState(false); // pantalla guiada para activar la ubicación

  // Ubicación: el permiso del navegador; si está concedido pero no llega posición, el GPS está apagado
  useEffect(() => {
    let alive = true;
    let status;
    const read = () => alive && setGeo(status?.state || null);
    navigator.permissions?.query({ name: 'geolocation' }).then((st) => { status = st; read(); st.onchange = read; }).catch(() => {});
    return () => { alive = false; if (status) status.onchange = null; };
  }, []);

  // Notificaciones: solo si el servidor las tiene configuradas
  useEffect(() => {
    let alive = true;
    async function check() {
      if (!pushSupported()) { if (alive) setPush(IOS && !STANDALONE ? 'install' : null); return; }
      try {
        const { key } = await apiGet('push/key', token);
        if (!key) return alive && setPush(null);
        const st = await pushState();
        if (alive) setPush(st === 'off' || st === 'denied' ? st : null);
      } catch { /* sin conexión: se revisa la próxima vez */ }
    }
    check();
    const onVisible = () => { if (!document.hidden) { check(); geoPermission().then((s) => alive && s && setGeo(s)); } };
    document.addEventListener('visibilitychange', onVisible);
    return () => { alive = false; document.removeEventListener('visibilitychange', onVisible); };
  }, [token]);

  // Qué toca mostrar: primero la ubicación
  const geoProblem = geo === 'denied' ? 'denied' : geoDenied ? (geo === 'granted' ? 'gps' : 'prompt') : null;
  const kind = hidden ? null : geoProblem && !later.geo ? 'geo' : push && !later.push ? 'push' : null;
  useEffect(() => { setSteps(false); setError(''); }, [kind, geoProblem, push]);
  // Las demás pantallas (el aviso «No sabemos dónde estás») abren la ayuda con este evento
  useEffect(() => {
    const open = () => setHelp(true);
    window.addEventListener('ktracho:geo-help', open);
    return () => window.removeEventListener('ktracho:geo-help', open);
  }, []);
  // Ubicación bloqueada o GPS sin responder: la ayuda se abre sola una vez por sesión (no en pleno viaje ni si tocó «Ahora no»)
  useEffect(() => {
    if (!hidden && !later.geo && (geoProblem === 'denied' || geoProblem === 'gps') && !helpShown()) { markHelp(); setHelp(true); }
  }, [geoProblem, hidden, later.geo]);
  const fixed = () => { setHelp(false); setGeo('granted'); onGeoRetry?.(); };
  const helpView = help && <GeoHelp role={role} onClose={() => setHelp(false)} onFixed={fixed} />;
  if (!kind) return helpView || null;

  const driver = role === 'driver';
  const close = () => { snooze(kind); setLater((l) => ({ ...l, [kind]: true })); };

  async function activatePush() {
    setBusy(true);
    setError('');
    try { await enablePush(token); setPush(null); } catch (e) {
      // Los errores del navegador vienen en inglés (DOMException): se explican en palabras simples
      setError(e instanceof DOMException ? 'No se pudieron activar en este celular. Intenta otra vez en un momento.' : e.message); setPush(await pushState().catch(() => 'off') === 'denied' ? 'denied' : 'off'); } finally { setBusy(false); }
  }
  function askGeo() {
    setBusy(true);
    setError('');
    navigator.geolocation.getCurrentPosition(
      () => { setBusy(false); setGeo('granted'); onGeoRetry?.(); },
      async () => { setBusy(false); const s = await geoPermission(); if (s) setGeo(s); setHelp(true); }, // no se pudo: los pasos para su celular
      { enableHighAccuracy: true, timeout: 15000 }
    );
  }

  let icon, text, action, stepsKey;
  if (kind === 'geo') {
    icon = '📍';
    stepsKey = 'geo';
    if (geoProblem === 'denied') {
      text = driver ? 'Tu ubicación está bloqueada: sin ella no te llegan viajes cercanos.' : 'Tu ubicación está bloqueada: el conductor no sabrá dónde recogerte.';
      action = <button className="primary sm" onClick={() => setHelp(true)}>Cómo activarla</button>;
    } else if (geoProblem === 'gps') {
      text = 'No encontramos tu ubicación. Revisa que el GPS del celular esté encendido.';
      action = <button className="primary sm" onClick={() => setHelp(true)}>Cómo activarla</button>;
    } else {
      text = driver ? 'Activa tu ubicación: sin GPS no te llegan viajes cercanos.' : 'Activa tu ubicación para que el conductor te encuentre.';
      action = <button className="primary sm" disabled={busy} onClick={askGeo}>{busy ? 'Activando…' : 'Activar'}</button>;
    }
  } else {
    icon = '🔔';
    const why = driver ? 'para que te lleguen viajes aunque cierres la app' : 'para enterarte de tus ofertas y de tu conductor aunque cierres la app';
    if (push === 'install') {
      stepsKey = 'install';
      text = `Agrega Ktracho GO a tu pantalla de inicio ${why}.`;
      action = <button className="primary sm" onClick={() => setSteps((v) => !v)}>Cómo hacerlo</button>;
    } else if (push === 'denied') {
      stepsKey = 'push';
      text = `Bloqueaste las notificaciones. Actívalas ${why}.`;
      action = <button className="primary sm" onClick={() => setSteps((v) => !v)}>Cómo activarlas</button>;
    } else {
      text = `Tienes las notificaciones apagadas. Actívalas ${why}.`;
      action = <button className="primary sm" disabled={busy} onClick={activatePush}>{busy ? 'Activando…' : 'Activar'}</button>;
    }
  }

  return (
    <>
    {helpView}
    <div className={`perms-bar perms-${kind}`} role="status">
      <span className="perms-icon" aria-hidden="true">{icon}</span>
      <span className="perms-text">{text}</span>
      <div className="perms-actions">
        {action}
        <button className="link" onClick={close}>Ahora no</button>
      </div>
      {steps && stepsKey && (
        <ol className="perms-steps small">
          {STEPS[stepsKey].map((s) => <li key={s}>{s}</li>)}
        </ol>
      )}
      {error && <div className="error small perms-error">{error}</div>}
    </div>
    </>
  );
}
