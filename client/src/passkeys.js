// Entrar con Face ID / huella (llaves de acceso). La cara o la huella nunca salen del celular:
// el celular firma con su llave y el servidor revisa la firma con la llave pública que guardó.
import { browserSupportsWebAuthn, platformAuthenticatorIsAvailable, startAuthentication, startRegistration } from '@simplewebauthn/browser';
import { api, apiDelete, apiGet, apiPost } from './lib.js';

const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
// Cómo se llama en este aparato
export const passkeyName = /iPhone|iPad/i.test(ua) ? 'Face ID' : /Android/i.test(ua) ? 'tu huella' : /Macintosh/i.test(ua) ? 'Touch ID' : /Windows/i.test(ua) ? 'Windows Hello' : 'Face ID o huella';

export const passkeysSupported = () => browserSupportsWebAuthn();
// Este aparato tiene Face ID, huella o similar (no una llave USB)
export const deviceCanUnlock = () => (browserSupportsWebAuthn() ? platformAuthenticatorIsAvailable().catch(() => false) : Promise.resolve(false));

// Las llaves quedan atadas a ktrachogo.com: en otra dirección (p. ej. la de respaldo de Railway) no funcionan
function checkSite(rpId) {
  const host = window.location.hostname;
  if (host !== rpId && !host.endsWith(`.${rpId}`)) throw new Error(`Entrar con ${passkeyName} solo funciona en ${rpId}. Aquí entra con tu contraseña.`);
}
// Si la persona cancela o cierra Face ID, no es un error que haya que mostrar
const cancelled = (e) => e?.name === 'NotAllowedError' || e?.name === 'AbortError';
function friendly(e) {
  if (cancelled(e)) return null;
  if (e?.name === 'InvalidStateError') return new Error(`Este aparato ya tiene ${passkeyName} activado.`);
  return new Error(`No se pudo usar ${passkeyName} en este aparato. Puedes seguir entrando con tu contraseña.`); // el mensaje del navegador viene en inglés
}

// Entrar: devuelve lo mismo que entrar con contraseña ({ user } o { twoFactor, challenge }), o null si la persona canceló
export async function loginWithPasskey() {
  const { options, token } = await api('passkeys/login/options', {});
  checkSite(options.rpId);
  let response;
  try {
    response = await startAuthentication({ optionsJSON: options });
  } catch (e) {
    const err = friendly(e);
    if (!err) return null;
    throw err;
  }
  return api('passkeys/login/verify', { token, response });
}

// Activar en este aparato (con la sesión abierta). Devuelve la lista nueva, o null si la persona canceló
export async function activatePasskey(token) {
  const { options, token: challenge } = await apiPost('passkeys/register/options', token);
  checkSite(options.rp.id);
  let response;
  try {
    response = await startRegistration({ optionsJSON: options });
  } catch (e) {
    const err = friendly(e);
    if (!err) return null;
    throw err;
  }
  return (await apiPost('passkeys/register/verify', token, { token: challenge, response })).passkeys;
}

export const listPasskeys = async (token) => (await apiGet('passkeys', token)).passkeys;
export const removePasskey = async (token, id) => (await apiDelete(`passkeys/${id}`, token)).passkeys;
