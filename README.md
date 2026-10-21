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
5. **Respaldos:** activa los backups del MySQL y del Volume en Railway, y haz además tu propio respaldo semanal con `npm --prefix server run backup` (ver «Etapa 7.2: respaldos y cómo recuperar la base»).

El servicio mantiene en memoria las posiciones de los conductores, así que debe correr en **una sola instancia**.

## App instalable (PWA) y páginas legales

- La web se puede instalar en el celular ("Instalar la app" en Mi cuenta y en la pantalla de entrada; en iPhone: Compartir → Agregar a inicio). Usa `client/public/manifest.webmanifest`, los íconos de `client/public/icons/` y un service worker mínimo (`client/public/sw.js`) que nunca guarda la API ni los sockets.
- `/terminos` y `/privacidad` son las páginas legales (`client/src/Legal.jsx`). Al registrarse hay que aceptarlas y el servidor guarda cuándo y qué versión (`users.terms_accepted_at` y `terms_version`). Si cambias el texto de forma importante, sube `TERMS_VERSION` en `server/src/legal.js`.
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

**Búsqueda de direcciones y rutas** (Etapa 7.3). Por defecto se usan Photon y OSRM públicos. Para cambiar a LocationIQ, en Railway → Variables:
`MAPS_PROVIDER=locationiq` y `MAPS_KEY=<tu clave>` (y `LOCATIONIQ_REGION=eu1` si la cuenta es de Europa). La clave se queda en el servidor; la app nunca la ve.
Si falta la clave, el servidor avisa en el registro y sigue con OpenStreetMap. Para el mapa de LocationIQ (opcional, otra clave restringida a tu dominio):
`VITE_TILE_URL=https://{s}-tiles.locationiq.com/v3/streets/r/{z}/{x}/{y}.png?key=<clave del mapa>` y
`VITE_TILE_ATTRIBUTION=© <a href="https://locationiq.com/?ref=link-back">LocationIQ</a> © OpenStreetMap` (el plan gratis pide el enlace). Comprueba la dirección exacta en tu panel de LocationIQ.

- **Caché:** el servidor guarda hasta 5.000 búsquedas, nombres de lugares y rutas (búsquedas 1 h, nombres 24 h, rutas 10 min); lo más usado se queda.
- **Servicio caído:** si el proveedor no responde, durante `MAPS_RETRY_SECONDS` (60 s) no se le vuelve a preguntar: la ruta y el precio se estiman al instante
  (línea recta × 1,3 a ~25 km/h, marcada como «estimado») en lugar de esperar 8 s en cada viaje. Una ruta estimada se vuelve a intentar al minuto.
- Prueba: `test/maps-unit.mjs` (contra un LocationIQ de mentira, sin clave real).

| Proveedor | Gratis | De pago | Mapa | Búsqueda | Rutas | Notas |
|---|---|---|---|---|---|---|
| **LocationIQ** (recomendado para empezar) | 5.000 consultas/día, uso comercial con enlace | Developer: US$100/mes (25.000/día) | Sí | Sí | Sí (formato OSRM) | Ya está integrado |
| Geoapify | 3.000 créditos/día, uso comercial | API 10: US$59/mes (10.000/día) | Sí | Sí | Sí (otro formato) | Habría que agregar su formato de rutas |
| Stadia Maps | 200.000 créditos/mes, **sin** uso comercial | Starter: US$20/mes (1 millón/mes) | Sí | Sí | Sí (Valhalla, otro formato) | Barato para el mapa |

Precios vistos el 21 de octubre de 2026 en la página de cada proveedor; confírmalos antes de contratar.

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

**Verificación en dos pasos (obligatoria para el personal, salvo que el superadmin la apague).** El superadmin puede apagarla o encenderla en el panel → **Ajustes → Seguridad del personal**: apagada, el personal entra solo con su contraseña; al encenderla de nuevo, quien ya la tenía configurada vuelve a necesitar el código. Viene encendida. Mientras esté encendida, superadmin, administrador y soporte deben activarla antes de usar el panel: escanean un QR con Google Authenticator (o Microsoft Authenticator, Authy, 1Password), confirman con un código y guardan 10 códigos de respaldo (de un solo uso). Al entrar, la contraseña sola no da sesión; falta el código. Cinco códigos incorrectos bloquean la verificación 15 minutos, un mismo código no sirve dos veces, y el secreto se guarda cifrado.
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

## Contraseñas del personal y salidas de emergencia

- **Restablecer contraseñas:** en la ficha de cualquier usuario, el botón «🔑 Restablecer contraseña» genera una contraseña temporal que se muestra **una sola vez**; la persona debe cambiarla al entrar y sus sesiones se cierran. El superadmin lo puede hacer con administradores, soporte, conductores y pasajeros; un administrador, solo con conductores y pasajeros. Queda en el Registro.
- **Si el superadmin olvida la suya:** en Railway define `RESET_PASSWORD_FOR=<su teléfono>` y `RESET_PASSWORD_TO=<contraseña nueva>`, reinicia el servicio, entra, y **borra las dos variables**. Solo funciona con cuentas del personal. (Para perder el teléfono del autenticador existe `RESET_2FA_FOR`.)

