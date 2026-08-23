import pool from "../../config/database.js";

// Single source of truth for "who is this user and what can they do" — used
// by both the authenticate middleware (on every request) and login (so the
// token response and /auth/me response are never out of sync).
//
// Effective permissions = role permissions + individual grants - individual
// denials (docs/DECISIONS.md). A LATERAL subquery per user keeps this a
// single-row result without a GROUP BY across three joined tables; it's
// provably identical to the old role-only query when
// user_permission_overrides is empty, which it is for every user until the
// Workforce governance UI/API starts writing rows into it.
export async function getUserProfileById(userId) {
  const result = await pool.query(
    `SELECT
       u.id, u.email, u.full_name, u.is_active, u.department_id, u.site_id, u.session_version,
       u.must_change_password,
       r.name AS role, r.is_active AS role_is_active,
       s.is_active AS site_is_active,
       e.id AS employee_id,
       COALESCE(perm.codes, '{}') AS permissions
     FROM users u
     JOIN roles r ON r.id = u.role_id
     JOIN sites s ON s.id = u.site_id
     LEFT JOIN employees e ON e.user_id = u.id
     LEFT JOIN LATERAL (
       SELECT array_agg(p.code) AS codes
       FROM permissions p
       WHERE (
         EXISTS (
           SELECT 1 FROM role_permissions rp
           WHERE rp.role_id = u.role_id AND rp.permission_id = p.id
         )
         OR EXISTS (
           SELECT 1 FROM user_permission_overrides o
           WHERE o.user_id = u.id AND o.permission_id = p.id AND o.effect = 'GRANT'
         )
       )
       AND NOT EXISTS (
         SELECT 1 FROM user_permission_overrides o
         WHERE o.user_id = u.id AND o.permission_id = p.id AND o.effect = 'DENY'
       )
     ) perm ON true
     WHERE u.id = $1`,
    [userId],
  );

  return result.rows[0] || null;
}

// A deactivated role or site must immediately stop granting operational
// authority, even if the user row itself is still marked active — the
// account can be individually fine while its role has been retired or its
// whole site taken offline.
export function isProfileActive(profile) {
  return Boolean(profile) && profile.is_active && profile.role_is_active && profile.site_is_active;
}

// Logout's actual revocation step (see auth.controller.js): every
// previously issued JWT for this user carries the session_version it was
// issued under, checked on every authenticated request — bumping it here
// makes all of them, including one an attacker captured earlier, fail
// their next use. Coarser than per-device sessions (this ends every
// session for the user, not just the current one), an accepted trade-off
// for the simpler mechanism — see docs/DECISIONS.md.
export async function bumpSessionVersion(userId) {
  await pool.query("UPDATE users SET session_version = session_version + 1 WHERE id = $1", [userId]);
}
