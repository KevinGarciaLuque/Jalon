// Códigos promocionales: el personal los crea en Promociones y el pasajero los prueba antes de pedir el viaje
import rateLimit from 'express-rate-limit';
import { pool } from '../db.js';
import { app } from '../app.js';
import { authUser, passengerOnly, staffOnly, audit } from '../access.js';
import { getSettings, money } from '../wallet.js';
import { checkPromo, discountFor, promoPublic, PromoError, validatePromo, listPromos, myPromos } from '../services/promos.js';

// Para que nadie pruebe códigos al azar hasta dar con uno
const checkLimiter = rateLimit({ windowMs: 10 * 60 * 1000, limit: 20, message: { error: 'Demasiados intentos con códigos. Intenta en unos minutos.' } });

// El pasajero escribe un código: si sirve, cuánto le descuenta con su precio actual
app.get('/api/promos/check', authUser, passengerOnly, checkLimiter, async (req, res) => {
  try {
    const p = await checkPromo(req.query.code, req.user.id);
    const price = Number(req.query.price) || 0;
    res.json({ promo: promoPublic(p), discount: discountFor(p, price), toPay: money(Math.max(0, price - discountFor(p, price))) });
  } catch (e) {
    if (e instanceof PromoError) return res.status(409).json({ error: e.message });
    throw e;
  }
});

// Los códigos personales del pasajero (p. ej. el premio por invitar): se le ofrecen al pedir el viaje
app.get('/api/promos/mine', authUser, passengerOnly, async (req, res) => res.json({ promos: await myPromos(req.user.id) }));

// ---------- Panel ----------
app.get('/api/admin/promos', staffOnly('settings'), async (_req, res) => {
  res.json({ promos: await listPromos(), commissionEnabled: (await getSettings(pool)).commission_enabled === '1' });
});

const COLS = ['code', 'description', 'kind', 'value', 'max_discount', 'max_uses', 'first_ride_only', 'starts_at', 'expires_at', 'active'];

app.post('/api/admin/promos', staffOnly('settings'), async (req, res) => {
  const { values, error } = validatePromo(req.body || {});
  if (error) return res.status(400).json({ error });
  const cols = COLS.filter((k) => values[k] !== undefined);
  try {
    const [r] = await pool.query(`INSERT INTO promo_codes (${cols.join(', ')}, created_by) VALUES (${cols.map(() => '?').join(', ')}, ?)`, [...cols.map((k) => values[k]), req.staff.id]);
    await audit(req.staff, 'promo.create', { details: { code: values.code } });
    res.json({ id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Ya existe el código ${values.code}` });
    throw e;
  }
});

// Cambiar un código (p. ej. apagarlo o alargar su vencimiento). El código y el tipo de descuento no se cambian si ya se usó.
app.put('/api/admin/promos/:id', staffOnly('settings'), async (req, res) => {
  const [[cur]] = await pool.query('SELECT * FROM promo_codes WHERE id = ?', [Number(req.params.id)]);
  if (!cur) return res.status(404).json({ error: 'Código no encontrado' });
  const { values, error } = validatePromo(req.body || {}, cur);
  if (error) return res.status(400).json({ error });
  const [[{ n }]] = await pool.query('SELECT COUNT(*) AS n FROM rides WHERE promo_id = ?', [cur.id]);
  if (n && ['code', 'kind', 'value', 'max_discount'].some((k) => values[k] !== undefined && String(values[k]) !== String(cur[k])))
    return res.status(409).json({ error: 'Este código ya se usó: no se puede cambiar su nombre ni su descuento. Apágalo y crea otro.' });
  const cols = COLS.filter((k) => values[k] !== undefined);
  if (!cols.length) return res.json({ ok: true });
  try {
    await pool.query(`UPDATE promo_codes SET ${cols.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...cols.map((k) => values[k]), cur.id]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(409).json({ error: `Ya existe el código ${values.code}` });
    throw e;
  }
  await audit(req.staff, 'promo.update', { details: { code: cur.code, changed: cols } });
  res.json({ ok: true });
});
