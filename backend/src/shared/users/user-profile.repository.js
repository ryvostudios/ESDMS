import pool from "../../config/database.js";

// Single source of truth for "who is this user and what can they do" — used
// by both the authenticate middleware (on every request) and login (so the
// token response and /auth/me response are never out of sync).
export async function getUserProfileById(userId) {
  const result = await pool.query(
    `SELECT
       u.id, u.email, u.full_name, u.is_active, u.department_id, u.site_id, u.session_version,
       r.name AS role, r.is_active AS role_is_active,
       s.is_active AS site_is_active,
       COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
     FROM users u
     JOIN roles r ON r.id = u.role_id
     JOIN sites s ON s.id = u.site_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE u.id = $1
     GROUP BY u.id, r.name, r.is_active, s.is_active`,
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