**Agregar un pasajero (solo superadmin):** en Usuarios, «➕ Agregar pasajero» (nombre, teléfono y correo opcional). Se genera una contraseña temporal que se muestra una sola vez; la persona debe cambiarla al entrar. No repite teléfono ni correo y queda en el Registro. Esa cuenta nace sin aceptación de términos registrada.

## Novedades

El botón **Novedades** (arriba, junto a Cuenta) muestra un resumen corto de cada cambio del sistema; un punto verde avisa cuando hay algo que la persona no ha visto. Las entradas están en `client/src/changelog.js`, la más nueva primero, y cada una dice quién la ve (`all`, `passenger`, `driver` o `staff`). **Cada cambio que se publique debe agregar su entrada ahí.**

## Etapa 1: estabilización

- **Sin asignaciones dobles.** Aceptar una oferta, avanzar el estado del viaje y cancelar solo cambian el viaje si sigue en el estado esperado (la condición va en el `UPDATE`), y el conductor se reserva antes de cualquier espera. Así, un doble toque o dos pasajeros aceptando a la vez al mismo conductor dejan un solo conductor por viaje y un solo viaje por conductor; una cancelación que llega justo cuando el viaje inicia no lo deja cancelado ya empezado.
- **Los despliegues no cancelan solicitudes.** Al arrancar, el servidor vuelve a cargar las solicitudes que seguían buscando conductor (de los últimos 10 minutos); los conductores las reciben al reconectarse. Las ofertas hechas antes del reinicio ya no se pueden aceptar (el conductor tiene que volver a ofertar).
- **Tope de eventos por conexión.** Máximo 30 mensajes por evento cada 10 s (60 para la ubicación). Los de más se descartan y, si piden respuesta, reciben «Demasiadas acciones seguidas».
- **Índice `idx_status_created`** en `rides (status, created_at)` para el panel, las solicitudes abiertas y los vencimientos (se crea solo al arrancar).
- Pruebas: `test/phase12.mjs` simula las aceptaciones simultáneas y el exceso de eventos.

## Etapa 2: estructura del servidor

El servidor ya no es un solo archivo de 2000 líneas: cada tema vive en el suyo. El comportamiento es el mismo (las 652 comprobaciones de `npm test` pasan igual que antes).

| Archivo | Qué tiene |
|---|---|
| `server/src/index.js` | Arranque: carga las partes en orden, entrega la web compilada, maneja errores y cierra con orden |
| `config.js` | Variables de entorno, constantes y el reporte de errores (Sentry) |
| `app.js` | Express (seguridad, CORS, registros, límites de intentos), el servidor HTTP y Socket.IO |
| `live.js` | Lo que vive en memoria: conductores, pasajeros y solicitudes abiertas (por eso una sola instancia) |
| `access.js` | Sesiones, contraseñas, roles y permisos del personal, auditoría |
| `notify.js` | Notificaciones al celular |
| `util.js` | Validaciones pequeñas compartidas |
| `routes/auth.js` | Registro, ingreso, códigos, contraseñas y verificación en dos pasos |
| `routes/me.js` | Datos de la persona, lugares, contactos, viajes, reportes, notificaciones y mapa |
| `routes/driver.js` | Saldo, recargas y documentos del conductor |
| `routes/admin-users.js` | Panel: indicadores, usuarios, personal, documentos, registro |
| `routes/admin-ops.js` | Panel: mapa en vivo, recargas y saldo, ajustes, reportes, emergencias |
| `services/rides.js` | Reglas del viaje: vista, cercanos, tiempo de llegada, vencimientos, cancelar |
| `services/balance.js` | Saldo en vivo: comisión y crédito de bienvenida |
| `services/accounts.js` | Eliminar (anonimizar) cuentas y avisar a contactos de confianza |
| `services/sos.js` | SMS de emergencia y recordatorios |
| `sockets.js` | Tiempo real: conductor, pasajero, chat y botón de emergencia |
| `jobs.js` | Tareas periódicas y recuperación de solicitudes al arrancar |

Las piezas de más abajo no importan a las de más arriba (por ejemplo, `services/` no importa `routes/`), así no hay dependencias circulares.

## Etapa 3: sistema de diseño

Propuesta aprobada el 2026-10-20 (verde Jalón + mango para el dinero, letras Bricolage Grotesque y Figtree). Se aplica en tres entregas.

