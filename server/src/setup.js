import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import { normalizePhone } from './phone.js';
import { dbConfig, DB_NAME } from './db.js';

const conn = await mysql.createConnection(dbConfig);

await conn.query(`CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
await conn.query(`USE \`${DB_NAME}\``);

await conn.query(`
  CREATE TABLE IF NOT EXISTS users (
    id INT AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(100) NOT NULL,
    phone VARCHAR(20) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    role ENUM('passenger','driver','admin','superadmin','support') NOT NULL,
    vehicle VARCHAR(100) NULL,
    plate VARCHAR(20) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
  )
`);

await conn.query(`
  CREATE TABLE IF NOT EXISTS rides (
    id INT AUTO_INCREMENT PRIMARY KEY,
    passenger_id INT NOT NULL,
    driver_id INT NULL,
    origin_lat DOUBLE NOT NULL,
    origin_lng DOUBLE NOT NULL,
    origin_text VARCHAR(200) NULL,
    dest_lat DOUBLE NOT NULL,
    dest_lng DOUBLE NOT NULL,
    dest_text VARCHAR(200) NULL,
    distance_km DOUBLE NOT NULL,
    offered_price DECIMAL(10,2) NOT NULL,
    final_price DECIMAL(10,2) NULL,
    status ENUM('requested','accepted','arrived','started','completed','cancelled') NOT NULL DEFAULT 'requested',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (passenger_id) REFERENCES users(id),
    FOREIGN KEY (driver_id) REFERENCES users(id)
  )
`);

await conn.query(`
  CREATE TABLE IF NOT EXISTS offers (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ride_id INT NOT NULL,
    driver_id INT NOT NULL,
    price DECIMAL(10,2) NOT NULL,
    status ENUM('pending','accepted','rejected') NOT NULL DEFAULT 'pending',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (ride_id) REFERENCES rides(id),
    FOREIGN KEY (driver_id) REFERENCES users(id)
  )
`);

// Bases creadas antes de existir el rol admin
await conn.query("ALTER TABLE users MODIFY role ENUM('passenger','driver','admin','superadmin','support') NOT NULL");

// Migraciones: agrega columnas si todavía no existen (MySQL 8 no tiene ADD COLUMN IF NOT EXISTS)
async function addColumn(table, column, definition) {
  const [rows] = await conn.query(
    'SELECT 1 FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
    [DB_NAME, table, column]
  );
  if (!rows.length) await conn.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
}
// pending: conductor esperando aprobación | active | blocked
await addColumn('users', 'email', 'VARCHAR(160) NULL');
{
  const [idx] = await conn.query("SHOW INDEX FROM users WHERE Key_name = 'uniq_email'");
  if (!idx.length) await conn.query('ALTER TABLE users ADD UNIQUE KEY uniq_email (email)');
}
await addColumn('users', 'can_monitor', 'TINYINT(1) NOT NULL DEFAULT 0');
await addColumn('users', 'status', "ENUM('pending','active','blocked') NOT NULL DEFAULT 'active'");
await addColumn('rides', 'cancelled_by', "ENUM('passenger','driver','admin','system') NULL");

// Fase 3: ruta real, compartir viaje, calificaciones y alertas de emergencia
await addColumn('rides', 'duration_min', 'DOUBLE NULL');
await addColumn('rides', 'route_json', 'MEDIUMTEXT NULL');
await addColumn('rides', 'share_token', 'VARCHAR(32) NULL');

const [idx] = await conn.query(
  "SELECT 1 FROM information_schema.statistics WHERE table_schema = ? AND table_name = 'rides' AND index_name = 'idx_share_token'",
  [DB_NAME]
);
if (!idx.length) await conn.query('CREATE INDEX idx_share_token ON rides (share_token)');

await conn.query(`
  CREATE TABLE IF NOT EXISTS ratings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ride_id INT NOT NULL,
    rater_id INT NOT NULL,
    ratee_id INT NOT NULL,
    stars TINYINT NOT NULL,
    comment VARCHAR(200) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY one_per_ride (ride_id, rater_id),
    KEY by_ratee (ratee_id),
    FOREIGN KEY (ride_id) REFERENCES rides(id),
    FOREIGN KEY (rater_id) REFERENCES users(id),
    FOREIGN KEY (ratee_id) REFERENCES users(id)
  )
`);

