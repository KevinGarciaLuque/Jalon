// Propinas: al terminar, el pasajero puede dejarle propina en efectivo al conductor. Queda anotada en el viaje
// (para el recibo y las ganancias) y es toda del conductor: Ktracho GO no le cobra comisión.
import { pool } from '../db.js';
import { getSettings, money } from '../wallet.js';

export const TIP_MAX = 500;
export const TIP_WINDOW_MIN = 15; // solo mientras el pasajero sigue con el conductor

export const tipsOn = async () => (await getSettings(pool)).tips_enabled !== '0';

// ¿Todavía se puede dejar propina en este viaje? (se mide con el reloj de la base, igual que al guardarla)
export async function tipOpen(ride) {
  if (ride.status !== 'completed' || ride.tip != null || ride.collected_at || !ride.driver_id || !(await tipsOn())) return false;
  const [[r]] = await pool.query(`SELECT completed_at >= NOW() - INTERVAL ${TIP_WINDOW_MIN} MINUTE AS fresh FROM rides WHERE id = ?`, [ride.id]);
  return !!Number(r?.fresh);
}

// Guarda la propina una sola vez. Devuelve { ok } o { status, error }
export async function giveTip(ride, passengerId, rawAmount) {
  if (!(await tipsOn())) return { status: 403, error: 'Las propinas no están disponibles por ahora' };
  const amount = Number(rawAmount);
  if (!Number.isInteger(amount) || amount < 1 || amount > TIP_MAX) return { status: 400, error: `La propina debe ser de L 1 a L ${TIP_MAX}, sin centavos` };
  if (!ride || ride.passenger_id !== passengerId) return { status: 404, error: 'Viaje no encontrado' };
  if (ride.status !== 'completed' || !ride.driver_id) return { status: 409, error: 'Solo se deja propina en un viaje terminado' };
  const [r] = await pool.query(
    `UPDATE rides SET tip = ?, tipped_at = NOW()
     WHERE id = ? AND passenger_id = ? AND status = 'completed' AND tip IS NULL AND collected_at IS NULL AND completed_at >= NOW() - INTERVAL ${TIP_WINDOW_MIN} MINUTE`,
    [amount, ride.id, passengerId]
  );
  if (r.affectedRows === 1) return { ok: true, amount: money(amount) };
  const [[now]] = await pool.query('SELECT tip, collected_at FROM rides WHERE id = ?', [ride.id]);
  if (now?.collected_at && now?.tip == null) return { status: 409, error: 'El conductor ya cobró el viaje: ya no se puede dejar propina' };
  if (now?.tip != null) return { status: 409, error: 'Ya dejaste propina en este viaje' };
  return { status: 409, error: 'Ya pasó el tiempo para dejar propina en este viaje' };
}
