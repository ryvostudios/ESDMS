import pool from "../../config/database.js";

// User-facing Workforce timeline — distinct from governance_audit_log
// (protected/forensic, CEO cannot remove). CEO CAN logically remove an
// entry here; see removeEntry below. docs/DECISIONS.md.
export async function recordHistory(clientOrPool, { employeeId, eventType, summary = {}, actorUserId }) {
  await clientOrPool.query(
    `INSERT INTO employee_business_history (employee_id, event_type, summary, actor_user_id)
     VALUES ($1, $2, $3::jsonb, $4)`,
    [employeeId, eventType, JSON.stringify(summary), actorUserId],
  );
}

export async function listHistory(employeeId, { includeRemoved = false } = {}) {
  const result = await pool.query(
    `SELECT id, event_type, summary, actor_user_id, is_removed, removed_by_user_id, removed_reason, removed_at, created_at
     FROM employee_business_history
     WHERE employee_id = $1 ${includeRemoved ? "" : "AND is_removed = false"}
     ORDER BY created_at DESC`,
    [employeeId],
  );
  return result.rows;
}

export async function findHistoryEntryById(id) {
  const result = await pool.query("SELECT id, employee_id, is_removed FROM employee_business_history WHERE id = $1", [id]);
  return result.rows[0] || null;
}

// Logical removal only — the DB trigger (see
// 1787405000000_workforce-schema-foundation.js) rejects any other column
// change and rejects DELETE outright, so this is the only way this table
// is ever written to after insertion.
export async function markHistoryRemoved(client, id, { removedByUserId, removedReason }) {
  await client.query(
    `UPDATE employee_business_history
     SET is_removed = true, removed_by_user_id = $2, removed_reason = $3, removed_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, removedByUserId, removedReason || null],
  );
}
