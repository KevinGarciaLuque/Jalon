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

## Código de verificación por correo (SMTP) y por SMS

El registro pide un **correo válido** y envía ahí el código de 6 dígitos; la recuperación de contraseña lo manda al correo de la cuenta. Un correo solo puede usarse en una cuenta, y el código solo sirve para el correo al que se envió. En producción se revisa además que el dominio del correo exista (evita errores como «gmial.com»).

- **Correo (activo por defecto):** `OTP_CHANNELS=email` y las variables `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USER`, `SMTP_PASS` y `SMTP_FROM`. Sirve Gmail (contraseña de aplicación, puerto 587), Brevo, Resend o Zoho.
- **SMS (para cuando contrates Twilio):** cambia a `OTP_CHANNELS=email,sms` y define `TWILIO_*`; el código llegará por los dos medios.
- **Importante:** quita `SMS_DEV_ECHO` en Railway al configurar el correo; con esa variable el código se muestra en pantalla y cualquiera podría registrarse.
- Las cuentas creadas antes de esta versión no tienen correo: no pueden recuperar la contraseña solas hasta que haya SMS; el superadmin puede restablecérsela desde el panel.

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

## Roles del personal y gestión de usuarios

| Rol | Puede |
|---|---|
| **Superadministrador** | Todo: además crea y gestiona al personal, cambia roles, elimina cuentas y ve el registro. No se puede bloquear ni modificar. |
| **Administrador** | Aprobar, bloquear y desbloquear usuarios, revisar y rechazar documentos, editar datos, restablecer contraseñas, ver el registro, cancelar viajes y atender emergencias. |
| **Soporte** | Ver usuarios y viajes, cancelar viajes y atender emergencias. No ve documentos ni el registro y no modifica cuentas. |

- El superadmin crea al personal en la pestaña **Personal**: se genera una contraseña temporal que se muestra una sola vez y la persona debe cambiarla al entrar. Restablecer la contraseña de un usuario funciona igual.
- Cada usuario tiene una ficha (datos, estadísticas, últimos viajes, documentos y movimientos del personal sobre su cuenta).
- **Eliminar una cuenta** la anonimiza: se borran nombre, teléfono, vehículo, documentos y comentarios; los viajes se conservan sin direcciones para estadísticas y reclamos.
- La pestaña **Registro** anota quién hizo qué (aprobar, bloquear, editar, restablecer contraseña, eliminar, cambiar roles, rechazar documentos, cancelar viajes, atender emergencias).
- El administrador que ya existía pasa a ser superadministrador automáticamente al actualizar. `ADMIN_PHONE` y `ADMIN_PASSWORD` solo crean un superadmin si todavía no hay ninguno.

## Proveedor de mapas

Por defecto el mapa usa los servidores públicos de OpenStreetMap, que no están pensados para una app con muchos usuarios y bloquean a quien no cumple su política
(por eso el sitio envía `Referrer-Policy: strict-origin-when-cross-origin`). Para producción conviene un proveedor propio o de pago: define en Railway
`VITE_TILE_URL` (por ejemplo `https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=TU_CLAVE`) y `VITE_TILE_ATTRIBUTION`; el servidor ajusta solo la política de seguridad.
`npm run test:tiles` (con el servidor en modo producción) comprueba que las baldosas carguen y que se envíe el Referer.

## Fase 6: operación profesional

**Emergencias por SMS.** Al pulsar el botón 🆘, además de verse en el panel, se envía un SMS a los teléfonos de `SOS_ALERT_PHONES` (separados por coma, 8 dígitos) con quién pide ayuda, su teléfono y el mapa. Si nadie la atiende se repite cada `SOS_REMINDER_MINUTES` (3 por defecto) hasta 4 avisos en total. `PUBLIC_URL` agrega el enlace al panel.
**Importante:** el SMS solo sale de verdad cuando Twilio está configurado; sin él, en desarrollo queda en `server/.sms-dev.log`. El panel avisa en rojo al superadmin si `SOS_ALERT_PHONES` está vacío, y suena y notifica si entra una emergencia con el panel abierto (botón "Activar avisos sonoros").

**Integración continua.** `.github/workflows/ci.yml` corre las pruebas en cada subida a `main`: crea la base de datos desde cero, arranca el servidor y ejecuta `npm test`. En Railway activa **Settings → Source → Wait for CI** para que un despliegue espere a que pasen. (No incluye el recorrido en Chrome ni la prueba de carga.)

**Errores y registros.** Con `SENTRY_DSN` los errores inesperados se reportan a Sentry (sin datos personales). En producción cada petición a la API deja una línea JSON (método, ruta, estado, milisegundos) en los registros de Railway. Para saber si el servicio se cae, crea un monitor gratuito (UptimeRobot u otro) sobre `https://TU-DOMINIO/api/health` con aviso a tu correo o teléfono.

