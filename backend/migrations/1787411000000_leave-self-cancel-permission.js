export const shorthands = undefined;

// "Submit leave" and "cancel own leave" are separate actions that happened
// to share leave.self.create's authorization check — a real semantic gap
// (an actor with self-create denied, or self-cancel intentionally denied
// without touching self-create, couldn't be expressed). Dedicated
// permission, following the existing "module.action" convention.
const PERMISSION_CODE = "leave.self.cancel";
const PERMISSION_DESCRIPTION = "Cancel one's own SUBMITTED leave request";

export async function up(pgm) {
  pgm.sql(
    `INSERT INTO permissions (code, description) VALUES ('${PERMISSION_CODE}', '${PERMISSION_DESCRIPTION.replace(/'/g, "''")}');`,
  );

  // Baseline role grants only — mirrors whichever role(s) currently hold
  // leave.self.create in role_permissions (the baseline table), never
  // user_permission_overrides (per-user GRANT/DENY exceptions, which must
  // NOT be blindly copied: a user explicitly denied leave.self.create for
  // an unrelated reason should not automatically inherit a leave.self.cancel
  // denial they were never given, and vice versa).
  pgm.sql(`
    INSERT INTO role_permissions (role_id, permission_id)
    SELECT rp.role_id, new_permission.id
    FROM role_permissions rp
    JOIN permissions existing ON existing.id = rp.permission_id AND existing.code = 'leave.self.create'
    JOIN permissions new_permission ON new_permission.code = '${PERMISSION_CODE}'
    ON CONFLICT DO NOTHING;
  `);
}

export async function down(pgm) {
  pgm.sql(`DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = '${PERMISSION_CODE}');`);
  pgm.sql(`DELETE FROM user_permission_overrides WHERE permission_id = (SELECT id FROM permissions WHERE code = '${PERMISSION_CODE}');`);
  pgm.sql(`DELETE FROM permissions WHERE code = '${PERMISSION_CODE}';`);
}
