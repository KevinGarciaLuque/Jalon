// Honduras: 8 dígitos (con o sin +504). Otros países se aceptan con código de país.
export function normalizePhone(raw) {
  const s = String(raw ?? '').replace(/[\s\-().]/g, '');
  const hn = s.match(/^(?:\+?504)?(\d{8})$/);
  if (hn) return hn[1];
  return /^\+?\d{8,15}$/.test(s) ? s : null;
}

// Formato internacional que exige Twilio
export function toE164(phone) {
  if (/^\d{8}$/.test(phone)) return `+504${phone}`;
  return phone.startsWith('+') ? phone : `+${phone}`;
}
