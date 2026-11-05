// Referidos: «Invita y gana» de pasajeros y conductores, la revisión del código al registrarse y la lista del panel
import rateLimit from 'express-rate-limit';
import { pool } from '../db.js';
import { app } from '../app.js';
import { authUser, staffOnly, isStaff } from '../access.js';
import { getSettings, money } from '../wallet.js';
import { pageOf } from '../util.js';
import { shareLinks } from './share.js';
import { referralsOn, referralCodeOf, findReferrer, myReferrals, listReferrals, firstName } from '../services/referrals.js';

// Para que nadie pruebe códigos al azar
const checkLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 30, message: { error: 'Demasiados intentos. Intenta en unos minutos.' } });

const rules = (s) => ({ reward: money(s.referral_reward), welcome: money(s.referral_welcome), driverRides: Number(s.referral_driver_rides), monthlyMax: Number(s.referral_monthly_max) });

// Mi código, el enlace para compartir y a quién invité
app.get('/api/referrals/me', authUser, async (req, res) => {
  if (isStaff(req.user.role)) return res.status(403).json({ error: 'Solo para pasajeros y conductores' });
  if (!(await referralsOn())) return res.json({ enabled: false });
  const code = await referralCodeOf(req.user);
  const s = await getSettings(pool);
  const invites = await myReferrals(req.user.id);
  res.json({
    enabled: true, code, link: `${shareLinks(req).home}?ref=${code}`,
    driver: req.user.role === 'driver' || !!req.user.passenger_mode, // el premio de un conductor es saldo; el de un pasajero, un código de descuento
    ...rules(s), invites,
    earned: money(invites.filter((i) => i.status === 'rewarded').reduce((t, i) => t + (i.reward || 0), 0)),
  });
});

// Al registrarse: ¿existe este código de invitación? (se muestra el nombre de quien invita, solo el primero)
app.get('/api/referrals/check', checkLimiter, async (req, res) => {
  if (!(await referralsOn())) return res.json({ enabled: false });
  const u = await findReferrer(req.query.code);
  if (!u) return res.status(404).json({ error: 'Ese código de invitación no existe' });
  const s = await getSettings(pool);
  res.json({ enabled: true, name: firstName(u.name), welcome: money(s.referral_welcome) });
});

// ---------- Panel ----------
app.get('/api/admin/referrals', staffOnly('settings'), async (req, res) => {
  const s = await getSettings(pool);
  res.json({
    ...(await listReferrals(pageOf(req, 200))),
    enabled: s.referral_enabled === '1', commissionEnabled: s.commission_enabled === '1', ...rules(s),
  });
});
