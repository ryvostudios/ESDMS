import pg from "pg";
import config from "./env.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Verified TLS in production (not merely encrypted-but-unverified) — see
  // docs/SECURITY.md §8.1. Local dev connects to a local, non-TLS Postgres.
  ssl: config.isProduction ? { rejectUnauthorized: true } : undefined,
});

export async function checkDatabaseConnection() {
  const result = await pool.query("SELECT NOW() AS current_time");
  return result.rows[0];
}

export default pool;
