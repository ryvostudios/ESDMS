import pool from "../../config/database.js";

// Single source of truth for "who is this user and what can they do" — used
// by both the authenticate middleware (on every request) and login (so the
// token response and /auth/me response are never out of sync).
export async function getUserProfileById(userId) {
  const result = await pool.query(
    `SELECT
       u.id, u.email, u.full_name, u.is_active, u.department_id,
       r.name AS role,
       COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE u.id = $1
     GROUP BY u.id, r.name`,
    [userId],
  );

  return result.rows[0] || null;
}
