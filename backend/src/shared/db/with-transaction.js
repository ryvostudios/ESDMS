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
    // Preserve the business/SQL failure that caused the rollback. A broken
    // connection can make ROLLBACK fail too; that secondary cleanup failure
    // must not replace the original diagnostic.
    try {
      await client.query("ROLLBACK");
    } catch {
      // The client is released below and pg discards a broken connection.
    }
    throw error;
  } finally {
    client.release();
  }
}
