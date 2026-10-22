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

// Para buscar viajes por estado (solicitudes abiertas, viajes activos del panel, vencimientos) sin recorrer toda la tabla
const [statusIdx] = await conn.query(
  "SELECT 1 FROM information_schema.statistics WHERE table_schema = ? AND table_name = 'rides' AND index_name = 'idx_status_created'",
  [DB_NAME]
);
if (!statusIdx.length) await conn.query('CREATE INDEX idx_status_created ON rides (status, created_at)');

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

// ---- Etapa 4: categorías de servicio y vehículos ----
// Cada viaje es de una categoría (moto, carro o carro amplio). Los viajes anteriores quedan como carro.
await addColumn('rides', 'category', "ENUM('moto','car','xl') NOT NULL DEFAULT 'car'");
// El vehículo como dato propio. driver_id NULL = carro de la flota de Ktracho GO (para el alquiler).
// users.vehicle y users.plate se siguen llenando con el texto que muestran las pantallas.
await conn.query(`
  CREATE TABLE IF NOT EXISTS vehicles (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NULL,
    category ENUM('moto','car','xl') NOT NULL DEFAULT 'car',
    make VARCHAR(40) NULL,
    model VARCHAR(100) NULL,
    color VARCHAR(30) NULL,
    year SMALLINT NULL,
    plate VARCHAR(20) NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uniq_plate (plate),
    UNIQUE KEY one_per_driver (driver_id),
    FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);
// Los conductores que ya existían reciben su vehículo como "carro", con su texto actual como modelo.
// La placa se guarda sin espacios ni guiones y en mayúsculas (así "HAA 1234" y "haa-1234" son la misma).
// Si dos conductores tienen la misma placa, el segundo queda sin vehículo y se avisa para corregirlo en el panel.
{
  const [pending] = await conn.query(
    `SELECT u.id, u.vehicle, u.plate FROM users u LEFT JOIN vehicles v ON v.driver_id = u.id
     WHERE u.role = 'driver' AND u.deleted_at IS NULL AND u.plate IS NOT NULL AND v.id IS NULL`
  );
  let copied = 0;
  for (const u of pending) {
    const plate = String(u.plate).toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 20);
    if (!plate) continue;
    try {
      await conn.query('INSERT INTO vehicles (driver_id, category, model, plate) VALUES (?, ?, ?, ?)', [u.id, 'car', (u.vehicle || '').slice(0, 100) || null, plate]);
      copied++;
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
      console.warn(`⚠ El conductor #${u.id} tiene la placa ${plate}, que ya usa otro conductor: no se le copió el vehículo. Corrígelo en el panel.`);
    }
  }
  if (copied) console.log(`Se copiaron ${copied} vehículo(s) de conductores existentes.`);
}

// ---- Etapa 4B: alquiler de carros por días ----
// Qué carros se alquilan y a qué precio por día. El carro puede ser de un conductor (lo maneja él) o de la flota de Ktracho GO (vehicles.driver_id NULL).
// self_drive y deposit quedan listos para el alquiler sin conductor.
await conn.query(`
  CREATE TABLE IF NOT EXISTS rental_listings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    vehicle_id INT NOT NULL,
    with_driver TINYINT(1) NOT NULL DEFAULT 1,
    self_drive TINYINT(1) NOT NULL DEFAULT 0,
    price_with_driver DECIMAL(10,2) NULL,
    price_self_drive DECIMAL(10,2) NULL,
    deposit DECIMAL(10,2) NULL,
    active TINYINT(1) NOT NULL DEFAULT 1,
    notes VARCHAR(300) NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY one_per_vehicle (vehicle_id),
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id) ON DELETE CASCADE
  )
`);
// Cada reserva: fechas (inclusive), precio, cómo paga (efectivo o transferencia con comprobante) y en qué va
await conn.query(`
  CREATE TABLE IF NOT EXISTS rental_bookings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    listing_id INT NOT NULL,
    vehicle_id INT NOT NULL,
    renter_id INT NOT NULL,
    owner_driver_id INT NULL,
    mode ENUM('with_driver','self_drive') NOT NULL DEFAULT 'with_driver',
    start_date DATE NOT NULL,
    end_date DATE NOT NULL,
    days INT NOT NULL,
    price_day DECIMAL(10,2) NOT NULL,
    total DECIMAL(10,2) NOT NULL,
    deposit DECIMAL(10,2) NULL,
    payment ENUM('cash','transfer') NOT NULL,
    status ENUM('requested','confirmed','active','completed','cancelled','rejected') NOT NULL DEFAULT 'requested',
    pickup_text VARCHAR(200) NULL,
    note VARCHAR(300) NULL,
    assigned_driver VARCHAR(120) NULL,
    payment_status ENUM('none','pending','approved','rejected') NOT NULL DEFAULT 'none',
    bank VARCHAR(60) NULL,
    reference VARCHAR(60) NULL,
    reference_key VARCHAR(140) NULL,
    receipt_file VARCHAR(100) NULL,
    receipt_hash CHAR(64) NULL,
    payment_note VARCHAR(300) NULL,
    payment_reviewed_by INT NULL,
    payment_reviewed_at TIMESTAMP NULL,
    decided_by INT NULL,
    decided_at TIMESTAMP NULL,
    decline_note VARCHAR(300) NULL,
    cancelled_by ENUM('renter','owner','admin','system') NULL,
    started_at TIMESTAMP NULL,
    ended_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY by_vehicle_dates (vehicle_id, start_date, end_date),
    KEY by_renter (renter_id, id),
    KEY by_owner (owner_driver_id, id),
    KEY by_status (status),
    FOREIGN KEY (listing_id) REFERENCES rental_listings(id),
    FOREIGN KEY (vehicle_id) REFERENCES vehicles(id),
    FOREIGN KEY (renter_id) REFERENCES users(id)
  )
`);
// En el libro de cuentas: la comisión de un alquiler cobrado en efectivo, y lo que se le acredita al conductor por uno pagado por transferencia.
// Nunca dos veces por el mismo alquiler.
await conn.query("ALTER TABLE wallet_entries MODIFY kind ENUM('topup','commission','bonus','adjustment','rental_commission','rental_payout') NOT NULL");
await addColumn('wallet_entries', 'rental_id', 'INT NULL');
{
  const [ix] = await conn.query("SELECT 1 FROM information_schema.statistics WHERE table_schema = ? AND table_name = 'wallet_entries' AND index_name = 'one_rental'", [DB_NAME]);
  if (!ix.length) await conn.query('ALTER TABLE wallet_entries ADD UNIQUE KEY one_rental (kind, rental_id)');
}