**Prueba de carga.** `PORT=4200 OSRM_URL=http://127.0.0.1:9 node src/index.js` y luego `LOAD_URL=http://localhost:4200 npm run test:load` (solo contra un servidor local). Variables: `LOAD_DRIVERS`, `LOAD_PASSENGERS`, `LOAD_RIDES`.
Resultados en una PC local (MySQL local, un solo proceso):

| Escenario | Conexiones | Viajes completados | Pedido → 1ª oferta (p95) | Salud del servicio (p95) | RAM del servidor |
|---|---|---|---|---|---|
| 30 conductores y 500 pasajeros, 100 viajes | 530/530 | 100% | 0.5 s | 3 ms | ~117 MB |
| 150 conductores y 2500 pasajeros, 300 viajes | 2650/2650 | 95% | 0.7 s | 65 ms | ~330 MB |

Esto mide el servidor y la base de datos, no redes móviles ni la distancia a Railway; cada viaje de la prueba dura ~1 s, no minutos. Cada pasajero recibe como máximo los 25 conductores más cercanos (con más, mostrar la lista completa saturaba el servidor).

## Fase 7: seguridad y privacidad

**Verificación en dos pasos (obligatoria para el personal).** Superadmin, administrador y soporte deben activarla antes de usar el panel: escanean un QR con Google Authenticator (o Microsoft Authenticator, Authy, 1Password), confirman con un código y guardan 10 códigos de respaldo (de un solo uso). Al entrar, la contraseña sola no da sesión; falta el código. Cinco códigos incorrectos bloquean la verificación 15 minutos, un mismo código no sirve dos veces, y el secreto se guarda cifrado.
- Si alguien pierde el teléfono: usa un código de respaldo, o el superadmin abre su ficha y pulsa **Restablecer verificación en dos pasos**.
- Si el **superadmin** pierde el teléfono *y* los códigos: define en Railway `RESET_2FA_FOR=<su teléfono>`, reinicia, entra y vuelve a activarla; **después quita la variable**.

**Documentos de conductores.** Se validan como JPEG reales, se les quitan los metadatos (ubicación GPS, modelo del celular, comentarios) y cualquier archivo escondido tras la imagen, y se guardan **cifrados** (AES-256-GCM). Cada vez que el personal los abre queda una anotación en el Registro. Los documentos guardados antes del cifrado se cifran solos la primera vez que arranca el servidor.
- Define `DATA_KEY` en Railway (32 bytes en base64): `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`. Sin ella se deriva de `JWT_SECRET`, y rotar `JWT_SECRET` dejaría ilegibles los documentos y los secretos del 2FA. **Guarda `DATA_KEY` en un lugar seguro: sin ella los documentos no se pueden recuperar.**

**Contraseñas y sesiones.** Mínimo 8 caracteres (10 para el personal), no solo números, nada obvio y sin el teléfono. La sesión del personal dura 12 horas (30 días la de pasajeros y conductores). Cada persona puede cerrar su sesión en todos los dispositivos desde Cuenta. El navegador solo puede usar la ubicación (no cámara ni micrófono).

**Derechos del usuario.** Desde Cuenta, pasajeros y conductores pueden descargar sus datos (JSON) y eliminar su cuenta (con contraseña; no con un viaje en curso). La política de privacidad es la versión 1.1.

**Pruebas de seguridad.** `npm test` incluye ataques simulados: tokens falsos (sin firma, otra llave, vencidos), inyección SQL, escalada de rol al registrarse y al editar, que un pasajero no pueda aceptar, cancelar ni ofertar sobre viajes ajenos, las 17 rutas del panel sin sesión y con la sesión de un pasajero, y documentos alterados en disco. El CI también revisa las dependencias (`npm audit`).

**Lo que NO está hecho:** la sesión se guarda en el almacenamiento local del navegador (no en cookies protegidas); con la política de seguridad estricta del sitio el riesgo es bajo, pero es la mejora pendiente más grande. Tampoco hay una auditoría externa de seguridad: antes de un lanzamiento grande conviene encargar una.

## Fase 8A: notificaciones al celular

