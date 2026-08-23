import pool from "../../config/database.js";

export async function getCurrent(employeeId) {
  const result = await pool.query(
    `SELECT id, employee_id, amount, currency, effective_date, reason, created_by_user_id, created_at
     FROM employee_compensation_records
     WHERE employee_id = $1 AND effective_date <= CURRENT_DATE
     ORDER BY effective_date DESC, created_at DESC
     LIMIT 1`,
    [employeeId],
  );
  return result.rows[0] || null;
}

export async function listHistory(employeeId) {
  const result = await pool.query(
    `SELECT id, employee_id, amount, currency, effective_date, reason, created_by_user_id, created_at
     FROM employee_compensation_records
     WHERE employee_id = $1
     ORDER BY effective_date DESC, created_at DESC`,
    [employeeId],
  );
  return result.rows;
}

// No update/delete function exists for this table by design — the only
// way to change compensation is to insert a new effective-dated record.
// See docs/DECISIONS.md for why this is service-layer-enforced rather than
// DB-trigger-immutable like employee_contracts.
export async function insertRecord(client, { employeeId, amount, currency, effectiveDate, reason, createdByUserId }) {
  const result = await client.query(
    `INSERT INTO employee_compensation_records (employee_id, amount, currency, effective_date, reason, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, employee_id, amount, currency, effective_date, reason, created_at`,
    [employeeId, amount, currency, effectiveDate, reason || null, createdByUserId],
  );
  return result.rows[0];
}
