import pool from "../../config/database.js";

// Every multi-step write funnels through here so a failure partway through
// always rolls back instead of leaving the database half-updated.
export async function withTransaction(fn) {
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    const result = await fn(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
