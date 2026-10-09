// Distancia en km entre dos puntos (fórmula de Haversine)
export function distanceKm(lat1, lng1, lat2, lng2) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Precio sugerido en Lempiras a partir de los km por calle: base + por km
export function suggestedPrice(km) {
  return Math.max(30, Math.round((25 + km * 12) / 5) * 5);
}
