// The serving-path SQL, kept separate from the repository's default pool so
// release verification can execute the exact query used by login and /me
// through an independently authenticated esdms_runtime connection without
// loading the rest of the application config.
//
// The query is COMPOSED from the fragments below rather than written out once
// per caller. Two callers need the same rules — the profile projection here,
// and the set-oriented recipient resolver in the repository — and the one
// thing that must never happen is those two drifting: the resolver deciding a
// user is eligible on rules the authenticated request no longer applies.
// Sharing the fragments makes that divergence impossible by construction.

// Effective permissions = role permissions + individual GRANT + capability
// bundles - individual DENY (docs/DECISIONS.md). Parameterised by the
// expression naming the permission so both the per-user aggregate and the
// single-capability test use identical logic.
export function effectivePermissionExists(permissionIdExpression) {
  return `(
    (
      EXISTS (
        SELECT 1 FROM role_permissions rp
        WHERE rp.role_id = u.role_id AND rp.permission_id = ${permissionIdExpression}
      )
      OR EXISTS (
        SELECT 1 FROM user_permission_overrides o
        WHERE o.user_id = u.id AND o.permission_id = ${permissionIdExpression} AND o.effect = 'GRANT'
      )
      OR EXISTS (
        SELECT 1
        FROM user_permission_bundle_assignments uba
        JOIN permission_bundles b ON b.id = uba.bundle_id AND b.is_active
        JOIN permission_bundle_permissions bp ON bp.bundle_id = b.id
        WHERE uba.user_id = u.id AND bp.permission_id = ${permissionIdExpression}
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM user_permission_overrides o
      WHERE o.user_id = u.id AND o.permission_id = ${permissionIdExpression} AND o.effect = 'DENY'
    )
  )`;
}

// WHERE a user may act. See the long note in user-profile.repository.js for
// why a linked Employee's current effective-dated assignment wins over
// users.department_id, and why a cross-site mismatch resolves to NULL.
export const DEPARTMENT_EXPRESSION = `
  CASE
    WHEN assignment.employee_id IS NULL THEN u.department_id
    WHEN assignment.department_id IS NULL THEN NULL
    WHEN assignment.department_site_id IS DISTINCT FROM u.site_id THEN NULL
    ELSE assignment.department_id
  END`;

export const PROFILE_SOURCE = `
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
  ) assignment ON true`;

export const USER_PROFILE_QUERY = `SELECT
  u.id, u.email, u.full_name, u.is_active, u.site_id, u.session_version,
  u.must_change_password,
  ${DEPARTMENT_EXPRESSION} AS department_id,
  r.name AS role, r.is_active AS role_is_active,
  s.is_active AS site_is_active,
  e.id AS employee_id,
  COALESCE(perm.codes, '{}') AS permissions
${PROFILE_SOURCE}
LEFT JOIN LATERAL (
  SELECT array_agg(p.code) AS codes
  FROM permissions p
  WHERE ${effectivePermissionExists("p.id")}
) perm ON true
WHERE ($1::uuid IS NULL OR u.id = $1)
ORDER BY u.id`;
