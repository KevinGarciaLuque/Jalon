import { io } from 'socket.io-client';
import L from 'leaflet';
import { useEffect, useRef, useState } from 'react';

// Desarrollo: API en :4000. Producción: el mismo servidor entrega la web, así que se usa la misma dirección ('')
export const API = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '');
// Proveedor de mapas: se cambia con VITE_TILE_URL y VITE_TILE_ATTRIBUTION (al compilar). Por defecto, OpenStreetMap.
export const TILE_URL = import.meta.env.VITE_TILE_URL || 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION = import.meta.env.VITE_TILE_ATTRIBUTION || '&copy; OpenStreetMap';
export const DEFAULT_POS = { lat: 14.0723, lng: -87.1921 }; // Tegucigalpa

export async function api(path, body) {
  const res = await fetch(`${API}/api/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Error');
  return data;
}

export function connectSocket(token) {
  return io(API || undefined, { auth: { token } });
}

export function distanceKm(a, b) {
  const R = 6371;
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// Respaldo si el servidor no responde; el precio sugerido real viene de /api/route (km por calle)
export function suggestedPrice(km) {
  return Math.max(30, Math.round((25 + km * 12) / 5) * 5);
}

async function request(method, path, token, body) {
  const res = await fetch(`${API}/api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Error');
  return data;
}
export const apiGet = (path, token) => request('GET', path, token);
export const apiPost = (path, token, body) => request('POST', path, token, body || {});

export const minutes = (n) => (n < 1 ? '<1 min' : `${Math.round(n)} min`);
export const lempiras = (n) => `L ${Number(n).toFixed(0)}`;

// Posición GPS del dispositivo; si no hay permiso usa Tegucigalpa
export function useGeo() {
  const [pos, setPos] = useState(null);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    if (!navigator.geolocation) { setPos(DEFAULT_POS); setDenied(true); return; }
    const id = navigator.geolocation.watchPosition(
      (p) => setPos({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => { setDenied(true); setPos((cur) => cur || DEFAULT_POS); },
      { enableHighAccuracy: true, maximumAge: 2000, timeout: 10000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, []);
  return { pos, setPos, denied };
}

// Íconos del mapa dibujados en SVG (no emojis): se ven nítidos y iguales en cualquier celular
const svgIcon = (html, size, anchor, cls) => L.divIcon({ html, className: `map-icon ${cls}`, iconSize: size, iconAnchor: anchor });

// Carro visto desde arriba, con el frente hacia el norte (CarMarker lo gira según hacia dónde va)
const CAR_SVG = `<svg viewBox="0 0 28 48" width="22" height="38" aria-hidden="true">
  <rect x="1" y="14" width="3.5" height="5" rx="1.6" fill="#086640"/><rect x="23.5" y="14" width="3.5" height="5" rx="1.6" fill="#086640"/>
  <rect x="3" y="2" width="22" height="44" rx="8" fill="#0a7d4f" stroke="#fff" stroke-width="1.6"/>
  <path d="M6.5 14.5Q14 9.5 21.5 14.5L20.5 20.5H7.5Z" fill="#0d1f17" opacity=".88"/>
  <rect x="7.5" y="21.5" width="13" height="11" rx="3" fill="#13a36a"/>
  <path d="M7.5 34H20.5L21.5 39Q14 42 6.5 39Z" fill="#0d1f17" opacity=".78"/>
  <rect x="5.5" y="3.6" width="5" height="2.6" rx="1.3" fill="#fff6bf"/><rect x="17.5" y="3.6" width="5" height="2.6" rx="1.3" fill="#fff6bf"/>
  <rect x="5.5" y="42" width="4" height="2" rx="1" fill="#ff5c5c"/><rect x="18.5" y="42" width="4" height="2" rx="1" fill="#ff5c5c"/>
</svg>`;

// Pin con la punta abajo (marca el punto exacto) y un dibujo dentro
const pin = (fill, inner) => `<svg viewBox="0 0 34 44" width="34" height="44" aria-hidden="true">
  <path d="M17 43s-14-15.2-14-25.5a14 14 0 0 1 28 0C31 27.8 17 43 17 43z" fill="${fill}" stroke="#fff" stroke-width="2"/>
  <circle cx="17" cy="17.5" r="8.5" fill="#fff"/>${inner}</svg>`;
const checks = Array.from({ length: 12 }, (_, i) => ((i % 4) + Math.floor(i / 4)) % 2 ? '' : `<rect x="${14.8 + (i % 4) * 2}" y="${11.5 + Math.floor(i / 4) * 2}" width="2" height="2" fill="#14171c"/>`).join('');
const FLAG = `<rect x="13.2" y="11.5" width="1.6" height="12" rx=".8" fill="#14171c"/><rect x="14.8" y="11.5" width="8" height="6" fill="#fff" stroke="#14171c" stroke-width=".6"/>${checks}`;

export const icons = {
  car: svgIcon(`<div class="car-rot">${CAR_SVG}</div>`, [40, 40], [20, 20], 'car'),
  me: svgIcon(pin('#0a7d4f', '<circle cx="17" cy="17.5" r="4" fill="#0a7d4f"/>'), [34, 44], [17, 43], 'pin'),
  dest: svgIcon(pin('#14171c', FLAG), [34, 44], [17, 43], 'pin'),
};

// "Instalar app": Chrome/Android avisa con beforeinstallprompt; iPhone no tiene botón y hay que explicarlo
export function useInstall() {
  const [evt, setEvt] = useState(null);
  const standalone = window.matchMedia?.('(display-mode: standalone)').matches || window.navigator.standalone;
  useEffect(() => {
    const onPrompt = (e) => { e.preventDefault(); setEvt(e); };
    const onInstalled = () => setEvt(null);
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);
  return {
    canInstall: !!evt && !standalone,
    ios: /iphone|ipad|ipod/i.test(navigator.userAgent) && !standalone,
    prompt: async () => { if (evt) { evt.prompt(); await evt.userChoice.catch(() => {}); setEvt(null); } },
  };
}

// ---- Notificaciones push ----
// Solo existen en la versión publicada (el service worker no corre en el servidor de desarrollo)
export const pushSupported = () =>
  import.meta.env.PROD && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

const keyToBytes = (b64) => {
  const raw = atob((b64 + '='.repeat((4 - (b64.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
};

// 'unsupported' | 'denied' | 'on' | 'off'
export async function pushState() {
  if (!pushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  return (await reg.pushManager.getSubscription()) ? 'on' : 'off';
}

export async function enablePush(token) {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Permiso denegado. Actívalo en la configuración de tu navegador para este sitio.');
  const { key } = await apiGet('push/key', token);
  if (!key) throw new Error('Las notificaciones todavía no están configuradas en el servidor.');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyToBytes(key) }));
  await apiPost('push/subscribe', token, { subscription: sub.toJSON() });
}

export async function disablePush(token) {
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (!sub) return;
  await apiPost('push/unsubscribe', token, { endpoint: sub.endpoint }).catch(() => {});
  await sub.unsubscribe();
}

// ---- Chat del viaje ----
// Mantiene los mensajes, cuántos no se han leído y si el chat está abierto en pantalla (los eventos llegan aunque esté cerrado).
export function useChat(socket, ride, myId) {
  const rideId = ride?.id;
  const chatable = !!ride?.driver_id && ['accepted', 'arrived', 'started', 'completed'].includes(ride.status);
  const [messages, setMessages] = useState([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [closed, setClosed] = useState(false); // el chat ya no admite mensajes nuevos (pasaron 30 min del viaje)
  const [error, setError] = useState('');
  const openRef = useRef(false);
  openRef.current = open;

  const load = () => {
    if (!rideId || !chatable) return;
    socket.emit('chat:history', { rideId }, (res) => {
      if (!res?.ok) return;
      setMessages(res.messages);
      setUnread(openRef.current ? 0 : res.unread);
      setClosed(!res.open);
    });
  };

  useEffect(() => {
    setMessages([]); setUnread(0); setOpen(false); setClosed(false); setError('');
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rideId, chatable]);

  useEffect(() => {
    const onMessage = (m) => {
      if (m.rideId !== rideId) return;
      setMessages((cur) => (cur.some((x) => x.id === m.id) ? cur : [...cur, m]));
      if (m.senderId !== myId) {
        if (openRef.current) socket.emit('chat:read', { rideId });
        else setUnread((n) => n + 1);
      }
    };
    const onRead = ({ rideId: r }) => r === rideId && setMessages((cur) => cur.map((m) => (m.senderId === myId ? { ...m, read: true } : m)));
    socket.on('chat:message', onMessage);
    socket.on('chat:read', onRead);
    socket.on('connect', load); // al reconectarse se recuperan los mensajes que llegaron mientras no había señal
    return () => { socket.off('chat:message', onMessage); socket.off('chat:read', onRead); socket.off('connect', load); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [socket, rideId, myId, chatable]);

  return {
    chatable, messages, unread, open, closed, error,
    openChat: () => { setOpen(true); setUnread(0); socket.emit('chat:read', { rideId }); },
    closeChat: () => setOpen(false),
    send: (text) => new Promise((res) => socket.emit('chat:send', { rideId, text }, (r) => { setError(r?.error || ''); res(r); })),
  };
}

// Devuelve la hora actual y se actualiza cada `ms` (para cuentas regresivas)
export function useNow(ms = 1000) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

// Enlaces para abrir la navegación en Waze o Google Maps hacia un punto
export const wazeUrl = ({ lat, lng }) => `https://waze.com/ul?ll=${lat},${lng}&navigate=yes`;
export const mapsUrl = ({ lat, lng }) => `https://www.google.com/maps/dir/?api=1&destination=${lat},${lng}&travelmode=driving`;

// Dinero con centavos (los saldos y comisiones pueden tener decimales)
export const money2 = (n) => `L ${Number(n).toFixed(2)}`;

// Reduce una foto del celular (varios MB) a un JPEG de máx. 1280 px antes de subirla. También sirve con capturas de pantalla (PNG).
export async function toJpeg(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1280 / Math.max(bmp.width, bmp.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bmp.width * scale);
  canvas.height = Math.round(bmp.height * scale);
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.8);
}