- **Entrega 1 (base):** las variables están al inicio de `client/src/index.css` (colores con su versión oscura, letras, esquinas `--r-1/2/3`, sombras, tiempos de animación y `--tap`, el alto mínimo de lo que se toca). Usa siempre las variables, no colores sueltos. El precio va en `.tag` (mango). Mientras cargan los datos se usa `<Loading />` y las listas vacías usan `<Empty title="…">qué hacer</Empty>` (`client/src/components.jsx`). Las letras se cargan desde Google Fonts en `client/index.html`.
- **Entrega 2 (hecha):** en el celular (vertical) el mapa ocupa toda la pantalla y la hoja flota encima; la rayita de arriba la achica (`.sheet.compact`). `FitTo` deja libre el alto de la hoja y vuelve a encuadrar cuando la hoja cambia de alto (salvo que la persona haya movido el mapa). Componentes nuevos: `PriceStepper` (−5/+5), `TimeRing` (tiempo de la oferta) y `Avatar`. **Rechazar (conductor):** evento `ride:decline` { rideId }: se guarda en memoria (`declined` en `live.js`), no se le vuelve a mandar al reconectarse, su oferta pendiente se retira (al pasajero le llega `offer:expired`) y si el pasajero sube el precio se le vuelve a mostrar. Prueba: `test/phase13.mjs`.
- **Entrega 3 (hecha):** panel con pestañas en píldoras (`role=tab`), estado de viaje con color (`.pill.ride-<estado>`, también en el historial), mapa en vivo con el carro SVG (`CAR_SVG` de `lib.js`) y la placa coloreada por estado, solicitudes que esperan como punto mango. **Accesibilidad:** todos los campos tienen `aria-label` (o están dentro de un `<label>`); contraste revisado en claro y oscuro (texto normal ≥ 4.5:1), con `--on-brand` y `--on-danger` para el texto sobre verde y rojo; foco visible; sin animaciones con «reducir movimiento».

## Etapa 4: categorías, tarifas y vehículos

- **Categorías:** `moto`, `car` (Carro) y `xl` (Carro amplio), definidas en `server/src/fares.js` (y sus nombres en `client/src/lib.js`). El pasajero elige una al pedir (`ride:request` acepta `category`; sin ella es `car`) y la solicitud solo les llega a los conductores cuyo vehículo es de esa categoría (también al reconectarse y al subir el precio).
- **Tarifas:** en Ajustes, por categoría: base, por km, por minuto y mínima (`fare_<categoría>_base|km|min|minimum`). Precio sugerido = base + km × por km + minutos × por minuto, redondeado de 5 en 5 y nunca menos que la mínima. `GET /api/route` devuelve `prices` (las tres) y `suggestedPrice` (carro, para versiones anteriores de la app). La tarifa inicial del carro es la de antes (L 25 + L 12/km, mínimo L 30).
- **Vehículos:** tabla `vehicles` (categoría, marca, modelo, color, año y placa única sin espacios ni guiones; `driver_id` NULL queda para la flota de Jalón del alquiler). `users.vehicle` y `users.plate` se siguen llenando con el texto que muestran las pantallas (`services/vehicles.js`). El conductor llena su vehículo al registrarse (la app anterior, con el texto libre `vehicle`, sigue funcionando: queda como carro con ese texto de modelo). El personal lo edita en la ficha (`PUT /api/admin/users/:id/vehicle`); si el conductor está conectado, el cambio de categoría se aplica de inmediato. Al eliminar una cuenta se borra su vehículo y la placa queda libre.
- **Migración (al arrancar, se puede repetir):** agrega `rides.category` (los viajes anteriores quedan como carro), crea `vehicles` y copia el vehículo de cada conductor existente como carro. Si dos conductores tenían la misma placa, el segundo queda sin vehículo y el arranque lo avisa; se corrige en su ficha.
- Prueba: `test/phase14.mjs`.

## Etapa 4B: alquiler de carros por días (con conductor)

Se activa en el panel → **Ajustes → Alquiler de carros por días** (apagado por defecto): precio mínimo y máximo por día que pueden poner los conductores, días máximos por alquiler y anticipación.

