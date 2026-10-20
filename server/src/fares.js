// Categorías de servicio y precio sugerido de cada una. Las tarifas se cambian en el panel → Ajustes (solo superadmin).
export const CATEGORIES = ['moto', 'car', 'xl'];
export const CATEGORY_LABEL = { moto: 'Moto', car: 'Carro', xl: 'Carro amplio' };
export const isCategory = (c) => CATEGORIES.includes(c);

// Valores iniciales (lempiras). "Carro" es la tarifa que había antes de las categorías: L 25 + L 12 por km, mínimo L 30.
export const FARE_DEFAULTS = {
  fare_moto_base: '15', fare_moto_km: '8', fare_moto_min: '0', fare_moto_minimum: '20',
  fare_car_base: '25', fare_car_km: '12', fare_car_min: '0', fare_car_minimum: '30',
  fare_xl_base: '35', fare_xl_km: '16', fare_xl_min: '0', fare_xl_minimum: '45',
};

// Base + por km + por minuto, redondeado de 5 en 5 y nunca menos que la tarifa mínima
export function fareFor(settings, category, km, minutes = 0) {
  const n = (k) => Number(settings[`fare_${category}_${k}`] ?? FARE_DEFAULTS[`fare_${category}_${k}`]);
  const raw = n('base') + km * n('km') + (minutes || 0) * n('min');
  return Math.max(n('minimum'), Math.round(raw / 5) * 5);
}

export const faresFor = (settings, km, minutes) => Object.fromEntries(CATEGORIES.map((c) => [c, fareFor(settings, c, km, minutes)]));

// Placa sin espacios ni guiones y en mayúsculas: "HAA 1234" y "haa-1234" son la misma
export const normalizePlate = (p) => String(p || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
