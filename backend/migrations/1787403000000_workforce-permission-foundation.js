export const shorthands = undefined;

// Foundation for the Workforce module's governance model (CEO / Upper
// Management / HR / Employee — see docs/DECISIONS.md). Two independent,
// additive pieces:
//
// 1. Four new application-authority roles. Inserting the row alone grants
//    zero permissions — nothing is added to role_permissions here, so no
//    existing or new user gains any capability from this migration by
//    itself.
// 2. `user_permission_overrides`: per-user GRANT/DENY on top of role
//    permissions, so "effective permissions = role permissions + individual
//    grants - individual denials" can be computed without scattering
//    role-name checks through the codebase. Starts empty, so every existing
//    user's effective permissions are unchanged until a row is inserted.
const NEW_ROLES = ["CEO", "UPPER_MANAGEMENT", "HR", "EMPLOYEE"];

export async function up(pgm) {
  for (const role of NEW_ROLES) {
    pgm.sql(`INSERT INTO roles (name) VALUES ('${role}') ON CONFLICT (name) DO NOTHING;`);
  }

  pgm.createTable("user_permission_overrides", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "CASCADE",
    },
    permission_id: {
      type: "uuid",
      notNull: true,
      references: "permissions",
      onDelete: "CASCADE",
    },
    effect: {
      type: "varchar(5)",
      notNull: true,
    },
    // Who authorized this override — an audit fact about the override
    // itself, not a general-purpose audit log. RESTRICT: an override record
    // must not silently lose who granted it because that user was later
    // deleted (users are deactivated, never deleted, elsewhere in this
    // schema, so this should never actually block anything).
    granted_by_user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    reason: {
      type: "text",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
  });

  pgm.addConstraint("user_permission_overrides", "user_permission_overrides_effect_check", {
    check: "effect IN ('GRANT', 'DENY')",
  });

  // One override per (user, permission) — a permission is either granted or
  // denied for a given user, never both at once.
  pgm.addConstraint("user_permission_overrides", "user_permission_overrides_user_permission_key", {
    unique: ["user_id", "permission_id"],
  });

  pgm.createIndex("user_permission_overrides", "user_id");

  // Same RLS boundary every application table gets — see
  // docs/SECURITY.md §8.2. Runtime access still requires the explicit grant
  // + policy added to scripts/provision-db-roles.sql in this same change.
  pgm.sql(`ALTER TABLE public.user_permission_overrides ENABLE ROW LEVEL SECURITY;`);
}

export async function down(pgm) {
  pgm.dropTable("user_permission_overrides");
  // New roles are left in place on down, consistent with rbac-foundation's
  // own down() — other data may already reference them by the time a
  // rollback runs.
}
