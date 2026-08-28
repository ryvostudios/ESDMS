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
//
// WHO may act (role + permissions) stays Governance-controlled. WHERE they
// may act — department scope — is resolved here, once, for every request.
//
// For a User linked to an Employee, the authoritative department is that
// Employee's CURRENT effective-dated assignment, not a second department
// column on the user row. Those two could otherwise drift, and in practice
// always did: createLoginForEmployee never populated users.department_id at
// all, so an employee-linked Team Lead with a real Civil assignment arrived
// with departmentId = null and department-scope.js correctly — but
// uselessly — refused every departmental action.
//
// Precedence is deliberate:
//   linked Employee WITH a current assignment  -> that assignment's department
//                                                 (even when it is NULL, so a
//                                                 transfer out of a department
//                                                 narrows scope rather than
//                                                 leaving a stale value)
//   otherwise                                  -> users.department_id, which
//                                                 remains the explicit scope
//                                                 for non-employee accounts
//                                                 (bootstrap, service, future
//                                                 external users)
//
// "Current" uses the same effective-dated rule as the rest of Workforce
// (departments/positions/rotation repositories): the latest assignment whose
// effective_date has actually arrived, so a future-dated transfer does not
// move scope early. Missing scope stays NULL — never a fallback to
// all-departments; department-scope.js already treats NULL as restrictive.
//
// Department scope must never become cross-site reach. department-scope.js
// is keyed on department alone and never re-checks site, so if a linked
// Employee's current assignment names a department belonging to a DIFFERENT
// site than the User's own site_id, adopting it would hand that user another
// site's records. That state is reachable in practice, because the transfer
// path deliberately declines to move a privileged account's site scope on its
// own. Such an inconsistency resolves to NULL — restrictive denial rather than
// silently trusting mismatched data, and never a silent site move.
//
// site_id is deliberately NOT derived here. Employee site changes already
// have explicit, audited synchronisation in employees.service.js, which
// intentionally refuses to move a privileged account's site scope on its own
// (see the SITE_CHANGED branch). Overriding that here would silently reverse
// a documented decision.
export async function getUserProfileById(userId) {
  const result = await pool.query(
    `SELECT
       u.id, u.email, u.full_name, u.is_active, u.site_id, u.session_version,
       u.must_change_password,
       CASE
         WHEN assignment.employee_id IS NULL THEN u.department_id
         WHEN assignment.department_id IS NULL THEN NULL
         WHEN assignment.department_site_id IS DISTINCT FROM u.site_id THEN NULL
         ELSE assignment.department_id
       END AS department_id,
       r.name AS role, r.is_active AS role_is_active,
       s.is_active AS site_is_active,
       e.id AS employee_id,
       COALESCE(perm.codes, '{}') AS permissions
     FROM users u
     JOIN roles r ON r.id = u.role_id
     JOIN sites s ON s.id = u.site_id
     LEFT JOIN employees e ON e.user_id = u.id
     LEFT JOIN LATERAL (
       SELECT ea.employee_id, ea.department_id, ad.site_id AS department_site_id
       FROM employment_assignments ea
       LEFT JOIN departments ad ON ad.id = ea.department_id
       WHERE ea.employee_id = e.id
         AND ea.effective_date <= CURRENT_DATE
       ORDER BY ea.effective_date DESC, ea.created_at DESC
       LIMIT 1
     ) assignment ON true
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