- **Quién alquila:** un conductor ofrece su carro con él como conductor (en «Alquiler de mi carro», con su precio por día). El superadmin agrega carros de la **flota de Jalón** (pestaña Alquileres); al confirmar una reserva de la flota, el personal indica quién maneja.
- **Reserva:** el pasajero elige fecha y días, ve los carros libres con el total y reserva. Las fechas se revisan dentro de una transacción con el carro bloqueado: dos personas no pueden reservar el mismo carro en fechas que se cruzan (un pedido sin responder también ocupa las fechas). Máximo 3 pedidos pendientes por persona.
- **Pago, a elección del pasajero:** **efectivo** al empezar, o **transferencia** a la cuenta de Jalón (Ajustes) con comprobante (foto validada, sin metadatos y cifrada; la misma transferencia o comprobante no sirven dos veces, ni en recargas). El alquiler por transferencia no puede empezar hasta que el personal aprueba el pago.
- **Estados:** pedido → confirmado (o no aceptado) → en curso → terminado; también cancelado. El teléfono y la placa se comparten solo al confirmar. Mientras un conductor tiene un alquiler en curso no puede ponerse disponible para viajes. Los pedidos sin respuesta cuya fecha pasó, y los confirmados que nunca empezaron, se cancelan solos.
- **Dinero (carro de un conductor):** en efectivo, al terminar se le descuenta la comisión del saldo (`rental_commission`); por transferencia, se le acredita el total menos la comisión (`rental_payout`). La comisión es la misma de los viajes (si está activa). Nunca dos veces por el mismo alquiler. **El saldo acreditado no se retira por la app:** pagarle al conductor lo hace Jalón por fuera y lo registra con un ajuste de saldo. En la flota todo es de Jalón y no hay movimientos de saldo.
- **Tablas nuevas:** `rental_listings` y `rental_bookings`; `wallet_entries` suma `rental_id` y los tipos `rental_commission` y `rental_payout`. Al eliminar una cuenta se cancelan sus reservas pendientes y se borran sus datos del alquiler; si su vehículo ya tuvo alquileres se conserva sin datos (la placa queda libre).
- **Pendiente (4B-2):** alquiler sin conductor (licencia e identidad del cliente, depósito y revisión del carro al entregar y recibir). Antes de lanzarlo hace falta un contrato y un seguro revisados por un abogado.
- Prueba: `test/phase15.mjs`.

## Permisos por módulo

El superadmin decide qué ve cada quien, en el panel → **Permisos** (por rol) y en la ficha de cada persona (excepciones).

- **Módulos** (`server/src/perms.js`): ver el panel, emergencias y reportes, cancelar viajes, gestionar y agregar usuarios, documentos, registro, recargas y saldo, ajustar saldos, mapa en vivo, alquileres, flota; y en la app, **alquilar** (pasajeros) y **ofrecer su carro** (conductores). Cada módulo dice a qué roles se puede dar. **Ajustes** y **Personal** son solo del superadmin, que siempre tiene todo.
- **Por rol:** se guarda en Ajustes (`role_perms`). Al principio el administrador y soporte tienen lo mismo que antes, y **el alquiler solo lo ve el superadmin**.
- **Por persona:** tabla `user_permissions` (`allow` 1 = se lo da, 0 = se lo quita; sin fila = según su rol). Al cambiarle el rol a alguien se borran sus excepciones. Los administradores que ya tenían el mapa en vivo (`users.can_monitor`) lo conservan como excepción.
- **Dónde se aplica:** cada petición del panel calcula los permisos de la persona (`req.perms`); el alquiler exige `rent` o `rent.offer`; el carro de un conductor sin `rent.offer` deja de aparecer para alquilar; los avisos al personal solo llegan a quien tiene el permiso. La app recibe los módulos al entrar y los vuelve a pedir al abrirse (`GET /api/me`).
- Prueba: `test/phase16.mjs`.

## Etapa 5: ganancias, horas conectado, recorrido real e historial

- **Mis ganancias (conductor):** `GET /api/driver/earnings?period=day|week|month`. Lo cobrado en viajes, la comisión, lo que le queda, viajes, km, promedio, alquileres, horas conectado, ganancia por hora y la serie por hora (hoy) o por día (semana de lunes a domingo, mes). Las fechas se calculan en MySQL en hora de Honduras (UTC−6, `CONVERT_TZ`), así da igual la zona horaria de la base.
- **Horas conectado:** tabla `driver_sessions`. Empieza al ponerse disponible y termina al desconectarse o cerrar la app; cada minuto se anota que sigue ahí (`jobs.js`), y si el servidor se reinicia las sesiones se cierran en la última vez vista. La ficha de rendimiento del panel muestra las de 30 días.
- **Recorrido real:** tabla `ride_points`, solo con el viaje en curso (un punto cada 15 s, antes si avanzó más de 150 m). Se borra a los `RIDE_TRACK_RETENTION_DAYS` días (90). Lo ven el pasajero y el conductor en el detalle y en el recibo (km reales), se incluye al descargar los datos y se borra al eliminar la cuenta. Política de privacidad **v1.7** (`TERMS_VERSION` en `server/src/legal.js`).
- **Viajes:** `rides.started_at` y `rides.completed_at` (los completados de antes tomaron su última actualización como fin).
- **Historial:** `GET /api/rides/mine?status=all|completed|cancelled&before=<id>` (de 20 en 20, con lo gastado o cobrado del mes) y `GET /api/rides/:id/detail` (solo para quienes participaron). Están en `routes/history.js`.
- Prueba: `test/phase17.mjs`.

