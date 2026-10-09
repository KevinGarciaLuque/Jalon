// Envío de SMS con Twilio (API REST, sin SDK).
// Sin credenciales: en desarrollo el mensaje se imprime en la consola del servidor; en producción falla.
const { TWILIO_ACCOUNT_SID: SID, TWILIO_AUTH_TOKEN: TOKEN, TWILIO_FROM: FROM, TWILIO_MESSAGING_SERVICE_SID: SERVICE } = process.env;

export const smsConfigured = Boolean(SID && TOKEN && (FROM || SERVICE));

export async function sendSms(to, body) {
  if (!smsConfigured) {
    if (process.env.NODE_ENV === 'production') throw new Error('SMS no configurado: define las variables TWILIO_* en .env');
    console.log(`📱 [SMS de desarrollo] a ${to}: ${body}`);
    return;
  }
  const params = new URLSearchParams({ To: to, Body: body });
  if (SERVICE) params.set('MessagingServiceSid', SERVICE);
  else params.set('From', FROM);
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${SID}/Messages.json`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${Buffer.from(`${SID}:${TOKEN}`).toString('base64')}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params,
    signal: AbortSignal.timeout(10000),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(`Twilio ${res.status}: ${err.message || 'error'}`);
  }
}
