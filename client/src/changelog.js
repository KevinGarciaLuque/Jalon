// Novedades del sistema: un resumen corto de cada cambio, lo más nuevo primero.
// Cada cambio que se publique agrega aquí su entrada (con un `id` que no se repita) para que aparezca en el botón «Novedades».
// `for` dice quién la ve: 'all', 'passenger', 'driver' o 'staff' (superadmin, administrador y soporte).
export const CHANGELOG = [
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
