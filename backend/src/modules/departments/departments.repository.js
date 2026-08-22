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
