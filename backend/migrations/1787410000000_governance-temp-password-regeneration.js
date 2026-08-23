export const shorthands = undefined;

// Dedicated permission for the narrow Governance recovery operation: a
// must_change_password=true account's temporary credential was lost before
// first login. Deliberately its own permission, not a reuse of
// users.update/users.activate/etc — those cover different, unrelated
// mutations and would make the effective-permission model harder to reason
// about ("granting role-change authority also silently grants credential
// regeneration" would be a surprising side effect). Follows the existing
// "module.action" convention (see governance-foundation.js).
const PERMISSION_CODE = "users.regenerate_temp_password";
const PERMISSION_DESCRIPTION =
  "Regenerate a lost temporary password for a must_change_password=true account (not a general password reset)";

// Only CEO holds this at the role level by default — same posture as every
// other governance-mutation permission in this migration's predecessor
// (users.create/users.activate/etc). Delegable later via an individual
// permission override, same as the rest.
const CEO_ONLY = true;

const EXISTING_ACTIONS = [
  "USER_CREATED", "USER_ROLE_CHANGED", "USER_ACTIVATED", "USER_DEACTIVATED",
  "PERMISSION_GRANTED", "PERMISSION_DENIED", "PERMISSION_OVERRIDE_REMOVED",
  "PRIVILEGE_ESCALATION_ATTEMPT", "EMPLOYEE_CREATED", "EMPLOYEE_TRANSFERRED",
  "COMPENSATION_RECORDED", "CONTRACT_FINALIZED", "CONTRACT_AMENDED",
  "CONTRACT_VIEWED", "CONTRACT_DOWNLOADED", "HISTORY_REMOVED",
  "WORKFORCE_EXPORT_GENERATED", "WORKFORCE_BULK_EXPORT_GENERATED",
  "WORKFORCE_BULK_IMPORT_COMPLETED", "EMPLOYEE_EXISTING_USER_LINKED",
];
const NEW_ACTIONS = ["USER_TEMP_PASSWORD_REGENERATED"];

export async function up(pgm) {
  pgm.sql(
    `INSERT INTO permissions (code, description) VALUES ('${PERMISSION_CODE}', '${PERMISSION_DESCRIPTION.replace(/'/g, "''")}');`,
  );

  if (CEO_ONLY) {
    pgm.sql(`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM roles r, permissions p
      WHERE r.name = 'CEO' AND p.code = '${PERMISSION_CODE}'
      ON CONFLICT DO NOTHING;
    `);
  }

  pgm.dropConstraint("governance_audit_log", "governance_audit_log_action_check");
  pgm.addConstraint("governance_audit_log", "governance_audit_log_action_check", {
    check: `action IN (${[...EXISTING_ACTIONS, ...NEW_ACTIONS].map((a) => `'${a}'`).join(", ")})`,
  });
}

export async function down(pgm) {
  // Retain the action in the historical allowlist — append-only audit rows
  // referencing it must remain valid even after a code rollback.
  pgm.dropConstraint("governance_audit_log", "governance_audit_log_action_check");
  pgm.addConstraint("governance_audit_log", "governance_audit_log_action_check", {
    check: `action IN (${[...EXISTING_ACTIONS, ...NEW_ACTIONS].map((a) => `'${a}'`).join(", ")})`,
  });

  pgm.sql(`DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = '${PERMISSION_CODE}');`);
  pgm.sql(`DELETE FROM permissions WHERE code = '${PERMISSION_CODE}';`);
}