## Etapa 6: indicadores, dinero por fecha, exportar y listas por páginas

- **Indicadores:** `GET /api/admin/metrics?preset=today|7d|30d|month|prev_month` o `?from=AAAA-MM-DD&to=AAAA-MM-DD` (hasta 366 días). Trae los indicadores del período y del período anterior del mismo largo, la serie por día, las horas pico y quién canceló. Fechas en hora de Honduras. Código en `services/metrics.js`.
- **Dinero:** `GET /api/admin/finance` con el mismo período: comisiones, recargas, bonos, ajustes y alquileres por día, y el saldo actual de los conductores.
- **Exportar:** `GET /api/admin/export/rides|ledger|topups|rentals|users` devuelve un CSV (UTF-8 con BOM para Excel, hasta 50 000 filas). Los textos que empiezan con `= + - @` llevan `'` delante para que Excel no los ejecute. Cada descarga se anota en el Registro como `export.csv`.
- **Permisos nuevos:** `metrics` (Indicadores y reporte de dinero) y `export` (Exportar). Por defecto solo el superadmin.
- **Listas por páginas:** `users`, `rides`, `audit`, `topups`, `reports` y alquileres aceptan `?limit=&offset=` (máx. 100 por página). Sin `limit` responden como antes. `users` acepta `filter=people|passenger|driver|blocked|pending|staff` y `q` (búsqueda en el servidor); `rides` acepta `status=active|completed|cancelled`.
- **Base de datos:** solo índices nuevos (fecha de creación de viajes, usuarios por rol, movimientos por tipo, recargas revisadas, alquileres por fin), creados si no existen.
- Prueba: `test/phase18.mjs`.

## Etapa 7.1: sesión en cookie protegida

- **La app web** manda la cabecera `X-Jalon-Session: cookie` en todas sus llamadas (`authFetch` en `client/src/lib.js`). Con ella, al entrar, registrarse, cambiar la contraseña o cerrar las demás sesiones, el servidor entrega la sesión en una cookie `HttpOnly`, `SameSite=Strict`, `Path=/` y, en producción, `Secure` con el nombre `__Host-jalon` (en desarrollo, `jalon_session`). El token ya no viaja en la respuesta ni se guarda en el teléfono; en `localStorage` solo queda el nombre, el rol y los permisos.
- **CSRF:** con la cookie, todo lo que no sea GET exige esa cabecera; otro sitio no puede ponerla (la bloquea CORS), y además la cookie es `SameSite=Strict`. El socket solo acepta la cookie si la conexión viene de este sitio (`trustedOrigin` en `config.js`).
- **Otros clientes** (las pruebas, una futura app nativa) siguen igual: sin la cabecera reciben el token y lo mandan en `Authorization: Bearer`.
- **Sesiones de antes:** la app que tenía el token guardado lo manda una vez a `POST /api/session/cookie`, recibe la cookie (con el mismo vencimiento) y lo borra. Nadie tiene que volver a entrar.
- **Salir:** `POST /api/logout` borra la cookie. «Cerrar las demás sesiones» y cambiar la contraseña siguen invalidando todas las sesiones anteriores (`token_version`).
- Sin cambios en la base de datos. Prueba: `test/phase19.mjs`.

## Etapa 7.4: app más liviana

- **Piezas que se descargan al usarse** (`lazyPage` en `client/src/lib.js`, con `React.lazy`): entrar, pasajero, conductor, panel, mapa en vivo, historial, cuenta, verificación en dos pasos (y su QR), seguimiento compartido, páginas legales y Novedades. Leaflet y sus estilos van en `mapParts.jsx`; Socket.IO, en `socket.js`.
- **Cuánto se descarga** (comprimido): antes, ~200 kB para todos. Ahora, la pantalla de entrada ~72 kB, el personal ~88 kB, el pasajero ~137 kB y el conductor ~138 kB. El resto del pasajero y del conductor es React y el mapa (Leaflet), que son necesarios.
- **Brotli:** `npm run build` deja una copia `.br` de cada `.js` y `.css` (`client/scripts/compress.mjs`); el servidor la entrega a los navegadores que la aceptan (~12% menos que el gzip que ya pone Railway).
- **Versión nueva con la app abierta:** una pieza que ya no existe responde 404 (no la página), y la app se recarga sola una vez.
- Sin cambios en la base de datos. Prueba: `test/phase20.mjs` (necesita `client/dist`; si no está compilada, la salta).

## Etapa 7.2: respaldos y cómo recuperar la base

Hay dos copias que se complementan:

1. **Las de Railway** (automáticas). En Railway abre el servicio **MySQL** → su volumen → **Backups** y programa copias (diarias o semanales, según tu plan).
   Haz lo mismo con el **Volume del servicio de la app** (`/data`), donde están las fotos de documentos y comprobantes: la base no las incluye.