await conn.query(`
  CREATE TABLE IF NOT EXISTS alerts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ride_id INT NOT NULL,
    user_id INT NOT NULL,
    lat DOUBLE NULL,
    lng DOUBLE NULL,
    status ENUM('open','resolved') NOT NULL DEFAULT 'open',
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP NULL,
    FOREIGN KEY (ride_id) REFERENCES rides(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Fase 4: verificación por SMS, documentos del conductor y cierre de sesiones al cambiar la contraseña
await addColumn('users', 'token_version', 'INT NOT NULL DEFAULT 0');

await conn.query(`
  CREATE TABLE IF NOT EXISTS otp_codes (
    id INT AUTO_INCREMENT PRIMARY KEY,
    phone VARCHAR(20) NOT NULL,
    purpose ENUM('register','reset') NOT NULL,
    code_hash CHAR(64) NOT NULL,
    attempts TINYINT NOT NULL DEFAULT 0,
    used TINYINT(1) NOT NULL DEFAULT 0,
    expires_at TIMESTAMP NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY by_phone (phone, purpose)
  )
`);
await addColumn('otp_codes', 'email', 'VARCHAR(160) NULL');

await conn.query(`
  CREATE TABLE IF NOT EXISTS documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    type ENUM('photo','license','registration') NOT NULL,
    file VARCHAR(100) NOT NULL,
    status ENUM('uploaded','rejected') NOT NULL DEFAULT 'uploaded',
    note VARCHAR(200) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY one_per_type (user_id, type),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Fase 5: constancia de que el usuario aceptó los términos y la política de privacidad
await addColumn('users', 'terms_accepted_at', 'TIMESTAMP NULL');
await addColumn('users', 'terms_version', 'VARCHAR(10) NULL');

// Fase 5B: gestión de usuarios y personal
await addColumn('users', 'must_change_password', 'TINYINT(1) NOT NULL DEFAULT 0');
await addColumn('users', 'deleted_at', 'TIMESTAMP NULL');

await conn.query(`
  CREATE TABLE IF NOT EXISTS audit_log (
    id INT AUTO_INCREMENT PRIMARY KEY,
    actor_id INT NOT NULL,
    action VARCHAR(40) NOT NULL,
    target_user_id INT NULL,
    details TEXT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY by_target (target_user_id),
    FOREIGN KEY (actor_id) REFERENCES users(id)
  )
`);

// El administrador que ya existía pasa a ser superadministrador (solo si todavía no hay ninguno)
const [supers] = await conn.query("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1");
if (!supers.length) {
  const [r] = await conn.query("UPDATE users SET role = 'superadmin' WHERE role = 'admin' ORDER BY id LIMIT 1");
  if (r.affectedRows) console.log('El administrador existente ahora es superadministrador.');
}

// Superadmin inicial: solo si no existe ninguno y están definidas ADMIN_PHONE y ADMIN_PASSWORD (útil en Railway, sin consola)
const { ADMIN_PHONE, ADMIN_PASSWORD } = process.env;
if (ADMIN_PHONE && ADMIN_PASSWORD) {
  const [existing] = await conn.query("SELECT id FROM users WHERE role = 'superadmin' LIMIT 1");
  if (!existing.length) {
    if (ADMIN_PASSWORD.length < 8) console.warn('⚠ ADMIN_PASSWORD es muy corta: usa al menos 10 caracteres');
    await conn.query(
      `INSERT INTO users (name, phone, password_hash, role) VALUES ('Super Admin', ?, ?, 'superadmin')
       ON DUPLICATE KEY UPDATE password_hash = VALUES(password_hash), role = 'superadmin'`,
      [normalizePhone(ADMIN_PHONE) ?? ADMIN_PHONE.trim(), await bcrypt.hash(ADMIN_PASSWORD, 10)]
    );
    console.log('Superadministrador inicial creado.');
  }
}

// Fase 6: avisos por SMS de las emergencias (cuántas veces se avisó y cuándo fue la última)
await addColumn('alerts', 'notified_count', 'TINYINT NOT NULL DEFAULT 0');
await addColumn('alerts', 'last_notified_at', 'TIMESTAMP NULL');

// Fase 7: verificación en dos pasos (el secreto se guarda cifrado; los códigos de respaldo, solo como huella)
await addColumn('users', 'totp_secret', 'TEXT NULL');
await addColumn('users', 'totp_enabled', 'TINYINT(1) NOT NULL DEFAULT 0');
await addColumn('users', 'totp_last_step', 'BIGINT NULL');
await addColumn('users', 'backup_codes', 'TEXT NULL');
await addColumn('users', 'two_fa_failures', 'TINYINT NOT NULL DEFAULT 0');
await addColumn('users', 'two_fa_locked_until', 'TIMESTAMP NULL');

// Salida de emergencia: si el superadmin pierde su teléfono Y sus códigos de respaldo, define RESET_2FA_FOR=<su teléfono>
// en Railway, reinicia, entra y vuelve a activar la verificación. Después QUITA la variable.
if (process.env.RESET_2FA_FOR) {
  const ph = normalizePhone(process.env.RESET_2FA_FOR) ?? process.env.RESET_2FA_FOR.trim();
  const [r] = await conn.query(
    `UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL, backup_codes = NULL, two_fa_failures = 0,
            two_fa_locked_until = NULL, token_version = token_version + 1
     WHERE phone = ? AND role IN ('superadmin','admin','support')`, [ph]
  );
  console.warn(r.affectedRows ? `⚠ Verificación en dos pasos restablecida para ${ph}. Quita RESET_2FA_FOR.` : '⚠ RESET_2FA_FOR: no hay personal con ese teléfono');
}

// Salida de emergencia 2: poner una contraseña conocida a una cuenta del personal (por ejemplo el superadmin que la olvidó).
// Define RESET_PASSWORD_FOR=<teléfono> y RESET_PASSWORD_TO=<contraseña> en Railway, reinicia, entra. Después QUITA las dos variables.
if (process.env.RESET_PASSWORD_FOR && process.env.RESET_PASSWORD_TO) {
  const ph = normalizePhone(process.env.RESET_PASSWORD_FOR) ?? process.env.RESET_PASSWORD_FOR.trim();
  const [r] = await conn.query(
    `UPDATE users SET password_hash = ?, must_change_password = 0, two_fa_failures = 0, two_fa_locked_until = NULL, token_version = token_version + 1
     WHERE phone = ? AND role IN ('superadmin','admin','support')`, [await bcrypt.hash(process.env.RESET_PASSWORD_TO, 10), ph]
  );
  console.warn(r.affectedRows ? `⚠ Contraseña restablecida para ${ph}. Quita RESET_PASSWORD_FOR y RESET_PASSWORD_TO.` : '⚠ RESET_PASSWORD_FOR: no hay personal con ese teléfono');
}

// Fase 8A: dispositivos que reciben notificaciones push
await conn.query(`
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    endpoint VARCHAR(600) NOT NULL,
    endpoint_hash CHAR(64) NOT NULL,
    p256dh VARCHAR(200) NOT NULL,
    auth VARCHAR(100) NOT NULL,
    user_agent VARCHAR(200) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY one_endpoint (endpoint_hash),
    KEY by_user (user_id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Fase 8B: chat del viaje
await conn.query(`
  CREATE TABLE IF NOT EXISTS messages (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ride_id INT NOT NULL,
    sender_id INT NOT NULL,
    text VARCHAR(500) NOT NULL,
    read_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY by_ride (ride_id, id),
    KEY by_created (created_at),
    FOREIGN KEY (ride_id) REFERENCES rides(id),
    FOREIGN KEY (sender_id) REFERENCES users(id)
  )
`);

// Fase 8C: las ofertas de los conductores vencen
await conn.query("ALTER TABLE offers MODIFY status ENUM('pending','accepted','rejected','expired') NOT NULL DEFAULT 'pending'");
await addColumn('offers', 'expires_at', 'TIMESTAMP NULL');

// Fase 8D: lugares favoritos, contactos de confianza y reportes
await conn.query(`
  CREATE TABLE IF NOT EXISTS favorite_places (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    label VARCHAR(40) NOT NULL,
    text VARCHAR(200) NOT NULL,
    lat DOUBLE NOT NULL,
    lng DOUBLE NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY one_label (user_id, label),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);
await conn.query(`
  CREATE TABLE IF NOT EXISTS trusted_contacts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    name VARCHAR(60) NOT NULL,
    phone VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY one_phone (user_id, phone),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);
await conn.query(`
  CREATE TABLE IF NOT EXISTS reports (
    id INT AUTO_INCREMENT PRIMARY KEY,
    ride_id INT NOT NULL,
    user_id INT NOT NULL,
    type ENUM('lost_item','overcharge','behavior','safety','other') NOT NULL,
    text VARCHAR(1000) NOT NULL,
    status ENUM('open','resolved') NOT NULL DEFAULT 'open',
    resolution VARCHAR(500) NULL,
    resolved_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    resolved_at TIMESTAMP NULL,
    KEY by_status (status),
    FOREIGN KEY (ride_id) REFERENCES rides(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

// Fase 9: saldo de conductores, comisión y recargas por transferencia con comprobante
await addColumn('users', 'balance', 'DECIMAL(10,2) NOT NULL DEFAULT 0');
await conn.query(`
  CREATE TABLE IF NOT EXISTS settings (
    name VARCHAR(40) PRIMARY KEY,
    value TEXT NOT NULL,
    updated_by INT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )
`);
await conn.query(`
  CREATE TABLE IF NOT EXISTS topups (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    bank VARCHAR(60) NOT NULL,
    reference VARCHAR(60) NOT NULL,
    reference_key VARCHAR(80) NULL,
    receipt_file VARCHAR(100) NULL,
    receipt_hash CHAR(64) NULL,
    status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
    approved_amount DECIMAL(10,2) NULL,
    review_note VARCHAR(300) NULL,
    reviewed_by INT NULL,
    reviewed_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    KEY by_status (status),
    KEY by_driver (driver_id),
    FOREIGN KEY (driver_id) REFERENCES users(id)
  )
`);
// Libro de cuentas: cada movimiento del saldo queda escrito y no se edita. La comisión de un viaje y la recarga de una solicitud no pueden repetirse.
await conn.query(`
  CREATE TABLE IF NOT EXISTS wallet_entries (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    amount DECIMAL(10,2) NOT NULL,
    kind ENUM('topup','commission','bonus','adjustment') NOT NULL,
    ride_id INT NULL,
    topup_id INT NULL,
    note VARCHAR(200) NULL,
    created_by INT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY one_commission (user_id, kind, ride_id),
    UNIQUE KEY one_topup (kind, topup_id),
    KEY by_user (user_id, id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  )
`);

console.log(`Base de datos "${DB_NAME}" lista.`);
await conn.end();
