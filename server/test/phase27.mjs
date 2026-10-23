import 'dotenv/config';
// Entrar con Face ID / huella (llaves de acceso): un «celular simulado» crea su llave, firma como lo haría el iPhone,
// y se revisa que el servidor rechace firmas falsas, desafíos repetidos, llaves sin Face ID y llaves borradas.
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { pool } from '../src/db.js';
import { getSettings } from '../src/wallet.js';
import { http, registerUser, createTestSuperadmin } from './helpers.mjs';

let fails = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'OK  ' : 'FAIL'} ${name} ${extra}`); if (!ok) fails++; };
const rnd = String(Math.floor(Math.random() * 1e5)).padStart(5, '0');
const ORIGIN = process.env.CLIENT_ORIGIN || 'http://localhost:5173';
const b64u = (buf) => Buffer.from(buf).toString('base64url');
const sha256 = (data) => crypto.createHash('sha256').update(data).digest();

// ---- CBOR mínimo (mapas, textos, bytes y enteros), lo que usa WebAuthn ----
function cbor(v) {
  const head = (major, n) => {
    if (n < 24) return Buffer.from([(major << 5) | n]);
    if (n < 256) return Buffer.from([(major << 5) | 24, n]);
    if (n < 65536) { const b = Buffer.alloc(3); b[0] = (major << 5) | 25; b.writeUInt16BE(n, 1); return b; }
    const b = Buffer.alloc(5); b[0] = (major << 5) | 26; b.writeUInt32BE(n, 1); return b;
  };
  if (Number.isInteger(v)) return v >= 0 ? head(0, v) : head(1, -1 - v);
  if (typeof v === 'string') { const s = Buffer.from(v); return Buffer.concat([head(3, s.length), s]); }
  if (Buffer.isBuffer(v)) return Buffer.concat([head(2, v.length), v]);
  if (v instanceof Map) return Buffer.concat([head(5, v.size), ...[...v].flatMap(([k, x]) => [cbor(k), cbor(x)])]);
  throw new Error('tipo CBOR no soportado');
}

// ---- El celular simulado: una llave ES256 (P-256) guardada «en el aparato» ----
function fakePhone() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credId = crypto.randomBytes(16);
  let counter = 0;
  const cose = cbor(new Map([[1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')], [-3, Buffer.from(jwk.y, 'base64url')]]));
  const flags = (uv) => 0x01 | (uv ? 0x04 : 0);
  return {
    id: b64u(credId),
    register(options, { uv = true } = {}) {
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.create', challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
      const credLen = Buffer.alloc(2); credLen.writeUInt16BE(credId.length);
      const authData = Buffer.concat([sha256(options.rp.id), Buffer.from([flags(uv) | 0x40]), Buffer.alloc(4), Buffer.alloc(16), credLen, credId, cose]);
      const attestationObject = cbor(new Map([['fmt', 'none'], ['attStmt', new Map()], ['authData', authData]]));
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), attestationObject: b64u(attestationObject), transports: ['internal'] } };
    },
    login(options, { uv = true, tamper = false, userHandle = '' } = {}) {
      counter += 1;
      const clientData = Buffer.from(JSON.stringify({ type: 'webauthn.get', challenge: options.challenge, origin: ORIGIN, crossOrigin: false }));
      const c = Buffer.alloc(4); c.writeUInt32BE(counter);
      const authData = Buffer.concat([sha256(options.rpId), Buffer.from([flags(uv)]), c]);
      let signature = crypto.sign('sha256', Buffer.concat([authData, sha256(clientData)]), privateKey);
      if (tamper) signature = crypto.sign('sha256', Buffer.from('otra cosa'), privateKey);
      return { id: b64u(credId), rawId: b64u(credId), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: b64u(clientData), authenticatorData: b64u(authData), signature: b64u(signature), userHandle } };
    },
  };
}

const startLogin = () => http('POST', 'passkeys/login/options', null, {});
const finishLogin = (token, response) => http('POST', 'passkeys/login/verify', null, { token, response });

try {
  const P = await registerUser({ name: 'C27 Pasajero', phone: `84${rnd}7`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const Q = await registerUser({ name: 'C27 Otro', phone: `85${rnd}7`.slice(0, 8), password: 'Cielo-azul-77', role: 'passenger' });
  const phone = fakePhone();

  check('activar Face ID pide tener la sesión abierta', (await http('POST', 'passkeys/register/options', null, {})).status === 401);

  // Activar en el celular
  const reg = await http('POST', 'passkeys/register/options', P.token, {});
  check('el servidor manda las opciones para crear la llave (Face ID obligatorio)', !!reg.options?.challenge && reg.options.authenticatorSelection?.userVerification === 'required' && !!reg.token);
  const other = await http('POST', 'passkeys/register/options', Q.token, {});
  check('un desafío de otra cuenta no sirve para activar', (await http('POST', 'passkeys/register/verify', P.token, { token: other.token, response: phone.register(other.options) })).status === 400);
  const noUv = fakePhone();
  const reg2 = await http('POST', 'passkeys/register/options', P.token, {});
  check('sin Face ID / huella (solo tocar) no se activa', (await http('POST', 'passkeys/register/verify', P.token, { token: reg2.token, response: noUv.register(reg2.options, { uv: false }) })).status === 400);
  const ok = await http('POST', 'passkeys/register/verify', P.token, { token: reg.token, response: phone.register(reg.options) });
  check('con Face ID se activa y aparece en la lista de aparatos', ok.ok === true && ok.passkeys?.length === 1, `(${ok.status} ${ok.error || ''})`);
  check('el mismo desafío no sirve dos veces', (await http('POST', 'passkeys/register/verify', P.token, { token: reg.token, response: phone.register(reg.options) })).status === 400);
  const [[row]] = await pool.query('SELECT public_key, credential_id FROM passkeys WHERE user_id = ?', [P.user.id]);
  check('solo se guarda la llave pública', !!row && row.credential_id === phone.id && row.public_key.length > 30);

  // Entrar
  let o = await startLogin();
  const login = await finishLogin(o.token, phone.login(o.options));
  check('entra con Face ID a su cuenta', !!login.token && login.user?.id === P.user.id, `(${login.status} ${login.error || ''})`);
  check('la sesión de Face ID sirve como la de la contraseña', (await http('GET', 'me', login.token)).user?.id === P.user.id);
  check('el mismo desafío no sirve para entrar dos veces', (await finishLogin(o.token, phone.login(o.options))).status === 400);
  o = await startLogin();
  check('una firma falsa no entra', (await finishLogin(o.token, phone.login(o.options, { tamper: true }))).status === 401);
  o = await startLogin();
  check('sin Face ID / huella no entra', (await finishLogin(o.token, phone.login(o.options, { uv: false }))).status === 401);
  o = await startLogin();
  check('una llave que el servidor no conoce no entra', (await finishLogin(o.token, fakePhone().login(o.options))).status === 401);
  check('un desafío inventado no sirve', (await finishLogin(jwt.sign({ purpose: 'pk-login', ch: 'abc' }, 'otra-clave'), phone.login({ challenge: 'abc', rpId: 'localhost' }))).status === 400);

  // Quitar el aparato: ya no entra
  const list = await http('GET', 'passkeys', P.token);
  check('el pasajero ve sus aparatos', list.passkeys?.length === 1 && !!list.passkeys[0].device);
  check('otra cuenta no puede quitar su aparato', (await http('DELETE', `passkeys/${list.passkeys[0].id}`, Q.token)).status === 404);
  check('lo puede quitar', (await http('DELETE', `passkeys/${list.passkeys[0].id}`, P.token)).passkeys?.length === 0);
  o = await startLogin();
  check('después de quitarlo ya no entra con esa llave', (await finishLogin(o.token, phone.login(o.options))).status === 401);

  // Cerrar la sesión en todos los aparatos también desactiva Face ID
  const phone2 = fakePhone();
  let r = await http('POST', 'passkeys/register/options', P.token, {});
  await http('POST', 'passkeys/register/verify', P.token, { token: r.token, response: phone2.register(r.options) });
  const out = await http('POST', 'logout-all', P.token, {});
  const [[n1]] = await pool.query('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?', [P.user.id]);
  check('«cerrar sesión en todos los aparatos» desactiva Face ID', !!out.token && n1.n === 0);

  // Bloquear la cuenta borra sus llaves
  const root = await createTestSuperadmin(pool);
  const SA = jwt.sign({ id: root.id, role: 'superadmin' }, process.env.JWT_SECRET, { expiresIn: '10m' });
  const phone3 = fakePhone();
  r = await http('POST', 'passkeys/register/options', out.token, {});
  await http('POST', 'passkeys/register/verify', out.token, { token: r.token, response: phone3.register(r.options) });
  await http('POST', `admin/users/${P.user.id}/status`, SA, { status: 'blocked' });
  o = await startLogin();
  const blocked = await finishLogin(o.token, phone3.login(o.options));
  const [[n2]] = await pool.query('SELECT COUNT(*) AS n FROM passkeys WHERE user_id = ?', [P.user.id]);
  check('al bloquear la cuenta se borran sus llaves y ya no entra', n2.n === 0 && blocked.status === 401);

  // El personal con verificación en dos pasos sigue poniendo su código después de Face ID
  const staffPhone = fakePhone();
  r = await http('POST', 'passkeys/register/options', SA, {});
  await http('POST', 'passkeys/register/verify', SA, { token: r.token, response: staffPhone.register(r.options) });
  o = await startLogin();
  const staffLogin = await finishLogin(o.token, staffPhone.login(o.options));
  const required = (await getSettings(pool)).staff_2fa_required !== '0';
  check('el personal entra con Face ID pero todavía le pide el código de 6 dígitos', required ? staffLogin.twoFactor === true && !!staffLogin.challenge && !staffLogin.token : !!staffLogin.token, `(${JSON.stringify(Object.keys(staffLogin))})`);
  check('el Registro anota que activó Face ID', !!(await pool.query("SELECT 1 FROM audit_log WHERE actor_id = ? AND action = 'passkey.add'", [root.id]))[0][0]);
  await pool.query('DELETE FROM passkeys WHERE user_id = ?', [root.id]);
} catch (e) {
  check('la prueba terminó sin errores', false, e.stack);
}

await pool.end();
console.log(fails ? `\n${fails} prueba(s) fallaron` : '\nTodo bien');
process.exit(fails ? 1 : 0);
