// Chat entre pasajero y conductor durante el viaje. Reglas en un solo lugar para poder probarlas.
export const CHAT_MAX = 500; // caracteres por mensaje
export const CHAT_AFTER_COMPLETE_MIN = 30; // tras terminar el viaje se puede escribir un rato (p. ej. "olvidé mi celular en el carro")
const PER_MINUTE = 20;

// El chat está abierto mientras el viaje está en marcha y 30 minutos después de completarse. Con viaje cancelado o sin conductor, cerrado.
// `ride.recent` lo calcula la consulta (updated_at dentro de los últimos 30 min) para no depender de la zona horaria del servidor.
export function chatOpen(ride) {
  if (!ride) return false;
  if (['accepted', 'arrived', 'started'].includes(ride.status)) return true;
  return ride.status === 'completed' && !!ride.recent;
}

// Límite contra el abuso: 20 mensajes por minuto por persona
const hits = new Map();
export function chatAllowed(userId, now = Date.now()) {
  const recent = (hits.get(userId) || []).filter((t) => now - t < 60000);
  if (recent.length >= PER_MINUTE) { hits.set(userId, recent); return false; }
  recent.push(now);
  hits.set(userId, recent);
  return true;
}

// Privacidad: los mensajes no se guardan para siempre
export async function purgeOldMessages(pool, days = 90) {
  const [r] = await pool.query('DELETE FROM messages WHERE created_at < NOW() - INTERVAL ? DAY', [days]);
  return r.affectedRows;
}
