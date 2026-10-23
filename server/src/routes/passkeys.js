// Entrar con Face ID / huella (llaves de acceso, WebAuthn). El celular guarda la llave privada y pide la cara o la huella;
// aquí solo queda la llave pública. La contraseña sigue sirviendo siempre. El personal con verificación en dos pasos
// todavía tiene que poner su código de 6 dígitos después de la llave.
import jwt from 'jsonwebtoken';
import { generateRegistrationOptions, verifyRegistrationResponse, generateAuthenticationOptions, verifyAuthenticationResponse } from '@simplewebauthn/server';
import { pool } from '../db.js';
import { JWT_SECRET, PUBLIC_URL, isProd } from '../config.js';
import { app, loginLimiter } from '../app.js';
import { startSession, authUser, twoFactorRequired, publicUser, isStaff, audit } from '../access.js';
import { permsFor } from '../perms.js';

const MAX_PER_USER = 10;
const CHALLENGE_MIN = 3; // minutos para completar Face ID

// El sitio al que quedan atadas las llaves: ktrachogo.com (sirve también en www). En desarrollo, localhost.
export function relyingParty(req) {
  const base = PUBLIC_URL ? new URL(PUBLIC_URL) : null;
  const rpID = process.env.WEBAUTHN_RP_ID || (base ? base.hostname.replace(/^www\./, '') : req.hostname);
  const origins = new Set();
  if (base) {
    origins.add(base.origin);
    const twin = base.hostname.startsWith('www.') ? base.hostname.slice(4) : `www.${base.hostname}`;
    origins.add(`${base.protocol}//${twin}${base.port ? `:${base.port}` : ''}`);
  }
  if (process.env.CLIENT_ORIGIN) origins.add(process.env.CLIENT_ORIGIN);
  const origin = req.get('origin');
  if (!isProd && origin && /^http:\/\/localhost(:\d+)?$/.test(origin)) origins.add(origin);
  return { rpID, origins: [...origins] };
}

// El desafío viaja firmado (no se guarda) y se usa una sola vez
const used = new Map(); // desafío → vence (ms)
const signChallenge = (purpose, challenge, uid = 0) => jwt.sign({ purpose, ch: challenge, uid }, JWT_SECRET, { expiresIn: `${CHALLENGE_MIN}m` });
function readChallenge(token, purpose) {
  try {
    const p = jwt.verify(String(token || ''), JWT_SECRET);
    if (p.purpose !== purpose || used.has(p.ch)) return null;
    const now = Date.now();
    for (const [ch, until] of used) if (until < now) used.delete(ch);
    used.set(p.ch, now + CHALLENGE_MIN * 60 * 1000);
    return p;
  } catch {
    return null;
  }
}

// Nombre del aparato para la lista de Mi cuenta
function deviceName(ua = '') {
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows';
  return 'Otro aparato';
}
const listFor = async (userId) => {
  const [rows] = await pool.query('SELECT id, device_name, created_at, last_used_at FROM passkeys WHERE user_id = ? ORDER BY id DESC', [userId]);
  return rows.map((r) => ({ id: r.id, device: r.device_name, createdAt: r.created_at, lastUsedAt: r.last_used_at }));
};