2. **La tuya** (`npm run backup`), fuera de Railway: si se pierde la cuenta o el proyecto, sigue existiendo. Recomendado: una vez por semana.

### Hacer un respaldo desde tu computadora

1. En Railway → servicio **MySQL** → **Variables**, copia `MYSQL_PUBLIC_URL` (no la compartas: es la contraseña de la base).
2. En PowerShell, desde la carpeta del proyecto:
   ```
   $env:MYSQL_URL = "<MYSQL_PUBLIC_URL>"; npm --prefix server run backup; Remove-Item Env:MYSQL_URL
   ```
3. Queda un archivo `server/backups/<base>-<fecha>.sql.gz` (no se sube a GitHub). Lleva datos personales y contraseñas cifradas:
   guárdalo en un lugar privado (un disco o una nube personal con verificación en dos pasos), nunca en un correo o un chat.

El respaldo es una foto consistente (una sola transacción), así que se puede hacer con la app funcionando. Las fechas se guardan en UTC.
Al final trae un resumen con las filas y una huella (SHA-256) de cada tabla.

### Comprobar que el respaldo sirve (simulacro)

Con tu MySQL local (sin `MYSQL_URL`), una vez al mes:
```
npm --prefix server run restore -- server/backups/<archivo>.sql.gz
```
Lo restaura en una base aparte (`<base>_restore_check`), comprueba que cada tabla quedó **idéntica** (mismas filas y misma huella),
revisa que el saldo de cada conductor sea la suma de sus movimientos y borra la base de prueba. Termina con «✓ Restauración comprobada».
Un archivo alterado o incompleto no pasa.

### Si se pierde la base de datos

1. En Railway crea un servicio **MySQL** nuevo (o usa uno vacío). Copia su `MYSQL_PUBLIC_URL`.
2. Restaura el último respaldo **en esa base vacía** (el nombre de la base es lo que va al final de la URL, normalmente `railway`):
   ```
   $env:MYSQL_URL = "<MYSQL_PUBLIC_URL nueva>"; npm --prefix server run restore -- server/backups/<archivo>.sql.gz --into=railway; Remove-Item Env:MYSQL_URL
   ```
   Nunca escribe encima de una base que tenga tablas: si la base no está vacía, se detiene sin tocar nada.
3. En el servicio de la app, cambia `MYSQL_URL` para que apunte al MySQL nuevo (`${{ MySQL-nuevo.MYSQL_URL }}`) y vuelve a desplegar.
4. Se pierde lo que pasó entre el respaldo y la falla. Avisa a los conductores que revisen su saldo y a los pasajeros si había viajes en curso.

**Importante:** guarda una copia de `DATA_KEY` (y de `JWT_SECRET`) en un gestor de contraseñas. Sin `DATA_KEY` los documentos y los secretos
de la verificación en dos pasos no se pueden leer, aunque tengas el respaldo.

- También se puede restaurar con el cliente de MySQL: `gunzip -c archivo.sql.gz | mysql <base vacía>` (probado: da el mismo resultado).
- Simulacro hecho el 21 de octubre de 2026 con una copia de prueba: 22 tablas idénticas, la app arrancó sobre la base recuperada y se pudo entrar y ver el historial.
- Sin cambios en la base de datos. Prueba: `test/phase21.mjs`.

## Etapa 8.1: poner DATA_KEY sin perder datos

Los documentos de los conductores, los comprobantes y los secretos de la verificación en dos pasos van cifrados. Sin `DATA_KEY`, la llave
se deriva de `JWT_SECRET`. Al poner `DATA_KEY`, lo cifrado antes **se sigue leyendo** (con la llave anterior) y, al arrancar, el servidor lo
**vuelve a cifrar con la nueva** una sola vez (`src/rekey.js`). Cada archivo nuevo se comprueba antes de reemplazar al anterior.

