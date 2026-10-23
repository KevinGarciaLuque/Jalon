// Las cuentas de Ktracho GO para recibir transferencias (recargas de saldo y alquileres pagados por transferencia)
import { pool } from '../db.js';

export const activeAccounts = async () => (await pool.query('SELECT * FROM bank_accounts WHERE active = 1 ORDER BY id'))[0];

// Para los alquileres por transferencia: la primera cuenta activa, con la forma que usa la app
export async function rentalAccount() {
  const [a] = await activeAccounts();
  return a ? { name: a.bank, type: a.account_type, account: a.account_number, holder: a.holder, note: a.note } : null;
}
