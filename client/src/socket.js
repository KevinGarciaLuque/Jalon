// Conexión en tiempo real (Socket.IO). Va aparte: solo la descargan pasajeros y conductores, después de entrar.
import { io } from 'socket.io-client';
import { API } from './lib.js';

// `token` solo existe en una sesión guardada de antes de la cookie que todavía no se pudo pasar a ella
export function connectSocket(token) {
  return io(API || undefined, { auth: token ? { token } : {}, withCredentials: true });
}
