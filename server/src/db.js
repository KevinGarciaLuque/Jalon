import 'dotenv/config';
import mysql from 'mysql2/promise';

// Railway entrega MYSQL_URL (mysql://usuario:clave@host:puerto/base). En local se usan las variables DB_*.
const url = process.env.MYSQL_URL || process.env.DATABASE_URL;
const parsed = url ? new URL(url) : null;

export const dbConfig = parsed
  ? {
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    }
  : {
      host: process.env.DB_HOST || 'localhost',
      port: Number(process.env.DB_PORT || 3306),
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
    };

export const DB_NAME = parsed ? parsed.pathname.slice(1) : process.env.DB_NAME || 'jalon';

export const pool = mysql.createPool({
  ...dbConfig,
  database: DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  decimalNumbers: true,
});
