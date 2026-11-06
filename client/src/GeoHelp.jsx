import { useEffect, useState } from 'react';
import { Panel } from './Menu.jsx';

// Pantalla guiada para activar la ubicación. Una página web no puede encender el GPS ni abrir los Ajustes del celular,
// así que se muestran los pasos exactos para su teléfono y navegador, y un botón para comprobar al instante si ya funciona.
const UA = navigator.userAgent;
export const IOS = /iphone|ipad|ipod/i.test(UA) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ANDROID = /android/i.test(UA);
export const STANDALONE = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone === true;
const browserOf = () => {
  if (IOS) return /CriOS/i.test(UA) ? 'chrome' : /FxiOS/i.test(UA) ? 'firefox' : 'safari';
  if (/SamsungBrowser/i.test(UA)) return 'samsung';
  if (/Firefox/i.test(UA)) return 'firefox';
  return 'chrome';
};
const BROWSER_NAME = { safari: 'Safari', chrome: 'Chrome', samsung: 'Samsung Internet', firefox: 'Firefox' };

export async function geoPermission() {
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch { return null; } // 'granted' | 'prompt' | 'denied'
}

// Los pasos según el teléfono, el navegador y el problema ('denied' = bloqueada para este sitio; 'gps' = el GPS no responde)
function stepsFor(device, browser, problem) {
  const app = BROWSER_NAME[browser];
  if (device === 'ios') {
    const phone = { t: 'Enciende la localización del iPhone', d: 'Abre «Ajustes» → «Privacidad y seguridad» → «Localización» y actívala.' };
    const perm = browser === 'safari'
      ? { t: 'Dale permiso a Safari', d: 'En esa misma pantalla, baja hasta «Sitios web de Safari» → elige «Al usar la app» y activa «Ubicación exacta».' }
      : { t: `Dale permiso a ${app}`, d: `En esa misma pantalla, busca «${app}» → elige «Al usar la app» y activa «Ubicación exacta».` };
    const site = STANDALONE
      ? { t: 'Cierra y vuelve a abrir Ktracho GO', d: 'Desliza la app hacia arriba para cerrarla por completo y ábrela otra vez desde su ícono.' }
      : browser === 'safari'
        ? { t: 'Permite la ubicación a Ktracho GO', d: 'Vuelve a Safari, toca «aA» junto a la dirección → «Configuración del sitio web» → «Ubicación» → «Permitir».' }
        : { t: 'Permite la ubicación a Ktracho GO', d: `En ${app}, toca el candado 🔒 junto a la dirección → «Ubicación» → «Permitir».` };
    if (problem === 'gps') return [phone, perm, { t: 'Busca mejor señal', d: 'Si estás dentro de un edificio, acércate a una ventana o sal un momento.' }];
    return [phone, perm, site];
  }
  if (device === 'android') {
    const phone = { t: 'Enciende la ubicación del celular', d: 'Desliza hacia abajo desde arriba de la pantalla y toca «Ubicación» para encenderla.' };
    const perm = STANDALONE
      ? { t: 'Dale permiso a Ktracho GO', d: 'Mantén presionado el ícono de Ktracho GO → «Información de la app» → «Permisos» → «Ubicación» → «Permitir solo mientras se usa la app» y activa «Usar ubicación precisa».' }
      : { t: `Dale permiso a ${app}`, d: `Abre «Ajustes» del celular → «Aplicaciones» → «${app}» → «Permisos» → «Ubicación» → «Permitir solo mientras se usa la app» y activa «Usar ubicación precisa».` };
    const site = { t: 'Permite la ubicación a Ktracho GO', d: `En ${app}, toca el ícono a la izquierda de ktrachogo.com → «Permisos» → «Ubicación» → «Permitir».` };
    if (problem === 'gps') return [phone, { t: 'Usa la ubicación precisa', d: 'En «Ajustes» → «Ubicación», activa «Precisión de la ubicación de Google» (o «Mejorar precisión»).' }, { t: 'Busca mejor señal', d: 'Si estás dentro de un edificio, acércate a una ventana o sal un momento.' }];
    return STANDALONE ? [phone, perm] : [phone, perm, site];
  }
  return [
    { t: 'Enciende la ubicación del equipo', d: 'En la configuración de tu dispositivo, activa la ubicación.' },
    { t: 'Permite la ubicación a Ktracho GO', d: 'Toca el candado 🔒 junto a la dirección de la página → «Ubicación» → «Permitir».' },
  ];
}

