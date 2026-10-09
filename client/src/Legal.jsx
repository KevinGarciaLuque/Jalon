// Términos de uso y política de privacidad. Si cambias el contenido, sube TERMS_VERSION en server/src/index.js.
const VERSION = '1.5';
const UPDATED = '10 de octubre de 2026';
const CONTACT = import.meta.env.VITE_CONTACT_EMAIL; // se define al compilar (variable en Railway)

const Contact = () => (CONTACT ? <a href={`mailto:${CONTACT}`}>{CONTACT}</a> : <i>[correo de soporte: falta definir VITE_CONTACT_EMAIL]</i>);

function Terms() {
  return (
    <>
      <h1>Términos de uso</h1>
      <p className="muted">Versión {VERSION} · Última actualización: {UPDATED}</p>

      <h2>1. Qué es Jalón</h2>
      <p>
        Jalón es una plataforma tecnológica que pone en contacto a pasajeros con conductores independientes. Jalón no presta el servicio de
        transporte, no es dueña de los vehículos y no emplea a los conductores: el viaje es un acuerdo entre el pasajero y el conductor.
      </p>

      <h2>2. Tu cuenta</h2>
      <ul>
        <li>Debes ser mayor de 18 años y dar datos verdaderos.</li>
        <li>Tu cuenta es personal: usa tu propio teléfono y no compartas tu contraseña ni el código que te enviamos por correo o SMS.</li>
        <li>Eres responsable de lo que ocurra con tu cuenta. Si crees que alguien la usa, cambia tu contraseña en la sección Cuenta.</li>
      </ul>

      <h2>3. Conductores</h2>
      <ul>
        <li>Debes tener licencia de conducir vigente y un vehículo en regla según las leyes aplicables.</li>
        <li>Los documentos que subes (foto, licencia y matrícula) deben ser verdaderos y tuyos. Presentar documentos falsos causa el cierre de la cuenta.</li>
        <li>Que aprobemos tu cuenta no es una certificación ni una garantía sobre ti o tu vehículo.</li>
        <li>Eres responsable de cumplir las normas de transporte y tus obligaciones fiscales.</li>
      </ul>

      <h2>4. Viajes y precios</h2>
      <ul>
        <li>El pasajero propone un precio; los conductores pueden aceptarlo o contraofertar. El precio que aceptas es el precio del viaje.</li>
        <li>Por ahora el pago es en efectivo, directamente al conductor al terminar el viaje. Jalón no cobra ni procesa pagos entre usuarios.</li>
        <li>La ruta, la distancia y el tiempo que ves son estimaciones y pueden variar.</li>
        <li>
          <b>Conductores:</b> Jalón puede cobrar una comisión por cada viaje, que se descuenta de un saldo que el conductor recarga transfiriendo a la cuenta de
          Jalón y subiendo su comprobante, que el equipo revisa. Con el saldo por debajo del mínimo no se reciben viajes. La comisión vigente y los datos de la cuenta
          se muestran en la aplicación antes de recargar.
        </li>
      </ul>

      <h2>5. Cancelaciones</h2>
      <p>
        Puedes cancelar un viaje antes de que empiece. Una solicitud que ningún conductor toma se cancela sola después de unos minutos. Cancelar de forma
        repetida o abusiva puede llevar a la suspensión de la cuenta.
      </p>

      <h2>6. Conducta</h2>
      <p>No está permitido:</p>
      <ul>
        <li>Acosar, amenazar, discriminar o poner en riesgo a otras personas.</li>
        <li>Falsear tu identidad, tu ubicación o tus documentos, ni usar la cuenta de otra persona.</li>
        <li>Usar los datos de otros usuarios para fines distintos del viaje.</li>
        <li>Intentar alterar, atacar o saturar la aplicación, o realizar actividades ilegales a través de ella.</li>
      </ul>

      <h2>7. Seguridad</h2>
      <ul>
        <li>Antes de subir a un vehículo, comprueba que la placa y el conductor coinciden con los que ves en la app.</li>
        <li>Puedes compartir tu viaje en vivo con una persona de confianza.</li>
        <li>
          El botón de emergencia avisa al equipo de Jalón con tu ubicación, pero <b>no sustituye llamar al 911</b>. No garantizamos un tiempo de
          respuesta. Si estás en peligro, llama primero al 911.
        </li>
      </ul>

      <h2>8. Calificaciones</h2>
      <p>Las calificaciones y comentarios deben ser honestos y respetuosos. Podemos retirar contenido ofensivo o falso.</p>

      <h2>9. Suspensión de cuentas</h2>
      <p>Podemos bloquear o cerrar una cuenta que incumpla estos términos, que ponga en riesgo a otros o cuya información no podamos verificar.</p>

      <h2>10. Límites de responsabilidad</h2>
      <p>
        Jalón se ofrece &quot;tal como está&quot; y según su disponibilidad. En la medida que permita la ley, Jalón no responde por la conducta de los
        usuarios, ni por daños, pérdidas o accidentes ocurridos durante un viaje entre pasajero y conductor, ni por interrupciones del servicio.
      </p>

      <h2>11. Cambios</h2>
      <p>
        Podemos actualizar estos términos. Cuando haya cambios importantes lo avisaremos en la aplicación; si sigues usando Jalón después, aceptas la
        versión nueva.
      </p>

      <h2>12. Ley aplicable y contacto</h2>
      <p>Estos términos se rigen por las leyes de la República de Honduras. Para cualquier consulta escríbenos a <Contact />.</p>
    </>
  );
}

