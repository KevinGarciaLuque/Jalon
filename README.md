# Jalón

App tipo inDrive para Honduras: el pasajero propone su precio y los conductores aceptan o contraofertan.

- `server/`: Node.js + Express + Socket.IO + MySQL
- `client/`: React (Vite) + Leaflet / OpenStreetMap

## Arrancar

1. Poner la contraseña de MySQL en `server/.env` (`DB_PASSWORD=`).
2. Crear la base de datos y tablas: `cd server && npm run setup`
3. Servidor: `cd server && npm run dev` (http://localhost:4000)
4. Cliente: `cd client && npm run dev` (http://localhost:5173)

## Probar

Abre dos ventanas (una normal y una de incógnito): registra un conductor en una y un pasajero en la otra.
Sin GPS, arrastra el pin para simular la posición.

## Pruebas

- `cd server && npm test`: flujo del viaje, admin, cancelaciones, calificaciones, compartir viaje, emergencia y expiración (borra sus datos al terminar).
- `cd server && npm run test:e2e`: recorrido completo en Chrome (necesita servidor y cliente corriendo; usa `CLIENT_URL` si Vite no está en el puerto 5174). Deja capturas en `server/test/shots`.

## Servicios de mapas

La búsqueda de direcciones usa Photon y las rutas usan OSRM, ambos públicos y gratuitos pero pensados para poco tráfico.
Antes de publicar con muchos usuarios, apunta `PHOTON_URL` y `OSRM_URL` (en `server/.env`) a un servidor propio o de pago.
Si OSRM no responde, el servidor estima la ruta (línea recta x 1.3) para no bloquear los viajes.

## SMS con Twilio

El registro y la recuperación de contraseña envían un código de 6 dígitos por SMS.

- **Sin credenciales** (desarrollo): no se envía nada; el código aparece en pantalla ("Modo desarrollo") y en la consola del servidor.
- **Con Twilio:** crea una cuenta en twilio.com, compra o asigna un número y completa en `server/.env`:
  `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN` y `TWILIO_FROM` (o `TWILIO_MESSAGING_SERVICE_SID`).
  En cuanto estén definidas, el servidor envía SMS reales y deja de mostrar el código en pantalla.
- En producción (`NODE_ENV=production`) nunca se muestra el código y, sin Twilio configurado, el envío falla a propósito.
- Una cuenta de prueba de Twilio solo envía a números verificados, y hay que habilitar Honduras (+504) en los permisos geográficos de SMS.
  Revisa el costo por mensaje antes de lanzar.

Límites: un código por minuto por tipo, 5 por hora por teléfono, 5 intentos por código y vence a los 10 minutos.

## Documentos de conductores

Cada conductor sube foto, licencia y matrícula (se reducen a JPEG en el celular). El admin las revisa en Usuarios → Documentos,
puede rechazar una con un motivo, y solo puede aprobar a un conductor con los 3 documentos. Los archivos quedan en `server/uploads/`
(fuera de las rutas públicas, solo descargables por un admin). Antes de publicar, respalda esa carpeta junto con la base de datos.

## Despliegue en Railway

Un solo servicio (este repositorio) entrega la API y la web compilada; la base de datos es el plugin MySQL de Railway.

1. **Servicio:** conecta este repositorio. La raíz tiene un `package.json` que instala `server/` y `client/`, compila la web (`npm run build`) y arranca con `npm start` (que primero crea/actualiza las tablas y luego inicia el servidor).
2. **Variables** del servicio:

   | Variable | Valor |
   |---|---|
   | `NODE_ENV` | `production` |
   | `JWT_SECRET` | texto largo y aleatorio: `node -e "console.log(require('crypto').randomBytes(48).toString('base64url'))"` |
   | `MYSQL_URL` | referencia a la base: `${{MySQL.MYSQL_URL}}` (no pegues la clave a mano) |
   | `TRUST_PROXY` | `1` |
   | `ADMIN_PHONE` / `ADMIN_PASSWORD` | el superadmin inicial (solo se crea si todavía no existe ningún admin); usa una clave larga |
   | `UPLOADS_DIR` | `/data/uploads` (ver el Volume abajo) |
   | `SMS_DEV_ECHO` | `true` solo mientras no haya Twilio; quítala al configurar `TWILIO_*` |

3. **Volume:** agrega un Volume al servicio montado en `/data`. Sin él, los documentos de los conductores se pierden en cada despliegue.
4. **Dominio:** Settings → Networking → Generate Domain (el HTTPS viene incluido y el GPS del celular lo necesita).
5. **Respaldos:** activa los backups del MySQL en Railway.

El servicio mantiene en memoria las posiciones de los conductores, así que debe correr en **una sola instancia**.

## App instalable (PWA) y páginas legales

- La web se puede instalar en el celular ("Instalar la app" en Mi cuenta y en la pantalla de entrada; en iPhone: Compartir → Agregar a inicio). Usa `client/public/manifest.webmanifest`, los íconos de `client/public/icons/` y un service worker mínimo (`client/public/sw.js`) que nunca guarda la API ni los sockets.
- `/terminos` y `/privacidad` son las páginas legales (`client/src/Legal.jsx`). Al registrarse hay que aceptarlas y el servidor guarda cuándo y qué versión (`users.terms_accepted_at` y `terms_version`). Si cambias el texto de forma importante, sube `TERMS_VERSION` en `server/src/index.js`.
- **Antes de lanzar:** define la variable `VITE_CONTACT_EMAIL` en Railway (se usa al compilar la web) con el correo de soporte que aparece en las páginas legales, y haz que un abogado revise los textos.
- En Railway, Settings → Healthcheck Path: `/api/health` (responde 503 si no hay base de datos).