export default function GeoHelp({ role, onClose, onFixed }) {
  const [device, setDevice] = useState(IOS ? 'ios' : ANDROID ? 'android' : 'other');
  const browser = browserOf();
  const [problem, setProblem] = useState(null); // 'denied' | 'gps' | 'prompt'
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [tries, setTries] = useState(0);
  useEffect(() => { geoPermission().then((s) => setProblem(s === 'denied' ? 'denied' : s === 'granted' ? 'gps' : 'prompt')); }, []);

  // Pide la ubicación: si el permiso no se había pedido, sale la ventanita del celular; si ya funciona, se cierra
  function check() {
    setBusy(true);
    setMsg('');
    navigator.geolocation.getCurrentPosition(
      () => { setBusy(false); onFixed?.(); },
      async (e) => {
        setBusy(false);
        setTries((n) => n + 1);
        const s = await geoPermission();
        if (s === 'denied' || e.code === 1) {
          setProblem('denied');
          setMsg(IOS
            ? 'Todavía está bloqueada. Sigue los pasos de arriba; si ya los hiciste, cierra la app por completo y vuelve a abrirla.'
            : 'Todavía está bloqueada para Ktracho GO. Sigue los pasos de arriba y vuelve a intentar.');
        } else {
          setProblem('gps');
          setMsg('El permiso está bien, pero el GPS no responde. Revisa que la ubicación del celular esté encendida.');
        }
      },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
    );
  }

  const steps = stepsFor(device, browser, problem);
  const why = role === 'driver' ? 'Sin tu ubicación no te llegan viajes cercanos ni el pasajero ve dónde vienes.' : 'Sin tu ubicación el conductor no sabe dónde recogerte.';
  return (
    <Panel onClose={onClose} labelledBy="geo-help-title" className="geo-help">
      <div className="overlay-head">
        <b id="geo-help-title">📍 Activa tu ubicación</b>
        <button className="link" onClick={onClose}>Cerrar ✕</button>
      </div>
      <div className="overlay-body">
        <p className="geo-why">{why}</p>
        {problem === 'prompt' ? (
          <>
            <p className="muted small">Toca el botón y, cuando el celular pregunte, elige <b>«Permitir»</b>.</p>
            <button className="primary geo-go" disabled={busy} onClick={check}>{busy ? 'Buscando tu ubicación…' : 'Permitir mi ubicación'}</button>
          </>
        ) : problem && (
          <>
            <p className="muted small">
              {problem === 'denied' ? 'La ubicación está bloqueada para Ktracho GO. Por seguridad, la app no puede activarla sola: sigue estos pasos.' : 'Tu celular no nos está dando la ubicación. Sigue estos pasos.'}
            </p>
            <div className="seg geo-device" role="radiogroup" aria-label="Tu celular">
              <button type="button" role="radio" aria-checked={device === 'ios'} className={device === 'ios' ? 'on' : ''} onClick={() => setDevice('ios')}>iPhone</button>
              <button type="button" role="radio" aria-checked={device === 'android'} className={device === 'android' ? 'on' : ''} onClick={() => setDevice('android')}>Android</button>
            </div>
            <ol className="geo-steps">
              {steps.map((s, i) => (
                <li key={s.t}><i aria-hidden="true">{i + 1}</i><span><b>{s.t}</b><span className="muted">{s.d}</span></span></li>
              ))}
            </ol>
            <button className="primary geo-go" disabled={busy} onClick={check}>{busy ? 'Comprobando…' : 'Ya la activé, volver a intentar'}</button>
            {tries > 0 && IOS && problem === 'denied' && <button onClick={() => window.location.reload()}>Volver a abrir la app</button>}
          </>
        )}
        {msg && <div className="hint danger" role="alert">{msg}</div>}
        <button className="link" onClick={onClose}>{role === 'driver' ? 'Ahora no' : 'Ahora no: escribiré mi dirección'}</button>
      </div>
    </Panel>
  );
}
