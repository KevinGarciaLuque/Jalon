import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { pool } from './db.js';

// Uso: npm run admin [telefono] [contraseña]
// Si no se indica contraseña se genera una aleatoria y se muestra una sola vez.
const phone = process.argv[2] || 'admin';
const password = process.argv[3] || crypto.randomBytes(9).toString('base64url');
const hash = await bcrypt.hash(password, 10);

await pool.query(
  `INSERT INTO users (name, phone, password_hash, role) VALUES ('Super Admin', ?, ?, 'superadmin')
   ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'superadmin'`,
  [phone, hash]
);

console.log('\nSuper admin listo');
console.log(`  Usuario (teléfono): ${phone}`);
console.log(`  Contraseña:         ${password}\n`);
await pool.end();
