import fs from 'fs';

export const API = 'http://localhost:4000';
export const FIXTURE = fs.readFileSync(new URL('./fixtures/doc.jpg', import.meta.url));
export const JPG = `data:image/jpeg;base64,${FIXTURE.toString('base64')}`;

// Llama a la API y devuelve { status, ...json } (si la respuesta es una lista, el arreglo con .status)
export async function http(method, path, token, body) {
  const r = await fetch(`${API}/api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const j = await r.json().catch(() => ({}));
  return Array.isArray(j) ? Object.assign(j, { status: r.status }) : { status: r.status, ...j };
}

// Registro con verificación por SMS: en desarrollo el servidor devuelve el código en la respuesta
export async function registerUser(data) {
  const o = await http('POST', 'otp/send', null, { phone: data.phone });
  if (!o.devCode) throw new Error(`No se pudo obtener el código de prueba (${o.status} ${o.error || ''})`);
  return http('POST', 'register', null, { ...data, code: o.devCode });
}

// Sube los 3 documentos que exige la aprobación de un conductor
export async function uploadDocs(token) {
  for (const type of ['photo', 'license', 'registration']) {
    const r = await http('PUT', `driver/documents/${type}`, token, { image: JPG });
    if (!r.ok) throw new Error(`No se pudo subir ${type}: ${r.error}`);
  }
}
