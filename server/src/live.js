// Lo que vive en memoria del proceso (por eso el servicio corre en una sola instancia) y el nombre de la sala de cada usuario

// ---------- Estado en memoria (posiciones en vivo) ----------
export const drivers = new Map(); // userId -> { id, name, vehicle, plate, lat, lng, available }
export const passengers = new Map(); // userId -> { id, lat, lng }
export const openRides = new Map(); // rideId -> ride listo para enviar a conductores

export const room = (id) => `user:${id}`;