Llegan aunque la app esté cerrada (Android/Chrome, escritorio, y en iPhone **solo con la app agregada a la pantalla de inicio**, iOS 16.4 o más).
- **Qué avisa:** al conductor, un viaje nuevo cerca o que lo aceptaron; al pasajero, una oferta, que su conductor llegó o que cancelaron; al personal, las emergencias 🆘 y cuando un conductor completa sus documentos. Si la persona tiene la app abierta no se manda (ya lo ve en pantalla).
- **Conductores:** quien activa las notificaciones y cierra la app sigue recibiendo viajes cercanos hasta 30 minutos (no aparece en el mapa de los pasajeros, que solo ven a los conectados).
- **Cómo activarlas en el servidor:** `npm run vapid` genera dos llaves; ponlas en `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` (en `.env` y en Railway). Si cambias la llave privada, cada persona debe volver a activar sus notificaciones. Cada persona las activa en **Cuenta → Notificaciones** (los conductores también en la pantalla principal y el personal en el panel).
- **Seguridad:** el servidor solo envía a los servicios de notificaciones reales de Google, Mozilla, Apple y Microsoft (un usuario no puede usarlo para atacar direcciones internas), cada envío va cifrado y firmado, y los dispositivos que ya no existen se borran solos. Máximo 10 dispositivos por persona.
- **No incluido:** las notificaciones nativas de las apps de Android/iPhone (Capacitor, Fase 11) usarán Firebase en vez de esto.
- Probado con un servicio de notificaciones falso que descifra y verifica cada envío, y la parte del celular (`client/public/sw.js`) en un entorno simulado. **No se probó con un celular real ni con los servidores de Google/Apple**: eso lo confirmas tú al activarlas.

## Fase 8B: chat y teléfonos ocultos

- **Chat del viaje** entre pasajero y conductor, con respuestas rápidas ("Ya salgo", "Estoy afuera"…). Abre al aceptarse el viaje, sigue 30 minutos después de terminar (para avisar de un objeto olvidado) y se cierra con el viaje cancelado. Máximo 500 caracteres y 20 mensajes por minuto. Si la otra persona tiene la app cerrada recibe una notificación.
- **Los teléfonos ya no se comparten** entre pasajero y conductor (antes viajaban en el aviso de "viaje nuevo" a todos los conductores cercanos). Se coordina por el chat. Si algún día quieres volver a mostrarlos: `SHOW_PARTNER_PHONES=true`.
- **Privacidad:** los mensajes se borran a los 90 días (`CHAT_RETENTION_DAYS`), al eliminar la cuenta se borran los de esa persona, y el personal solo puede leer el chat de un viaje con una emergencia (o un reporte); cada lectura queda en el Registro.
- **No incluido:** llamadas con número enmascarado. Requiere un servicio de voz (p. ej. Twilio Voice); lo decidimos cuando lo quieras.

## Fase 8C: llegada, precio y ofertas

- **Tiempo de llegada:** el pasajero ve "tu conductor llega en ~N min" (y, en viaje, cuánto falta al destino); el conductor ve cuánto falta, la ruta hacia el pasajero en el mapa y botones para abrir **Waze** o **Google Maps** hacia la recogida o el destino. Se recalcula cada 20 s (`ETA_EVERY_MS`) con el servicio de rutas (si falla, se estima).
- **Subir el precio:** mientras nadie acepta, el pasajero puede subir su oferta (+L5 o +L10); los conductores cercanos ven el precio nuevo. Solo hacia arriba y con una espera corta entre subidas (`RAISE_COOLDOWN_MS`).
- **Ofertas que vencen:** cada oferta de un conductor vale 90 segundos (`OFFER_TTL_SECONDS`) con cuenta regresiva en pantalla; si vence, ambos lo saben y el conductor puede volver a ofertar. Renovar la oferta reinicia el reloj.

## Pruebas (cambio importante)

`npm test` ahora crea y usa **su propia base de datos** (`<tu base>_test`, nueva en cada ejecución), así no se mezcla con tus datos de desarrollo ni con otro servidor que comparta la base. `ONLY=phase8c npm test` corre solo una suite.

## Fase 8D: lugares, contactos, recibos y reportes

- **Lugares favoritos:** al elegir un destino aparece «⭐ Guardar este lugar» (Casa, Trabajo…); la próxima vez salen como atajos arriba del buscador. Hasta 10; se gestionan en Cuenta.
- **Contactos de confianza (pasajeros):** hasta 3 personas (nombre y teléfono) que reciben un SMS con el enlace para seguir el viaje en vivo en cuanto empieza. Se administran en Cuenta. El SMS sale sin tildes para que sea uno solo y barato; **necesita Twilio configurado** (sin él solo queda en el registro de desarrollo).
- **Recibos:** en el Historial, cada viaje completado tiene «🧾 Recibo» con número (JAL-000123), fecha, personas, vehículo, recorrido, total y forma de pago; se puede imprimir o guardar como PDF. **No es una factura fiscal.**
- **Reportes:** pasajeros y conductores pueden reportar un problema de un viaje (objeto olvidado, cobro indebido, trato, seguridad, otro) desde el Historial o al terminar. El personal los ve en la pestaña **Reportes** con los teléfonos de las dos personas, puede leer el chat de ese viaje, y al resolver escribe una respuesta que la persona ve en «Mis reportes» (y por notificación). Máximo 5 reportes por persona al día.
- **Datos y privacidad:** todo se incluye al descargar tus datos y se borra o anonimiza al eliminar la cuenta. Política de privacidad v1.3.
- **Pendiente (decisión tuya):** viajes programados y paradas múltiples, que requieren su propio diseño.

