// App de Android/iPhone (Capacitor): la app de la tienda carga ktrachogo.com y le agrega lo que el navegador no puede.
// En la web normal nada de esto se usa (isNative() es falso y todo sigue igual que antes).
import { Capacitor, registerPlugin } from '@capacitor/core';

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
