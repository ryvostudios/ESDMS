import pool from "../../config/database.js";

// Positions have zero relationship to the `roles` table — a Position named
// "CEO" or "ADMIN" cannot grant application authority; it's just a label.
// See docs/DECISIONS.md.
export async function listActivePositionsForSite(siteId) {
  const result = await pool.query(
    "SELECT id, code, name, department_id, description FROM positions WHERE site_id = $1 AND is_active = true ORDER BY name",
    [siteId],
  );
  return result.rows;
}

export async function listPositionsForSite(siteId) {
  const result = await pool.query(
    "SELECT id, code, name, department_id, description, is_active, site_id FROM positions WHERE site_id = $1 ORDER BY name",
    [siteId],
  );
  return result.rows;
}

export async function findPositionById(id) {
  const result = await pool.query("SELECT id, site_id, department_id, is_active FROM positions WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function codeExistsForSite(siteId, code) {
  const result = await pool.query("SELECT 1 FROM positions WHERE site_id = $1 AND code = $2", [siteId, code]);
  return result.rowCount > 0;
}

export async function insertPosition({ siteId, code, name, departmentId, description }) {
  const result = await pool.query(
    `INSERT INTO positions (site_id, code, name, department_id, description)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, code, name, department_id, description, is_active, site_id`,
    [siteId, code, name, departmentId || null, description || null],
  );
  return result.rows[0];
}

export async function updatePositionFields(id, { name, departmentId, description, isActive }) {
  const result = await pool.query(
    `UPDATE positions
     SET name = COALESCE($2, name),
         department_id = CASE WHEN $3::boolean THEN $4 ELSE department_id END,
         description = CASE WHEN $5::boolean THEN $6 ELSE description END,
         is_active = COALESCE($7, is_active),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, code, name, department_id, description, is_active, site_id`,
    [
      id,
      name ?? null,
      departmentId !== undefined,
      departmentId ?? null,
      description !== undefined,
      description ?? null,
      isActive ?? null,
    ],
  );
  return result.rows[0] || null;
}

export async function hasActiveAssignments(positionId) {
  const result = await pool.query(
    `SELECT 1 FROM employment_assignments ea
     WHERE ea.position_id = $1
       AND ea.effective_date = (
         SELECT max(ea2.effective_date) FROM employment_assignments ea2
         WHERE ea2.employee_id = ea.employee_id AND ea2.effective_date <= CURRENT_DATE
       )
     LIMIT 1`,
    [positionId],
  );
  return result.rowCount > 0;
}
