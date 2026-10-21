// Novedades del sistema: un resumen corto de cada cambio, lo más nuevo primero.
// Cada cambio que se publique agrega aquí su entrada (con un `id` que no se repita) para que aparezca en el botón «Novedades».
// `for` dice quién la ve: 'all', 'passenger', 'driver' o 'staff' (superadmin, administrador y soporte).
export const CHANGELOG = [
  {
    id: '2026-10-21-indicadores',
    date: '2026-10-21',
    title: 'Indicadores, dinero por fecha y exportar a Excel',
    for: ['staff'],
    items: [
      'Nueva pestaña «Indicadores»: viajes completados y cancelados, dinero movido, comisión, tiempo hasta la primera oferta, conductores y pasajeros nuevos, por hoy, 7 o 30 días, este mes, el mes pasado o las fechas que elijas, comparado con el período anterior.',
      'Vista «Dinero»: comisiones, recargas, alquileres y ajustes día por día, y el saldo total de los conductores.',
      'Exporta a CSV (se abre en Excel) los viajes, movimientos de saldo, recargas, alquileres y usuarios nuevos del período; cada descarga queda en el Registro.',
      'Las listas de viajes, usuarios, personal y registro cargan por páginas con «Ver más», y la búsqueda de usuarios busca en todos, no solo en los primeros.',
      'Al principio solo el superadmin ve Indicadores y Exportar; puede darlos a otros roles o personas en «Permisos».',
    ],
  },
  {
    id: '2026-10-21-ganancias',
    date: '2026-10-21',
    title: 'Mis ganancias',
    for: ['driver'],
    items: [
      'Nueva pantalla «Mis ganancias»: lo que te quedó hoy, esta semana o este mes, con tus viajes, kilómetros, promedio por viaje y la comisión de Jalón.',
      'Tus horas conectado y cuánto ganas por hora (cuentan mientras tienes la app abierta y estás disponible o en un viaje).',
      'Un gráfico con lo cobrado por hora o por día; toca una barra para ver el detalle.',
    ],
  },
  {
    id: '2026-10-21-historial',
    date: '2026-10-21',
    title: 'Historial con el camino real de cada viaje',
    for: ['all'],
    items: [
      'En «Mis viajes» filtras por completados o cancelados, ves lo de este mes y cargas más viajes con «Ver más».',
      '«Ver detalle» muestra el mapa con la ruta planeada y el camino real, los kilómetros y minutos reales, y las calificaciones.',
      'Política de privacidad v1.7: mientras un viaje está en curso guardamos el camino del carro (para tu historial, el recibo y los reclamos) y lo borramos a los 90 días.',
    ],
  },
  {
    id: '2026-10-21-horas-panel',
    date: '2026-10-21',
    title: 'Horas conectado en la ficha de rendimiento',
    for: ['staff'],
    items: ['En el mapa en vivo, la ficha de cada conductor muestra sus horas conectado de los últimos 30 días.'],
  },
  {
    id: '2026-10-20-permisos',
    date: '2026-10-20',
    title: 'Permisos por módulo',
    for: ['staff'],
    items: [
      'Nueva pestaña «Permisos» (solo superadmin): marca qué módulos ve cada rol (Administrador, Soporte, Conductor y Pasajero).',
      'En la ficha de cada persona el superadmin puede darle o quitarle un módulo solo a ella; al cambiarle el rol se borran esas excepciones.',
      'El alquiler empieza visible solo para el superadmin: dale «Alquileres» al personal, «Alquilar» a los pasajeros y «Ofrecer su carro» a los conductores cuando quieras abrirlo.',
      'El permiso del mapa en vivo que ya tenían algunos administradores se conservó.',
    ],
  },
  {
    id: '2026-10-20-alquiler-pasajero',
    date: '2026-10-20',
    title: 'Alquila un carro con conductor por días',
    for: ['passenger'],
    items: [
      'Elige la fecha y cuántos días, mira los carros libres con su precio total y resérvalo.',
      'Pagas en efectivo al empezar o por transferencia a Jalón (subes el comprobante y el equipo lo aprueba).',
      'Cuando te confirman ves el teléfono del conductor y la placa. Lo encuentras en «¿Necesitas un carro todo el día?».',
    ],
  },
  {
    id: '2026-10-20-alquiler-conductor',
    date: '2026-10-20',
    title: 'Gana alquilando tu carro por días',
    for: ['driver'],
    items: [
      'En «Alquiler de mi carro» publicas tu carro, contigo como conductor, con tu precio por día.',
      'Aceptas o rechazas cada reserva, y la inicias y terminas desde ahí. Mientras dura un alquiler no recibes viajes.',
      'En efectivo cobras tú y Jalón descuenta su comisión del saldo; por transferencia, te acreditamos el total menos la comisión.',
    ],
  },
  {
    id: '2026-10-20-alquiler-panel',
    date: '2026-10-20',
    title: 'Alquileres en el panel',
    for: ['staff'],
    items: [
      'Pestaña «Alquileres»: pagos por transferencia por revisar (con el comprobante), y las reservas por estado.',
      'Flota de Jalón: el superadmin agrega carros de la empresa con su precio; el equipo confirma esas reservas indicando quién maneja.',
      'Se activa en Ajustes → Alquiler de carros por días (precio mínimo y máximo, días máximos y anticipación).',
    ],
  },
  {
    id: '2026-10-20-categorias',
    date: '2026-10-20',
    title: 'Moto, Carro o Carro amplio',
    for: ['passenger'],
    items: [
      'Al pedir un viaje eliges el tipo de vehículo y ves el precio sugerido de cada uno.',
      'Tu solicitud solo les llega a los conductores de ese tipo, y en el mapa ves los que están cerca.',
    ],
  },
  {
    id: '2026-10-20-vehiculo-conductor',
    date: '2026-10-20',
    title: 'Tu vehículo con todos sus datos',
    for: ['driver'],
    items: [
      'Al registrarte indicas si es moto, carro o carro amplio, con marca, modelo, color, año y placa.',
      'Solo te llegan solicitudes del tipo de tu vehículo. Si tu vehículo cambia, pide al equipo que lo actualice.',
      'Si ya estabas registrado, tu vehículo quedó como «Carro».',
    ],
  },
  {
    id: '2026-10-20-tarifas',
    date: '2026-10-20',
    title: 'Tarifas por tipo de vehículo y vehículos en la ficha',
    for: ['staff'],
    items: [
      'En Ajustes el superadmin cambia la tarifa de cada tipo: base, por km, por minuto y mínima. El carro quedó igual que antes.',
      'En la ficha de cada conductor se ve y se edita su vehículo. La placa no se puede repetir entre conductores.',
      'Los conductores que ya existían quedaron como «Carro»; si alguno no tiene vehículo (placa repetida), la ficha lo avisa.',
    ],
  },
  {
    id: '2026-10-20-panel-nuevo',
    date: '2026-10-20',
    title: 'Panel con la nueva imagen',
    for: ['staff'],
    items: [
      'Las pestañas del panel ahora son píldoras y el estado de cada viaje tiene su color (buscando, en camino, en viaje, terminado, cancelado).',
      'En el mapa en vivo cada conductor es un carro dibujado con su placa; la placa dice si está libre, en viaje o sin conexión. Las solicitudes que esperan laten en mango.',
      'Las tarjetas de usuarios muestran las iniciales y un punto verde si la persona está en línea.',
    ],
  },
  {
    id: '2026-10-20-historial-accesible',
    date: '2026-10-20',
    title: 'Historial más claro y app más accesible',
    for: ['all'],
    items: [
      'En «Mis viajes» cada viaje muestra la fecha, de dónde a dónde y su estado con color.',
      'Revisamos el contraste de todos los colores para que el texto se lea bien en modo claro y oscuro.',
      'Todos los campos tienen su nombre para quienes usan lector de pantalla.',
    ],
  },
  {
    id: '2026-10-20-rechazar-solicitud',
    date: '2026-10-20',
    title: 'Botón «Rechazar» y precio más fácil de ajustar',
    for: ['driver'],
    items: [
      'Puedes rechazar una solicitud que no te interesa: deja de aparecerte, y si ya habías ofertado tu oferta se retira. Si el pasajero sube su precio, te vuelve a llegar.',
      'Para contraofertar ajusta el precio con −5 / +5; el botón te dice si estás aceptando o mandando otro precio.',
      'Un anillo te muestra cuánto tiempo le queda a tu oferta.',
    ],
  },
  {
    id: '2026-10-20-mapa-pantalla-completa',
    date: '2026-10-20',
    title: 'Mapa a pantalla completa',
    for: ['passenger', 'driver'],
    items: [
      'En el celular el mapa ocupa toda la pantalla y la información sube en una hoja desde abajo. Toca la rayita de arriba de la hoja para achicarla y ver más mapa.',
      'El mapa se acomoda solo para que la ruta no quede tapada por la hoja.',
      'Cada oferta muestra con un anillo cuánto tiempo le queda, y el precio se ajusta de 5 en 5.',
    ],
  },
  {
    id: '2026-10-20-diseno-base',
    date: '2026-10-20',
    title: 'Nueva imagen de Jalón',
    for: ['all'],
    items: [
      'Letras propias de Jalón que se ven igual en cualquier celular.',
      'Los precios ahora se destacan en color mango para encontrarlos de un vistazo.',
      'Botones más grandes y fáciles de tocar, y campos que se marcan en verde al escribir.',
      'Mensajes de aviso, de éxito y de error más claros, y nuevas pantallas para cuando todavía no hay nada que mostrar.',
      'Mejor contraste en modo oscuro.',
    ],
  },
  {
    id: '2026-10-20-servidor-modular',
    date: '2026-10-20',
    title: 'Servidor ordenado por partes',
    for: ['staff'],
    items: [
      'El servidor se dividió en archivos por tema (ingreso, viajes, panel, billetera, tiempo real…). Para pasajeros y conductores todo funciona igual.',
      'Los próximos cambios (vehículos, ganancias, reportes por fecha) serán más rápidos y con menos riesgo de romper otra cosa.',
    ],
  },
  {
    id: '2026-10-20-mapa-carro',
    date: '2026-10-20',
    title: 'Mapa más bonito: el carro se mueve y gira',
    for: ['all'],
    items: [
      'El conductor ahora es un carro dibujado visto desde arriba, en el verde de Jalón, que se ve igual en cualquier celular.',
      'El carro se desliza por el mapa en vez de saltar, y gira hacia la dirección en la que va.',
      'Nuevos pines para el punto de recogida (verde) y el destino (bandera de cuadros).',
      'La ruta tiene borde y sombra para que resalte sobre las calles.',
    ],
  },
  {
    id: '2026-10-20-novedades',
    date: '2026-10-20',
    title: 'Nueva sección de Novedades',
    for: ['all'],
    items: ['Aquí verás un resumen de cada mejora que hagamos en Jalón. El punto verde en «Novedades» avisa cuando hay algo nuevo.'],
  },
  {
    id: '2026-10-20-viajes-confiables',
    date: '2026-10-20',
    title: 'Viajes más confiables',
    for: ['all'],
    items: [
      'Si se toca dos veces «Aceptar» o se aceptan dos ofertas a la vez, el viaje queda con un solo conductor.',
      'Un conductor ya no puede quedar asignado a dos viajes al mismo tiempo.',
      'Si alguien cancela justo cuando el conductor inicia el viaje, se respeta lo que pasó primero.',
      'Cuando actualizamos la app, las solicitudes que estaban buscando conductor siguen activas.',
    ],
  },
  {
    id: '2026-10-20-servidor',
    date: '2026-10-20',
    title: 'Servidor más protegido y rápido',
    for: ['staff'],
    items: [
      'Cada conexión tiene un tope de acciones por segundo: una app modificada ya no puede saturar el servidor.',
      'Las búsquedas de viajes por estado (activos, solicitudes abiertas, vencimientos) usan un índice y no recorren toda la tabla.',
    ],
  },
  {
    id: '2026-10-20-2fa-opcional',
    date: '2026-10-20',
    title: 'Verificación en dos pasos opcional',
    for: ['staff'],
    items: ['El superadmin puede apagar o encender la verificación en dos pasos del personal en Ajustes → Seguridad del personal.'],
  },
];

const STAFF = ['superadmin', 'admin', 'support'];
export const newsFor = (role) => CHANGELOG.filter((n) => n.for.includes('all') || n.for.includes(STAFF.includes(role) ? 'staff' : role));
