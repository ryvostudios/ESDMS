import pool from "../../config/database.js";

// Global reference data — not site-scoped (see docs/DECISIONS.md).
export async function listActiveEmploymentTypes() {
  const result = await pool.query(
    "SELECT id, code, name FROM employment_types WHERE is_active = true ORDER BY name",
  );
  return result.rows;
}

export async function listEmploymentTypes() {
  const result = await pool.query(
    "SELECT id, code, name, is_active FROM employment_types ORDER BY name",
  );
  return result.rows;
}

export async function findEmploymentTypeById(id) {
  const result = await pool.query("SELECT id, is_active FROM employment_types WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function codeExists(code) {
  const result = await pool.query("SELECT 1 FROM employment_types WHERE code = $1", [code]);
  return result.rowCount > 0;
}

export async function insertEmploymentType(code, name) {
  const result = await pool.query(
    "INSERT INTO employment_types (code, name) VALUES ($1, $2) RETURNING id, code, name, is_active",
    [code, name],
  );
  return result.rows[0];
}

export async function updateEmploymentTypeFields(id, { name, isActive }) {
  const result = await pool.query(
    `UPDATE employment_types
     SET name = COALESCE($2, name), is_active = COALESCE($3, is_active), updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, code, name, is_active`,
    [id, name ?? null, isActive ?? null],
  );
  return result.rows[0] || null;
}

export async function hasActiveAssignments(employmentTypeId) {
  const result = await pool.query(
    `SELECT 1 FROM employment_assignments ea
     WHERE ea.employment_type_id = $1
       AND ea.effective_date = (
         SELECT max(ea2.effective_date) FROM employment_assignments ea2
         WHERE ea2.employee_id = ea.employee_id AND ea2.effective_date <= CURRENT_DATE
       )
     LIMIT 1`,
    [employmentTypeId],
  );
  return result.rowCount > 0;
}
