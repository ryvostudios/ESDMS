import pool from "../../config/database.js";

export async function listPolicies({ activeOnly = false } = {}) {
  const result = await pool.query(
    `SELECT id, name, work_days, off_days, is_active FROM rotation_policies
     ${activeOnly ? "WHERE is_active = true" : ""} ORDER BY name`,
  );
  return result.rows;
}

export async function findPolicyById(id) {
  const result = await pool.query("SELECT id, is_active FROM rotation_policies WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function insertPolicy({ name, workDays, offDays }, executor = pool) {
  const result = await executor.query(
    "INSERT INTO rotation_policies (name, work_days, off_days) VALUES ($1, $2, $3) RETURNING id, name, work_days, off_days, is_active",
    [name, workDays, offDays],
  );
  return result.rows[0];
}

export async function updatePolicyFields(id, { name, isActive }, executor = pool) {
  const result = await executor.query(
    `UPDATE rotation_policies SET name = COALESCE($2, name), is_active = COALESCE($3, is_active), updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 RETURNING id, name, work_days, off_days, is_active`,
    [id, name ?? null, isActive ?? null],
  );
  return result.rows[0] || null;
}

export async function policyInUse(policyId) {
  const result = await pool.query(
    `SELECT 1 FROM employment_assignments ea
     WHERE ea.rotation_policy_id = $1
       AND ea.effective_date = (
         SELECT max(ea2.effective_date) FROM employment_assignments ea2
         WHERE ea2.employee_id = ea.employee_id AND ea2.effective_date <= CURRENT_DATE
       )
     LIMIT 1`,
    [policyId],
  );
  return result.rowCount > 0;
}

export async function getCurrentPolicyForEmployee(employeeId) {
  const result = await pool.query(
    `SELECT rp.id, rp.name, rp.work_days, rp.off_days
     FROM employment_assignments ea
     JOIN rotation_policies rp ON rp.id = ea.rotation_policy_id
     WHERE ea.employee_id = $1 AND ea.effective_date <= CURRENT_DATE
     ORDER BY ea.effective_date DESC, ea.created_at DESC
     LIMIT 1`,
    [employeeId],
  );
  return result.rows[0] || null;
}

export async function getBalance(employeeId) {
  const result = await pool.query(
    "SELECT COALESCE(sum(days), 0) AS balance FROM employee_rotation_ledger WHERE employee_id = $1",
    [employeeId],
  );
  return Number(result.rows[0].balance);
}

export async function listLedger(employeeId) {
  const result = await pool.query(
    `SELECT id, entry_type, days, reason, effective_date, created_by_user_id, created_at
     FROM employee_rotation_ledger WHERE employee_id = $1 ORDER BY effective_date DESC, created_at DESC`,
    [employeeId],
  );
  return result.rows;
}

export async function insertLedgerEntry(client, { employeeId, entryType, days, reason, effectiveDate, createdByUserId }) {
  const result = await client.query(
    `INSERT INTO employee_rotation_ledger (employee_id, entry_type, days, reason, effective_date, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, entry_type, days, effective_date`,
    [employeeId, entryType, days, reason || null, effectiveDate, createdByUserId],
  );
  return result.rows[0];
}
