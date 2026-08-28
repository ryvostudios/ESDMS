import pool from "../../config/database.js";

// The single definition of "current": the latest record already in effect
// today. Shared with the chronological guard below so the two can never
// drift apart and start describing different rows.
const CURRENT_RECORD_SQL = `
  SELECT id, employee_id, amount, currency, effective_date, reason, created_by_user_id, created_at
  FROM employee_compensation_records
  WHERE employee_id = $1 AND effective_date <= CURRENT_DATE
  ORDER BY effective_date DESC, created_at DESC
  LIMIT 1`;

export async function getCurrent(employeeId) {
  const result = await pool.query(CURRENT_RECORD_SQL, [employeeId]);
  return result.rows[0] || null;
}

// Answers "is this effective date earlier than the current record's?"
// inside Postgres, comparing two native `date` values. node-postgres parses
// a `date` column into a JS Date at the *host's* local midnight, so any
// comparison performed in JS silently depends on the server's timezone (and
// comparing the incoming YYYY-MM-DD string against that Date coerces the
// string to NaN, making the comparison always false). Postgres has neither
// problem. Returns false when the employee has no current record — nothing
// to be earlier than.
export async function isEarlierThanCurrent(client, employeeId, effectiveDate) {
  const result = await client.query(
    `SELECT ($2::date < current_record.effective_date) AS is_earlier
     FROM (${CURRENT_RECORD_SQL}) AS current_record`,
    [employeeId, effectiveDate],
  );
  return result.rows[0]?.is_earlier === true;
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
