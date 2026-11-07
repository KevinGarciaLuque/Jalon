// App de Android/iPhone (Capacitor): la app de la tienda carga ktrachogo.com y le agrega lo que el navegador no puede.
// En la web normal nada de esto se usa (isNative() es falso y todo sigue igual que antes).
import { Capacitor, registerPlugin } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';

export const isNative = () => Capacitor.isNativePlatform();

const BackgroundGeolocation = registerPlugin('BackgroundGeolocation');
let watcherId = null;

// GPS en segundo plano para el conductor en línea: sigue mandando su ubicación con la pantalla bloqueada o la app minimizada.
// Android muestra una notificación fija («Ktracho GO está usando tu ubicación») mientras esté activo, como exige el sistema.
export async function startBackgroundGps(onFix) {
  if (!isNative() || watcherId) return false;
  try {
    watcherId = await BackgroundGeolocation.addWatcher(
      {
        backgroundTitle: 'Ktracho GO · En línea',
        backgroundMessage: 'Compartiendo tu ubicación para recibir viajes y que el pasajero te vea llegar.',
        requestPermissions: true,
        stale: false,
        distanceFilter: 10, // metros
      },
      (loc, err) => {
        if (err || !loc) return;
        onFix({ lat: loc.latitude, lng: loc.longitude });
      }
    );
    return true;
  } catch {
    watcherId = null;
    return false;
  }
}

export async function stopBackgroundGps() {
  if (!watcherId) return;
  const id = watcherId;
  watcherId = null;
  await BackgroundGeolocation.removeWatcher({ id }).catch(() => {});
}

// ---- Notificaciones (Firebase) ----
// En la app nativa no hay service worker: cada celular recibe un token de Firebase y se lo damos al servidor para que le escriba.
const TOKEN_KEY = 'jalon-fcm-token';
const getToken = () => { try { return localStorage.getItem(TOKEN_KEY); } catch { return null; } };
const setToken = (t) => { try { t ? localStorage.setItem(TOKEN_KEY, t) : localStorage.removeItem(TOKEN_KEY); } catch { /* sin almacenamiento */ } };
let listening = false;
let onToken = null;
let onError = null;

function listen() {
  if (listening) return;
  listening = true;
  PushNotifications.addListener('registration', (t) => { setToken(t.value); onToken?.(t.value); });
  PushNotifications.addListener('registrationError', () => onError?.());
  // Al tocar una notificación se abre la pantalla que indica (la misma «url» que usa la web)
  PushNotifications.addListener('pushNotificationActionPerformed', (a) => {
    const url = a.notification?.data?.url;
    if (typeof url === 'string' && url.startsWith('/')) window.location.assign(url);
  });
}

// 'unsupported' | 'denied' | 'on' | 'off'
export async function nativePushState() {
  if (!isNative()) return 'unsupported';
  const p = await PushNotifications.checkPermissions();
  if (p.receive === 'denied') return 'denied';
  return p.receive === 'granted' && getToken() ? 'on' : 'off';
}

// Pide el permiso, registra el celular en Firebase y manda el token al servidor. `send(token)` lo guarda en el servidor.
export async function nativePushEnable(send) {
  listen();
  let p = await PushNotifications.checkPermissions();
  if (p.receive !== 'granted') p = await PushNotifications.requestPermissions();
  if (p.receive !== 'granted') throw new Error('Permiso denegado. Actívalo en «Información de la app» → «Notificaciones».');
  const token = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('No se pudo registrar este celular. Intenta otra vez en un momento.')), 15000);
    onToken = (t) => { clearTimeout(timer); resolve(t); };
    onError = () => { clearTimeout(timer); reject(new Error('No se pudo registrar este celular. Intenta otra vez en un momento.')); };
    PushNotifications.register();
  });
  await send(token, Capacitor.getPlatform());
}

// Si ya dio el permiso, se renueva el token en silencio (Firebase lo puede cambiar) y se le avisa al servidor
export async function nativePushSync(send) {
  if (!isNative()) return;
  listen();
  const p = await PushNotifications.checkPermissions();
  if (p.receive !== 'granted') return;
  onToken = (t) => send(t, Capacitor.getPlatform()).catch(() => {});
  await PushNotifications.register();
}

export async function nativePushDisable(remove) {
  const t = getToken();
  setToken(null);
  if (t) await remove(t);
  await PushNotifications.unregister().catch(() => {});
}