// ---- Permisos por persona ----
// Lo que ve cada rol se guarda en Ajustes (role_perms); aquí, las excepciones de una persona: allow 1 = se lo da, 0 = se lo quita.
await conn.query(`
  CREATE TABLE IF NOT EXISTS user_permissions (
    user_id INT NOT NULL,
    perm VARCHAR(40) NOT NULL,
    allow TINYINT(1) NOT NULL,
    updated_by INT NULL,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, perm),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);
// Los administradores que ya tenían el mapa en vivo (users.can_monitor) lo conservan como excepción
await conn.query("INSERT IGNORE INTO user_permissions (user_id, perm, allow) SELECT id, 'monitor', 1 FROM users WHERE role = 'admin' AND can_monitor = 1");

// ---- Etapa 5: ganancias, horas conectado y recorrido real ----
// Cuándo empezó y terminó cada viaje. Los completados de antes toman como fin su última actualización (aproximado).
await addColumn('rides', 'started_at', 'TIMESTAMP NULL');
await addColumn('rides', 'completed_at', 'TIMESTAMP NULL');
await conn.query("UPDATE rides SET completed_at = updated_at WHERE status = 'completed' AND completed_at IS NULL");
{
  const [ix] = await conn.query("SELECT 1 FROM information_schema.statistics WHERE table_schema = ? AND table_name = 'rides' AND index_name = 'idx_driver_completed'", [DB_NAME]);
  if (!ix.length) await conn.query('CREATE INDEX idx_driver_completed ON rides (driver_id, completed_at)');
}
// Cada vez que un conductor está conectado con la app abierta: de cuándo a cuándo (para sus horas y su ganancia por hora)
await conn.query(`
  CREATE TABLE IF NOT EXISTS driver_sessions (
    id INT AUTO_INCREMENT PRIMARY KEY,
    driver_id INT NOT NULL,
    started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    last_seen_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    ended_at TIMESTAMP NULL,
    KEY by_driver (driver_id, started_at),
    KEY open_sessions (ended_at),
    FOREIGN KEY (driver_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);
// Camino real del carro mientras el viaje está en curso (un punto cada ~15 s). Se borran a los 90 días (RIDE_TRACK_RETENTION_DAYS).
await conn.query(`
  CREATE TABLE IF NOT EXISTS ride_points (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    ride_id INT NOT NULL,
    lat DOUBLE NOT NULL,
    lng DOUBLE NOT NULL,
    at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY by_ride (ride_id, id),
    KEY by_time (at),
    FOREIGN KEY (ride_id) REFERENCES rides(id) ON DELETE CASCADE
  )
`);

// ---- Etapa 6: índices para los indicadores y reportes por fecha (solo agregan; no cambian datos) ----
for (const [table, name, cols] of [
  ['rides', 'idx_created', 'created_at'],
  ['users', 'idx_role_created', 'role, created_at'],
  ['wallet_entries', 'idx_kind_created', 'kind, created_at'],
  ['topups', 'idx_reviewed', 'status, reviewed_at'],
  ['rental_bookings', 'idx_ended', 'status, ended_at'],
]) {
  const [ix] = await conn.query('SELECT 1 FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND index_name = ?', [DB_NAME, table, name]);
  if (!ix.length) await conn.query(`CREATE INDEX ${name} ON ${table} (${cols})`);
}

// ---- Campanita: las notificaciones de cada persona (se borran a los 30 días; las de una cuenta eliminada, al eliminarla) ----
await conn.query(`
  CREATE TABLE IF NOT EXISTS notifications (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_id INT NOT NULL,
    kind VARCHAR(30) NOT NULL,
    title VARCHAR(120) NOT NULL,
    body VARCHAR(300) NULL,
    tag VARCHAR(80) NULL,
    target VARCHAR(40) NULL,
    count INT NOT NULL DEFAULT 1,
    read_at TIMESTAMP NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    KEY by_user (user_id, updated_at),
    KEY unread (user_id, read_at),
    KEY by_tag (user_id, tag),
    KEY by_time (updated_at),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  )
`);

console.log(`Base de datos "${DB_NAME}" lista.`);
await conn.end();
