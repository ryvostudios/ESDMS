export const shorthands = undefined;

// Governance/user-management permission codes, following the existing
// "module.action" convention (see rbac-foundation's gate_pass.* codes).
// UM authority is deliberately split from ordinary user management
// (users.create/users.update) into its own two codes so that holding
// UPPER_MANAGEMENT as a role never implies UM_CREATE/UM_MANAGE — see
// docs/DECISIONS.md.
const PERMISSIONS = [
  ["users.view", "View user accounts"],
  ["users.create", "Create a user account (not CEO, not Upper Management)"],
  ["users.update", "Change a user's role (not CEO, not to/from Upper Management)"],
  ["users.activate", "Reactivate a deactivated user account"],
  ["users.deactivate", "Deactivate a user account"],
  ["users.create_um", "Create a user account with the Upper Management role"],
  ["users.manage_um", "Change an Upper Management account's role or active state"],
  ["permission_overrides.view", "View a user's individual permission overrides"],
  ["permission_overrides.manage", "Grant, deny, or remove a user's individual permission override"],
];

// Only CEO holds these at the role level in this migration. UPPER_MANAGEMENT,
// HR, and EMPLOYEE intentionally receive none of them — "UM cannot create
// UM by default" and "HR cannot create CEO or UM" fall directly out of this
// seed data rather than needing special-cased code (see
// src/modules/users/users.authorization.js).
const CEO_PERMISSION_CODES = PERMISSIONS.map(([code]) => code);

// Append-only, same as gate_pass_audit_log — reuses the trigger function
// gate-pass-schema already created rather than redefining an identical one.
// target_user_id is nullable: a PRIVILEGE_ESCALATION_ATTEMPT logged from
// createUser (attempting to create an Upper Management account without
// authority) has no existing target user to point at.
const AUDIT_ACTIONS = [
  "USER_CREATED",
  "USER_ROLE_CHANGED",
  "USER_ACTIVATED",
  "USER_DEACTIVATED",
  "PERMISSION_GRANTED",
  "PERMISSION_DENIED",
  "PERMISSION_OVERRIDE_REMOVED",
  "PRIVILEGE_ESCALATION_ATTEMPT",
];

export async function up(pgm) {
  for (const [code, description] of PERMISSIONS) {
    pgm.sql(
      `INSERT INTO permissions (code, description) VALUES ('${code}', '${description.replace(/'/g, "''")}');`,
    );
  }

  for (const code of CEO_PERMISSION_CODES) {
    pgm.sql(`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM roles r, permissions p
      WHERE r.name = 'CEO' AND p.code = '${code}'
      ON CONFLICT DO NOTHING;
    `);
  }

  pgm.createTable("governance_audit_log", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    actor_user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    target_user_id: {
      type: "uuid",
      references: "users",
      onDelete: "RESTRICT",
    },
    action: {
      type: "varchar(50)",
      notNull: true,
    },
    metadata: {
      type: "jsonb",
      notNull: true,
      default: pgm.func("'{}'::jsonb"),
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
  });

  pgm.addConstraint("governance_audit_log", "governance_audit_log_action_check", {
    check: `action IN (${AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
  });
  pgm.createIndex("governance_audit_log", "actor_user_id");
  pgm.createIndex("governance_audit_log", "target_user_id");
  pgm.createIndex("governance_audit_log", "created_at");

  pgm.sql(`
    CREATE TRIGGER governance_audit_log_append_only
    BEFORE UPDATE OR DELETE ON governance_audit_log
    FOR EACH ROW
    EXECUTE FUNCTION forbid_update_delete();
  `);

  pgm.sql(`ALTER TABLE public.governance_audit_log ENABLE ROW LEVEL SECURITY;`);
}

export async function down(pgm) {
  pgm.dropTable("governance_audit_log");
  // Permissions/role_permissions rows are left in place on down, consistent
  // with rbac-foundation's own down() — a rollback shouldn't need to reason
  // about what by-then depends on them.
}