function Privacy() {
  return (
    <>
      <h1>Política de privacidad</h1>
      <p className="muted">Versión {VERSION} · Última actualización: {UPDATED}</p>
      <p>Explicamos qué datos usa Jalón, para qué y con quién se comparten. Para cualquier duda escríbenos a <Contact />.</p>

      <h2>1. Qué datos recopilamos</h2>
      <ul>
        <li><b>Cuenta:</b> tu nombre, tu teléfono, tu correo electrónico y tu rol (pasajero o conductor). La contraseña se guarda cifrada; nadie, ni nosotros, puede verla.</li>
        <li><b>Conductores:</b> foto, licencia de conducir, matrícula, vehículo y placa.</li>
        <li>
          <b>Ubicación:</b> el GPS de tu dispositivo, solo mientras la aplicación está abierta. En el pasajero, para buscar conductores cerca y durante el
          viaje; en el conductor, mientras está disponible y durante los viajes.
        </li>
        <li><b>Viajes:</b> origen, destino, ruta, precio, estado y fechas; las calificaciones y comentarios; y las alertas de emergencia que envíes.</li>
        <li>
          <b>Chat del viaje:</b> los mensajes que te escribes con el conductor o el pasajero. Los teléfonos no se comparten entre ustedes: se coordina por el
          chat. Los mensajes se borran automáticamente a los 90 días, y el personal solo los lee si el viaje tiene una emergencia (queda anotado quién los leyó).
        </li>
        <li><b>Recargas de saldo (conductores):</b> el monto, el banco, el número de referencia y la foto del comprobante de cada transferencia, y el historial de movimientos de tu saldo. El personal las revisa para acreditarlas; los registros de dinero se conservan con fines contables aunque elimines tu cuenta, pero sin tus datos personales.</li>
        <li><b>Lugares guardados:</b> los destinos que decidas guardar (casa, trabajo…), con su nombre y ubicación. Puedes borrarlos cuando quieras.</li>
        <li>
          <b>Contactos de confianza:</b> el nombre y teléfono de hasta 3 personas que tú agregues. Cuando empieza un viaje les enviamos un SMS con el enlace para
          seguirlo. Solo los agregas tú, y puedes quitarlos en cualquier momento.
        </li>
        <li><b>Reportes:</b> lo que nos cuentes sobre un viaje (un objeto olvidado, un cobro, un problema). Lo ve el personal de Jalón para atenderte.</li>
        <li><b>Notificaciones:</b> si las activas, guardamos un identificador de tu dispositivo para enviártelas (puedes desactivarlas en Cuenta).</li>
        <li><b>Técnicos:</b> tu dirección IP y registros del servidor, para seguridad y para limitar intentos de acceso abusivos.</li>
        <li>La sesión se guarda en tu navegador (almacenamiento local). No usamos cookies de publicidad ni rastreadores de terceros.</li>
      </ul>

      <h2>2. Para qué los usamos</h2>
      <ul>
        <li>Prestar el servicio: encontrar conductores, gestionar viajes y mostrar el mapa.</li>
        <li>Verificar tu correo con un código (y tu teléfono por SMS cuando ese canal esté activo) y revisar a los conductores antes de aprobarlos.</li>
        <li>Seguridad: prevenir fraudes, atender emergencias y resolver reclamos.</li>
        <li>Mejorar la aplicación y cumplir obligaciones legales.</li>
      </ul>

      <h2>3. Con quién se comparten</h2>
      <ul>
        <li>
          <b>Pasajero y conductor del mismo viaje:</b> se ven el nombre, la calificación y la ubicación necesaria para el viaje; el pasajero ve además el
          vehículo y la placa. <b>No se ven el teléfono.</b>
        </li>
        <li>
          <b>Enlace de viaje compartido:</b> quien reciba el enlace ve el nombre de pila del conductor, su vehículo y placa, la ruta y la ubicación en vivo,
          mientras el viaje está activo y hasta una hora después de terminar. Tú decides con quién lo compartes.
        </li>
        <li><b>Administradores de Jalón:</b> pueden ver cuentas, viajes y documentos para operar el servicio, verificar conductores y atender emergencias.</li>
        <li>
          <b>Proveedores que nos ayudan a operar:</b> el alojamiento del servicio (Railway); el envío de correos (nuestro proveedor de correo, que recibe tu correo y el código) y de SMS (Twilio, que recibe tu teléfono y el código); y
          los mapas y la búsqueda de direcciones y rutas (OpenStreetMap, Photon y OSRM, que reciben el texto que buscas y coordenadas).
        </li>
        <li>No vendemos tus datos.</li>
      </ul>

      <h2>4. Cuánto tiempo los conservamos</h2>
      <p>
        Mientras tengas cuenta y el tiempo necesario para cumplir obligaciones legales, resolver reclamos y mantener la seguridad. Los documentos de los
        conductores se conservan mientras sean necesarios para su verificación.
      </p>

      <h2>5. Tus derechos</h2>
      <p>
        Desde la sección <b>Cuenta</b> de la aplicación puedes, cuando quieras:
      </p>
      <ul>
        <li><b>Descargar tus datos:</b> un archivo con tu cuenta, tus viajes, tus calificaciones y tus alertas de emergencia.</li>
        <li>
          <b>Eliminar tu cuenta:</b> se borran tu nombre, teléfono, correo, vehículo, documentos y comentarios. Tus viajes se conservan sin direcciones, únicamente
          para estadísticas y para atender reclamos. No se puede eliminar con un viaje en curso.
        </li>
        <li><b>Cambiar tu contraseña</b> y <b>cerrar tu sesión en todos los dispositivos</b>.</li>
      </ul>
      <p>
        Para corregir un dato (por ejemplo, tu teléfono o la placa de tu vehículo) o para cualquier otra solicitud, escríbenos a <Contact />.
      </p>

      <h2>6. Seguridad</h2>
      <p>
        La conexión usa HTTPS y las contraseñas se guardan cifradas de forma que nadie puede leerlas. Los documentos de los conductores se guardan
        cifrados, se les quitan los datos ocultos de las fotos (como la ubicación), y solo los puede ver el personal autorizado; cada vez que se abren queda
        un registro. El personal accede con verificación en dos pasos. Ningún sistema es completamente seguro, por eso te recomendamos no compartir tu
        contraseña ni tus códigos.
      </p>

      <h2>7. Menores de edad</h2>
      <p>Jalón es solo para mayores de 18 años.</p>

      <h2>8. Cambios</h2>
      <p>Si cambiamos esta política de forma importante, te lo avisaremos en la aplicación.</p>
    </>
  );
}

export default function Legal({ doc }) {
  return (
    <div className="legal">
      <a className="back" href="/">← Volver a Jalón</a>
      {doc === 'privacy' ? <Privacy /> : <Terms />}
      <p className="muted small">
        <a href="/terminos">Términos de uso</a> · <a href="/privacidad">Política de privacidad</a>
      </p>
    </div>
  );
}
