import pg from "pg";
import config from "./env.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.databaseUrl,
});

export async function checkDatabaseConnection() {
  const result = await pool.query("SELECT NOW() AS current_time");
  return result.rows[0];
}

export default pool;
