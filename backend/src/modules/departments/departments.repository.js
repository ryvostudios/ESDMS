import pool from "../../config/database.js";

export async function listActiveDepartmentsForSite(siteId) {
  const result = await pool.query(
    "SELECT id, name FROM departments WHERE site_id = $1 AND is_active = true ORDER BY name",
    [siteId],
  );

  return result.rows;
}

export async function findDepartmentById(id) {
  const result = await pool.query("SELECT id, site_id, is_active FROM departments WHERE id = $1", [id]);

  return result.rows[0] || null;
}

export async function listDepartmentsForSite(siteId) {
  const result = await pool.query(
    "SELECT id, name, is_active, site_id FROM departments WHERE site_id = $1 ORDER BY name",
    [siteId],
  );

  return result.rows;
}

export async function nameExistsForSite(siteId, name) {
  const result = await pool.query("SELECT 1 FROM departments WHERE site_id = $1 AND name = $2", [siteId, name]);
  return result.rowCount > 0;
}

export async function insertDepartment(siteId, name) {
  const result = await pool.query(
    "INSERT INTO departments (site_id, name) VALUES ($1, $2) RETURNING id, name, is_active, site_id",
    [siteId, name],
  );
  return result.rows[0];
}

export async function updateDepartmentFields(id, { name, isActive }) {
  const result = await pool.query(
    `UPDATE departments
     SET name = COALESCE($2, name), is_active = COALESCE($3, is_active), updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, name, is_active, site_id`,
    [id, name ?? null, isActive ?? null],
  );
  return result.rows[0] || null;
}

// Positions/employment_assignments referencing this department both use
// RESTRICT foreign keys, so an unsafe archive would fail at the database
// layer regardless — this is a friendlier, explicit pre-check.
export async function hasActiveAssignments(departmentId) {
  const result = await pool.query(
    `SELECT 1 FROM employment_assignments ea
     WHERE ea.department_id = $1
       AND ea.effective_date = (
         SELECT max(ea2.effective_date) FROM employment_assignments ea2
         WHERE ea2.employee_id = ea.employee_id AND ea2.effective_date <= CURRENT_DATE
       )
     LIMIT 1`,
    [departmentId],
  );
  return result.rowCount > 0;
}
