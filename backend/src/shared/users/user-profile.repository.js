import pool from "../../config/database.js";

// Single source of truth for "who is this user and what can they do" — used
// by both the authenticate middleware (on every request) and login (so the
// token response and /auth/me response are never out of sync).
export async function getUserProfileById(userId) {
  const result = await pool.query(
    `SELECT
       u.id, u.email, u.full_name, u.is_active, u.department_id, u.site_id,
       r.name AS role, r.is_active AS role_is_active,
       COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE u.id = $1
     GROUP BY u.id, r.name, r.is_active`,
    [userId],
  );

  return result.rows[0] || null;
}

// A deactivated role must immediately stop granting operational authority,
// even if the user row itself is still marked active.
export function isProfileActive(profile) {
  return Boolean(profile) && profile.is_active && profile.role_is_active;
}
