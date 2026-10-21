// Al poner o cambiar DATA_KEY: lo que estaba cifrado con la llave anterior se vuelve a cifrar con la actual, una sola vez.
// Documentos y comprobantes (archivos .enc) y los secretos de la verificación en dos pasos (users.totp_secret).
// Cada archivo nuevo se comprueba antes de reemplazar al anterior, y el reemplazo es atómico (rename): si algo falla, queda el de antes.
import fs from 'fs/promises';
import path from 'path';
import { pool } from './db.js';
import { openBuffer, encryptBuffer, isEncrypted, hasOldKeys } from './secure.js';

// El último resultado, para el «Estado del sistema» del panel
export let lastRekey = { files: 0, secrets: 0, unreadable: 0, pending: 0, at: null };

function reseal(blob) {
  const { plain, current } = openBuffer(blob);
  if (current) return null;
  const sealed = encryptBuffer(plain);
  const check = openBuffer(sealed);
  if (!check.current || !check.plain.equals(plain)) throw new Error('la copia nueva no se pudo comprobar');
  return sealed;
}

// `userIds`: solo esas personas (para las pruebas); sin él, todas
export async function rekeyAll(uploadsDir, { userIds = null } = {}) {
  const out = { files: 0, secrets: 0, unreadable: 0, pending: 0, at: new Date().toISOString() };
  if (!hasOldKeys) return (lastRekey = out);

  let names = [];
  try {
    names = (await fs.readdir(uploadsDir)).filter((n) => n.endsWith('.enc'));
  } catch { /* sin carpeta todavía */ }
  for (const name of names) {
    const file = path.join(uploadsDir, name);
    try {
      const blob = await fs.readFile(file);
      if (!isEncrypted(blob)) continue;
      const sealed = reseal(blob);
      if (!sealed) continue;
      await fs.writeFile(`${file}.rekey`, sealed);
      await fs.rename(`${file}.rekey`, file);
      out.files++;
    } catch (e) {
      out.unreadable++;
      console.warn(`Cifrado: no se pudo pasar ${name} a la llave nueva (${e.message}); se deja como estaba`);
      await fs.rm(`${file}.rekey`, { force: true }).catch(() => {});
    }
  }

  const [users] = await pool.query(
    `SELECT id, totp_secret FROM users WHERE totp_secret IS NOT NULL${userIds ? ' AND id IN (?)' : ''}`, userIds ? [userIds] : []
  );
  for (const u of users) {
    try {
      const sealed = reseal(Buffer.from(u.totp_secret, 'base64'));
      if (!sealed) continue;
      // Solo si nadie lo cambió mientras tanto
      const [r] = await pool.query('UPDATE users SET totp_secret = ? WHERE id = ? AND totp_secret = ?', [sealed.toString('base64'), u.id, u.totp_secret]);
      if (r.affectedRows) out.secrets++;
      else out.pending++;
    } catch (e) {
      out.unreadable++;
      console.warn(`Cifrado: no se pudo pasar el secreto 2FA de la cuenta #${u.id} a la llave nueva (${e.message})`);
    }
  }
  return (lastRekey = out);
}