## Fase 9: saldo, comisión y recargas por transferencia (sin pasarela)

Modelo estilo inDrive **sin pasarela de pago**: el pasajero paga en efectivo al conductor, y Jalón cobra su comisión de un **saldo prepagado** que el conductor recarga **transfiriendo a la cuenta de Jalón y subiendo el comprobante**. Un administrador lo revisa y autoriza. No hay costos de pasarela.

**Está apagado por defecto.** El superadmin lo activa en el panel → **Ajustes**: comisión (%), crédito de bienvenida, saldo mínimo para recibir viajes, recarga mínima y máxima, y los datos de la cuenta bancaria de Jalón (banco, tipo, número, titular e indicaciones). No se puede activar sin los datos bancarios.

**Cómo funciona**
1. **Recargar:** en la pantalla del conductor, «Recargar» muestra la cuenta de Jalón. El conductor transfiere, y sube el monto, el banco, el número de referencia y la foto o captura del comprobante.
2. **Autorizar:** en la pestaña **Recargas** (y con un aviso arriba del panel y una notificación) el personal ve el comprobante, lo compara con el banco, y **aprueba** (acreditando el monto que *muestra el comprobante*, aunque sea distinto al que escribió el conductor) o **rechaza con un motivo**. Lo ven soporte NO; solo administrador y superadmin.
3. **Comisión:** al completar un viaje se descuenta la comisión del saldo. Un viaje cancelado no cobra. Nunca se cobra dos veces el mismo viaje (lo impide la base de datos).
4. **Saldo bajo:** si el saldo queda por debajo del mínimo, el conductor deja de aparecer disponible, recibe un aviso y no puede volver a conectarse hasta recargar.
5. **Crédito de bienvenida:** se da una sola vez al aprobar a un conductor nuevo (solo si la comisión está activa en ese momento).

**Control y antifraude:** la misma transferencia (aunque cambien mayúsculas o guiones) o el mismo comprobante no se aceptan dos veces; máximo 3 recargas esperando y 5 por día; dos personas que pulsan «Aprobar» a la vez acreditan una sola vez; los comprobantes se guardan cifrados y sin datos ocultos, y cada vez que alguien los abre queda en el Registro. Cada movimiento queda en un **libro de cuentas que no se edita**, y el saldo siempre cuadra con él (las pruebas lo verifican). El superadmin puede **ajustar un saldo** con un motivo (suma o resta), que también queda registrado. Los datos del conductor se descargan e incluyen su saldo; al eliminar su cuenta se borran los comprobantes pero se conservan los montos (registro contable).

**Lo que NO hace:** no retira ni transfiere dinero a los conductores (el saldo solo sirve para pagar la comisión), no genera facturas fiscales, y la verificación de que la transferencia llegó al banco es manual (la persona que aprueba compara el comprobante con el estado de cuenta). **Antes de cobrar comisión consulta a un contador** sobre cómo facturarla y a un abogado sobre el contrato con los conductores. La pasarela de pago se puede agregar más adelante: solo reemplaza quién aprueba la recarga.

## Fase 10: monitoreo de conductores (mapa en vivo y ficha de rendimiento)

Pestaña **Mapa en vivo** del panel. Muestra a los conductores conectados en un mapa (verde = libre, azul = en viaje, gris = sin conexión pero aún recibe avisos), las solicitudes que esperan conductor y, al elegir un conductor, el viaje que lleva (origen, destino, pasajero y precio) y su **ficha**: viajes completados, cobrado, km, ofertas aceptadas, cancelaciones hechas por él, calificación, reportes en su contra, últimos viajes y, si tienes permiso de dinero, su saldo y la comisión de 30 días. Se refresca sola cada 5 segundos.

**Quién lo ve:** el superadmin siempre; un administrador **solo si el superadmin se lo concede** (en la ficha del administrador: «Puede ver el mapa en vivo»); soporte nunca. El permiso se pierde si cambian el rol de esa persona. Cada vez que alguien abre el mapa (una anotación por media hora) o la ficha de un conductor (por 10 minutos) queda en el **Registro**, igual que cuando se concede o se quita el permiso.

**Privacidad:** la ubicación solo se ve mientras el conductor está conectado o en viaje; no se guarda un historial de recorridos. Los términos y la política (v1.6) lo informan a los conductores.

**Lo que no mide todavía:** horas conectado por día (solo cuánto lleva conectado ahora), el recorrido real del viaje (el mapa dibuja la línea recta entre origen y destino) ni métricas por fecha del negocio completo: eso sigue pendiente.