**Pasos en Railway** (una sola vez):
1. Haz un respaldo: `npm --prefix server run backup` (ver Etapa 7.2) y un Backup del Volume.
2. Genera la llave en tu computadora: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`.
   Guárdala en tu gestor de contraseñas **antes** de ponerla en Railway.
3. Railway → servicio de la app → Variables → agrega `DATA_KEY`. **No cambies `JWT_SECRET` en el mismo paso** (la llave anterior sale de él).
4. Al desplegar, el registro dice «Llave de cifrado nueva: se volvieron a cifrar N archivo(s) y M secreto(s) 2FA». Abre un documento en el panel para confirmarlo.
5. Desde ese momento ya se puede cambiar `JWT_SECRET` sin perder nada (solo cierra las sesiones abiertas).

**Nunca quites `DATA_KEY`.** Para cambiarla por otra: pon la nueva en `DATA_KEY` y la anterior en `DATA_KEY_OLD`, despliega, y cuando el
registro confirme que todo se volvió a cifrar, quita `DATA_KEY_OLD`. Si algo no se puede leer con ninguna llave, el servidor lo avisa y lo deja como estaba.

- Simulacro hecho con la base de prueba: 4 archivos cifrados con la llave derivada pasaron a una `DATA_KEY` nueva y el panel siguió mostrando los documentos.
- Sin cambios en la base de datos. Prueba: `test/rekey-unit.mjs`.

## Etapa 8.2: estado del sistema

Panel → **Sistema** (solo el superadmin; `GET /api/admin/system`). Muestra, en «✓ Listo», «! Revisar», «✕ Falta» o «i Dato», cada cosa que conviene tener
antes de abrir al público: modo producción, verificación en dos pasos del personal, `DATA_KEY`, Sentry, el canal del código de verificación
(y si `SMS_DEV_ECHO` sigue activo), correo, Twilio, teléfonos de SOS, notificaciones, el Volume de documentos, respaldos, términos, mapas,
`PUBLIC_URL` y `TRUST_PROXY`. Nunca muestra claves.

Arriba dice **qué versión está publicada** (el commit que Railway desplegó, `RAILWAY_GIT_COMMIT_SHA`): si después de subir un cambio
a GitHub el commit no cambia, Railway no lo publicó. Prueba: `test/phase22.mjs`.

## Etapa 8.3: volver a aceptar los términos

Si un pasajero o conductor aceptó una versión anterior de los términos (`users.terms_version` distinta de `TERMS_VERSION`), la app le muestra
al abrirla lo que cambió y le pide aceptar la versión nueva (`POST /api/terms/accept` con la versión; se guarda cuál y cuándo).
Mientras tanto la app sigue respondiendo (no se corta un viaje en curso) y puede ir a su cuenta a descargar sus datos o eliminarla.

**Al cambiar los términos:** sube `TERMS_VERSION` en `server/src/legal.js` y `VERSION` en `client/src/Legal.jsx`, y actualiza la lista
`CHANGES` de `client/src/TermsUpdate.jsx` con lo más importante que cambió. Sin cambios en la base de datos. Prueba: `test/phase23.mjs`.

## Etapa 8.4: pruebas finales

**Revisión de la app publicada** (`npm --prefix server run test:prod`, o `PROD_URL=https://... npm --prefix server run test:prod`). Solo lectura: no crea cuentas
ni escribe nada. Dice qué etapas están publicadas (cada una agregó una ruta: 401 = existe, 404 = falta) y revisa HTTPS y la redirección desde http,
HSTS, CSP, iframes, `nosniff`, `referrer-policy`, permisos del navegador, que no se publiquen los `.map`, la caché de los archivos, CORS, que sin sesión
o con un token inventado no se vea nada y que los errores no muestren detalles internos.
El 21 de octubre de 2026, contra jalon.up.railway.app: todas las revisiones de seguridad pasan, pero **lo publicado es la versión «Permisos por módulo»**:
las Etapas 5 a 8 están en GitHub y pasaron el CI, pero Railway no las desplegó.

**Prueba de carga** (`npm --prefix server run test:load`, siempre contra un servidor local con una base aparte), en una computadora de oficina:

| Carga | Conexiones | Viajes | Pedido → 1ª oferta (p95) | Errores | Memoria del servidor |
|---|---|---|---|---|---|
| 30 conductores, 500 pasajeros, 100 viajes en 30 s | 530/530 | 99 de 100 | 492 ms | 0 | — |
| 100 conductores, 2.000 pasajeros, 400 viajes en 60 s | 2.100/2.100 | 399 de 400 | 552 ms | 0 | 153 MB |

(El viaje que falta en cada caso es uno que ningún conductor tomó a tiempo, como pasaría en la calle.) Railway corre en otra máquina, pero un solo
servidor de Jalón alcanza con holgura para el lanzamiento en una ciudad. Lo que se nota primero con más gente son los servicios de mapas gratuitos (Etapa 7.3).

**Revisión de seguridad** de las Etapas 5 a 8: el camino de un viaje solo lo ven su pasajero y su conductor, y solo el conductor del viaje en curso
lo registra; los comprobantes y la exportación exigen su permiso y la exportación queda en el Registro; la sesión en cookie tiene protección CSRF;
el estado del sistema es solo del superadmin y no muestra claves; `npm audit` sin vulnerabilidades en el servidor ni en la app.
Se corrigió una cosa: `npm run restore` ahora solo acepta las sentencias que escribe `npm run backup` (un archivo alterado con, por ejemplo,
`DROP DATABASE` se rechaza sin tocar nada).

## Etapa 8.5: lista de lanzamiento

Lo que falta antes de abrir Jalón al público. Casi todo es configuración en Railway o decisiones del negocio; el panel → **Sistema** marca en
«✕ Falta» lo que el servidor puede comprobar solo.

