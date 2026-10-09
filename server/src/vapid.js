// Genera las llaves para las notificaciones push:  npm run vapid
import { generateKeys } from './push.js';
const k = generateKeys();
console.log('\nPon estas dos variables en server/.env (y en Railway):\n');
console.log(`VAPID_PUBLIC_KEY=${k.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${k.privateKey}\n`);
console.log('La clave privada es secreta. Si la cambias, las suscripciones existentes dejan de funcionar y cada persona debe volver a activar sus notificaciones.\n');
