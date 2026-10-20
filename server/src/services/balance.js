// Saldo del conductor en vivo: si puede ponerse disponible, la comisión de cada viaje y el crédito de bienvenida
import { pool } from '../db.js';
import { getSettings, postEntry, commissionFor, money } from '../wallet.js';
import { io } from '../app.js';
import { drivers, room } from '../live.js';
import { push } from '../notify.js';

// ---------- Saldo, comisión y recargas por transferencia ----------
// Con la comisión activa, el conductor necesita saldo para ponerse disponible. El saldo se recarga transfiriendo a la cuenta de Jalón
// y subiendo el comprobante; el personal lo autoriza. De ese saldo se descuenta la comisión de cada viaje cobrado en efectivo.
export async function walletGate(userId) {
  const s = await getSettings(pool);
  if (s.commission_enabled !== '1') return { blocked: false };
  const [[u]] = await pool.query('SELECT balance FROM users WHERE id = ?', [userId]);
  const balance = Number(u?.balance || 0);
  return { blocked: balance < Number(s.min_balance), balance, min: Number(s.min_balance) };
}

export const tellWallet = (userId, balance, extra = {}) => io.to(room(userId)).emit('wallet:update', { balance, ...extra });

export async function chargeCommission(ride) {
  const s = await getSettings(pool);
  if (s.commission_enabled !== '1' || !ride.driver_id || !(Number(ride.final_price) > 0)) return;
  const amount = commissionFor(ride.final_price, s.commission_percent);
  if (!(amount > 0)) return;
  const balance = await postEntry(pool, { userId: ride.driver_id, amount: -amount, kind: 'commission', rideId: ride.id, note: `Comisión ${Number(s.commission_percent)}% del viaje #${ride.id}` });
  if (balance === null) return; // esa comisión ya estaba cobrada
  tellWallet(ride.driver_id, balance, { change: -amount, kind: 'commission', rideId: ride.id });
  if (balance < Number(s.min_balance)) {
    // Sin saldo suficiente deja de estar disponible hasta que recargue
    drivers.delete(ride.driver_id);
    io.to(room(ride.driver_id)).emit('wallet:low', { balance, min: Number(s.min_balance) });
    push(ride.driver_id, { title: 'Recarga tu saldo para seguir recibiendo viajes', body: `Tu saldo es L ${balance.toFixed(2)}`, tag: 'wallet-low', url: '/' });
  }
}

// Crédito de bienvenida: una sola vez, al aprobar al conductor, si la comisión está activa
export async function grantWelcome(userId) {
  const s = await getSettings(pool);
  const amount = money(s.welcome_credit);
  if (s.commission_enabled !== '1' || !(amount > 0)) return;
  const [[done]] = await pool.query("SELECT COUNT(*) AS n FROM wallet_entries WHERE user_id = ? AND kind = 'bonus' AND note = 'Crédito de bienvenida'", [userId]);
  if (done.n) return;
  const balance = await postEntry(pool, { userId, amount, kind: 'bonus', note: 'Crédito de bienvenida' });
  if (balance !== null) tellWallet(userId, balance, { change: amount, kind: 'bonus' });
}
