import { io } from 'socket.io-client';
import L from 'leaflet';
import { useEffect, useState } from 'react';

// Desarrollo: API en :4000. Producción: el mismo servidor entrega la web, así que se usa la misma dirección ('')
export const API = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:4000' : '');
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

const emojiIcon = (emoji, size = 30) =>
  L.divIcon({
    html: `<div style="font-size:${size}px;line-height:1;filter:drop-shadow(0 2px 2px rgba(0,0,0,.4))">${emoji}</div>`,
    className: '',
    iconSize: [size, size],
    iconAnchor: [size / 2, size / 2],
  });

export const icons = {
  car: emojiIcon('🚕'),
  me: emojiIcon('📍', 34),
  dest: emojiIcon('🏁', 32),
};
