import pool from "../../config/database.js";

export async function findUserById(id) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.is_active, u.department_id, u.site_id, u.created_at,
            r.name AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE u.id = $1`,
    [id],
  );

  return result.rows[0] || null;
}

export async function findRoleByName(name) {
  const result = await pool.query("SELECT id, name, is_active FROM roles WHERE name = $1", [name]);
  return result.rows[0] || null;
}

export async function emailExists(email) {
  const result = await pool.query("SELECT 1 FROM users WHERE LOWER(email) = LOWER($1)", [email]);
  return result.rowCount > 0;
}

export async function insertUser(client, { email, fullName, passwordHash, roleId, siteId, departmentId }) {
  const result = await client.query(
    `INSERT INTO users (email, password_hash, full_name, role_id, site_id, department_id, is_active)
     VALUES ($1, $2, $3, $4, $5, $6, true)
     RETURNING id, email, full_name, site_id, department_id, is_active, created_at`,
    [email, passwordHash, fullName, roleId, siteId, departmentId],
  );

  return result.rows[0];
}

export async function updateUserRoleId(client, userId, roleId) {
  await client.query("UPDATE users SET role_id = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [roleId, userId]);
}

export async function setUserActiveState(client, userId, isActive) {
  await client.query("UPDATE users SET is_active = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2", [
    isActive,
    userId,
  ]);
}

export async function listUsersForSite(siteId) {
  const result = await pool.query(
    `SELECT u.id, u.email, u.full_name, u.is_active, u.department_id, u.site_id, u.created_at, r.name AS role
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE ($1::uuid IS NULL OR u.site_id = $1)
     ORDER BY u.created_at DESC`,
    [siteId],
  );

  return result.rows;
}

export async function findPermissionByCode(code) {
  const result = await pool.query("SELECT id, code FROM permissions WHERE code = $1", [code]);
  return result.rows[0] || null;
}

export async function listOverridesForUser(userId) {
  const result = await pool.query(
    `SELECT o.id, p.code AS permission_code, o.effect, o.reason, o.created_at,
            g.id AS granted_by_user_id, g.full_name AS granted_by_full_name
     FROM user_permission_overrides o
     JOIN permissions p ON p.id = o.permission_id
     JOIN users g ON g.id = o.granted_by_user_id
     WHERE o.user_id = $1
     ORDER BY p.code`,
    [userId],
  );

  return result.rows;
}

export async function upsertOverride(client, { userId, permissionId, effect, grantedByUserId, reason }) {
  await client.query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by_user_id, reason)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (user_id, permission_id)
     DO UPDATE SET effect = EXCLUDED.effect, granted_by_user_id = EXCLUDED.granted_by_user_id,
                   reason = EXCLUDED.reason, created_at = CURRENT_TIMESTAMP`,
    [userId, permissionId, effect, grantedByUserId, reason || null],
  );
}

export async function deleteOverride(client, userId, permissionId) {
  const result = await client.query(
    "DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission_id = $2",
    [userId, permissionId],
  );

  return result.rowCount > 0;
}