// ---- Activar Face ID en este aparato (con la sesión abierta) ----
app.post('/api/passkeys/register/options', authUser, async (req, res) => {
  const u = req.user;
  const [mine] = await pool.query('SELECT credential_id, transports FROM passkeys WHERE user_id = ?', [u.id]);
  if (mine.length >= MAX_PER_USER) return res.status(400).json({ error: `Ya tienes ${MAX_PER_USER} aparatos con Face ID o huella. Quita alguno en Mi cuenta.` });
  const { rpID } = relyingParty(req);
  const options = await generateRegistrationOptions({
    rpName: 'Ktracho GO',
    rpID,
    userName: u.phone,
    userDisplayName: u.name,
    userID: new TextEncoder().encode(`ktracho-${u.id}`),
    attestationType: 'none',
    excludeCredentials: mine.map((c) => ({ id: c.credential_id, transports: c.transports ? c.transports.split(',') : undefined })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
  });
  res.json({ options, token: signChallenge('pk-reg', options.challenge, u.id) });
});

app.post('/api/passkeys/register/verify', authUser, async (req, res) => {
  const u = req.user;
  const c = readChallenge(req.body?.token, 'pk-reg');
  if (!c || c.uid !== u.id) return res.status(400).json({ error: 'Se acabó el tiempo. Vuelve a intentarlo.' });
  const { rpID, origins } = relyingParty(req);
  let result;
  try {
    result = await verifyRegistrationResponse({ response: req.body?.response, expectedChallenge: c.ch, expectedOrigin: origins, expectedRPID: rpID, requireUserVerification: true });
  } catch {
    return res.status(400).json({ error: 'No se pudo activar Face ID o la huella en este aparato.' });
  }
  if (!result.verified) return res.status(400).json({ error: 'No se pudo activar Face ID o la huella en este aparato.' });
  const { credential } = result.registrationInfo;
  try {
    await pool.query('INSERT INTO passkeys (user_id, credential_id, public_key, counter, transports, device_name) VALUES (?,?,?,?,?,?)', [
      u.id, credential.id, Buffer.from(credential.publicKey), credential.counter || 0, (credential.transports || []).join(',') || null, deviceName(req.get('user-agent')),
    ]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: 'Este aparato ya tiene Face ID o huella activado.' });
    throw e;
  }
  await audit(u, 'passkey.add', { target: u.id, details: { device: deviceName(req.get('user-agent')) } });
  res.json({ ok: true, passkeys: await listFor(u.id) });
});

// ---- Mis aparatos con Face ID ----
app.get('/api/passkeys', authUser, async (req, res) => res.json({ passkeys: await listFor(req.user.id) }));

app.delete('/api/passkeys/:id', authUser, async (req, res) => {
  const [r] = await pool.query('DELETE FROM passkeys WHERE id = ? AND user_id = ?', [Number(req.params.id) || 0, req.user.id]);
  if (!r.affectedRows) return res.status(404).json({ error: 'Ese aparato ya no está en la lista' });
  await audit(req.user, 'passkey.remove', { target: req.user.id });
  res.json({ ok: true, passkeys: await listFor(req.user.id) });
});

// ---- Entrar con Face ID: el celular ofrece las cuentas guardadas para este sitio ----
app.post('/api/passkeys/login/options', loginLimiter, async (req, res) => {
  const { rpID } = relyingParty(req);
  const options = await generateAuthenticationOptions({ rpID, userVerification: 'required' });
  res.json({ options, token: signChallenge('pk-login', options.challenge) });
});

app.post('/api/passkeys/login/verify', loginLimiter, async (req, res) => {
  try {
    const fail = () => res.status(401).json({ error: 'No pudimos reconocerte con Face ID o la huella. Entra con tu contraseña.' });
    const c = readChallenge(req.body?.token, 'pk-login');
    if (!c) return res.status(400).json({ error: 'Se acabó el tiempo. Vuelve a intentarlo.' });
    const response = req.body?.response;
    if (typeof response?.id !== 'string') return fail();
    const [[key]] = await pool.query('SELECT * FROM passkeys WHERE credential_id = ?', [response.id]);
    if (!key) return fail();
    const [[u]] = await pool.query('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL', [key.user_id]);
    if (!u) return fail();
    const { rpID, origins } = relyingParty(req);
    let result;
    try {
      result = await verifyAuthenticationResponse({
        response, expectedChallenge: c.ch, expectedOrigin: origins, expectedRPID: rpID, requireUserVerification: true,
        credential: { id: key.credential_id, publicKey: new Uint8Array(key.public_key), counter: Number(key.counter), transports: key.transports ? key.transports.split(',') : undefined },
      });
    } catch {
      return fail();
    }
    if (!result.verified) return fail();
    await pool.query('UPDATE passkeys SET counter = ?, last_used_at = NOW() WHERE id = ?', [result.authenticationInfo.newCounter, key.id]);
    if (u.status === 'blocked') return res.status(403).json({ error: 'Tu cuenta está bloqueada. Contacta a soporte.' });
    // El personal con verificación en dos pasos sigue poniendo su código (igual que con la contraseña)
    const require2fa = isStaff(u.role) && (await twoFactorRequired());
    if (require2fa && u.totp_enabled) {
      return res.json({ twoFactor: true, challenge: jwt.sign({ id: u.id, purpose: '2fa' }, JWT_SECRET, { expiresIn: '5m' }) });
    }
    res.json({ ...startSession(req, res, u), user: publicUser(u, require2fa, await permsFor(u)) });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: 'Error del servidor' });
  }
});

