import { useEffect, useState } from 'react';

// Avisa cuando se publicó una versión nueva (cada push que Railway publica) y la instala con un toque.
// Compara el número de esta app (__BUILD_ID__, puesto al compilar) con /version.json del servidor:
// cada 5 minutos y cada vez que la app vuelve a primer plano. Nunca recarga sola: la persona decide.
const CHECK_MS = 5 * 60 * 1000;

export default function UpdateBar() {
  const [fresh, setFresh] = useState(false); // hay una versión nueva publicada
  const [later, setLater] = useState(false); // «Más tarde»: se esconde hasta la próxima revisión
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    async function check() {
      if (document.hidden) return;
      try {
        const res = await fetch(`/version.json?t=${Date.now()}`, { cache: 'no-store' });
        if (!res.ok) return;
        const { build } = await res.json();
        if (alive && build && build !== __BUILD_ID__) { setFresh(true); setLater(false); }
      } catch { /* sin conexión: se revisa la próxima vez */ }
    }
    const onVisible = () => { if (!document.hidden) check(); };
    check();
    const t = setInterval(check, CHECK_MS);
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('online', check);
    return () => {
      alive = false;
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('online', check);
    };
  }, []);

  // Se trae también el service worker nuevo y se recarga: la página siempre se pide al servidor, así que llega la versión nueva
  async function update() {
    setBusy(true);
    try { await (await navigator.serviceWorker?.getRegistration())?.update(); } catch { /* sin service worker: basta con recargar */ }
    window.location.reload();
  }

  if (!fresh || later) return null;
  return (
    <div className="update-bar" role="status">
      <span>✨ Hay una versión nueva de Ktracho GO</span>
      <button className="primary sm" disabled={busy} onClick={update}>{busy ? 'Actualizando…' : 'Actualizar'}</button>
      <button className="link" onClick={() => setLater(true)}>Más tarde</button>
    </div>
  );
}