### 1. Que Railway publique la versión actual (bloquea todo lo demás)
- [ ] Railway → servicio de la app → **Deployments**: el último despliegue debe ser el último commit de `main`. Si hay un error, revisa el registro de
      la compilación; si la plataforma está en falla, espera y usa Ctrl+K → «Deploy Latest Commit».
- [ ] `npm --prefix server run test:prod` debe decir «✓ publicada» en todas las etapas y «Todo bien».
- [ ] Panel → **Sistema** → «Versión publicada» muestra el mismo commit que GitHub.

### 2. Configuración en Railway (Variables del servicio de la app)
- [ ] **Volume** montado en `/data` y `UPLOADS_DIR=/data/uploads` (sin esto los documentos se borran en cada despliegue).
- [ ] `NODE_ENV=production`, `TRUST_PROXY=1` y `PUBLIC_URL=https://jalon.up.railway.app` (o tu dominio).
- [ ] **Correo:** variables `SMTP_*` aplicadas; regístrate con un teléfono nuevo y confirma que el código llega al correo. Solo entonces **quita `SMS_DEV_ECHO`**.
- [ ] **Correo de soporte:** `VITE_CONTACT_EMAIL=jalonsoporte@gmail.com` (o el que uses) y vuelve a desplegar: los términos hoy dicen «falta definir».
- [ ] **Emergencias:** `SOS_ALERT_PHONES` con al menos dos teléfonos de personas que respondan, y Twilio (`TWILIO_*`) para que les llegue el SMS.
      Haz una prueba avisándoles antes.
- [ ] **`DATA_KEY`** siguiendo la Etapa 8.1 (respaldo primero). Guarda `DATA_KEY` y `JWT_SECRET` en un gestor de contraseñas.
- [ ] **Verificación en dos pasos del personal:** vuelve a encenderla en Panel → Ajustes y que cada persona del personal la active.
- [ ] **Sentry** (recomendado): `SENTRY_DSN` para enterarte de los errores sin revisar los registros.
- [ ] **Mapas:** con poco tráfico bastan los gratuitos; cuando haya cientos de viajes al día, LocationIQ (Etapa 7.3).

### 3. Respaldos
- [ ] Railway → Backups programados para el **MySQL** y para el **Volume** de la app.
- [ ] Primer respaldo propio (`npm --prefix server run backup` con `MYSQL_PUBLIC_URL`) y su simulacro (`npm --prefix server run restore -- archivo`).
- [ ] Recordatorio semanal para repetirlo.

### 4. Prueba completa en producción, con personas reales
- [ ] Dos teléfonos (un pasajero y un conductor aprobado): pedir, ofertar, aceptar, llegar, iniciar, terminar, calificar, ver el recibo y el camino en el historial.
- [ ] Una recarga por transferencia aprobada desde el panel y la comisión descontada al terminar un viaje.
- [ ] Notificaciones en Android y en iPhone (en iPhone solo con la app instalada en la pantalla de inicio).
- [ ] Instalar la app (PWA) en los dos.
- [ ] Botón de emergencia en un viaje de prueba (avisando antes a quienes reciben el SMS).
- [ ] Un alquiler con conductor de punta a punta, si se va a ofrecer desde el primer día.

### 5. Legal y negocio (no es código)
- [ ] Revisión con un abogado hondureño de los **Términos**, la **Política de privacidad** (ubicación, camino del viaje por 90 días, documentos, borrado de cuenta)
      y el **alquiler** (seguros y responsabilidad). Si cambian, sube la versión (Etapa 8.3) y todos la vuelven a aceptar.
- [ ] Cómo se facturan la comisión y las recargas (SAR) y la relación con los conductores (independientes).
- [ ] Conductores del lanzamiento con sus 3 documentos revisados y aprobados en el panel.
- [ ] Un canal de soporte atendido (el correo de soporte y, si quieres, WhatsApp) y quién responde las emergencias en qué horario.
- [ ] El alquiler **sin** conductor (4B-2) queda fuera hasta tener la parte legal.

### 6. El día del lanzamiento
- [ ] Panel → Sistema sin «✕ Falta».
- [ ] Alguien mirando el panel (Emergencias y Mapa en vivo) y los registros de Railway (o Sentry) las primeras horas.
- [ ] **Si algo sale mal:** Railway → Deployments → «Redeploy» de la versión anterior (no borra datos). Si se dañaran los datos, restaurar el último
      respaldo en una base nueva (Etapa 7.2).

### Pendientes conocidos (no bloquean)
- Las listas de Reportes, Recargas y Alquileres del panel muestran hasta 200 elementos sin «Ver más» (el servidor ya acepta páginas).
- Mapas de pago: solo LocationIQ está integrado; Geoapify o Stadia necesitarían su propio formato de rutas.
- La verificación de LocationIQ contra el servicio real queda para cuando haya una clave.
