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
    `INSERT INTO users (email, password_hash, full_name, role_id, site_id, department_id, is_active, must_change_password)
     VALUES ($1, $2, $3, $4, $5, $6, true, true)
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

// Locks the User row so the must_change_password eligibility check and the
// credential/session mutation that follows are atomic against a concurrent
// writer (e.g. the user completing first login, or another Governance
// actor changing role/active state, in between). Deliberately two queries,
// not one FOR UPDATE ... JOIN — see lockLinkedUserRoleAndActive in
// employees.service.js: a joined table's row isn't reliably re-resolved by
// Postgres's EvalPlanQual recheck after this lock blocks behind a
// concurrent writer of the locked row itself.
export async function lockUserById(client, id) {
  const locked = await client.query(
    "SELECT id, role_id, site_id, is_active, must_change_password FROM users WHERE id = $1 FOR UPDATE",
    [id],
  );
  const row = locked.rows[0];
  if (!row) return null;

  const role = await client.query("SELECT name FROM roles WHERE id = $1", [row.role_id]);
  return {
    id: row.id,
    role: role.rows[0]?.name || null,
    site_id: row.site_id,
    is_active: row.is_active,
    must_change_password: row.must_change_password,
  };
}

export async function replacePasswordAndBumpSession(client, userId, passwordHash) {
  await client.query(
    `UPDATE users
     SET password_hash = $2, session_version = session_version + 1, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [userId, passwordHash],
  );
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

export async function listCapabilityBundles(executor = pool) {
  const result = await executor.query(
    `SELECT b.id, b.code, b.display_name, b.description, b.is_active,
            COALESCE(array_agg(p.code ORDER BY p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permission_codes
     FROM permission_bundles b
     LEFT JOIN permission_bundle_permissions bp ON bp.bundle_id = b.id
     LEFT JOIN permissions p ON p.id = bp.permission_id
     WHERE b.is_active
     GROUP BY b.id
     ORDER BY b.display_name`,
  );
  return result.rows;
}

export async function listBundleAssignmentsForUser(userId, executor = pool) {
  const result = await executor.query(
    `SELECT b.code, b.display_name, a.assigned_at,
            a.assigned_by_user_id, u.full_name AS assigned_by_full_name
     FROM user_permission_bundle_assignments a
     JOIN permission_bundles b ON b.id = a.bundle_id
     JOIN users u ON u.id = a.assigned_by_user_id
     WHERE a.user_id = $1
     ORDER BY b.display_name`,
    [userId],
  );
  return result.rows;
}

export async function findCapabilityBundleByCode(code, executor = pool) {
  const result = await executor.query(
    "SELECT id, code, display_name, is_active FROM permission_bundles WHERE code = $1",
    [code],
  );
  return result.rows[0] || null;
}

export async function insertBundleAssignment(client, { userId, bundleId, assignedByUserId }) {
  const result = await client.query(
    `INSERT INTO user_permission_bundle_assignments (user_id, bundle_id, assigned_by_user_id)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id, bundle_id) DO NOTHING
     RETURNING user_id`,
    [userId, bundleId, assignedByUserId],
  );
  return result.rowCount > 0;
}

export async function deleteBundleAssignment(client, userId, bundleId) {
  const result = await client.query(
    "DELETE FROM user_permission_bundle_assignments WHERE user_id = $1 AND bundle_id = $2",
    [userId, bundleId],
  );
  return result.rowCount > 0;
}

export async function listRolePermissionCodes(roleId, executor = pool) {
  const result = await executor.query(
    `SELECT p.code FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = $1`,
    [roleId],
  );
  return result.rows.map((row) => row.code);
}

export async function listBundlePermissionCodes(bundleId, executor = pool) {
  const result = await executor.query(
    `SELECT p.code FROM permission_bundle_permissions bp JOIN permissions p ON p.id = bp.permission_id WHERE bp.bundle_id = $1`,
    [bundleId],
  );
  return result.rows.map((row) => row.code);
}
