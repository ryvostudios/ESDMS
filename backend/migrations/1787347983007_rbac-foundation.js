export const shorthands = undefined;

const ROLES = ["TEAM_LEAD", "ADMIN", "SITE_MANAGER", "GATE_GUARD"];

const PERMISSIONS = [
  ["gate_pass.create", "Create a Gate Pass"],
  ["gate_pass.edit_draft", "Edit a Gate Pass while it is in DRAFT"],
  ["gate_pass.submit", "Submit a Gate Pass for approval"],
  ["gate_pass.view_own", "View Gate Passes within own department/team scope"],
  ["gate_pass.view_site", "View all Gate Passes site-wide"],
  ["gate_pass.approve", "Approve a Gate Pass"],
  ["gate_pass.reject", "Reject a Gate Pass"],
  ["gate_pass.cancel", "Cancel a Gate Pass before it leaves the site"],
  ["gate_pass.verify", "Verify a Gate Pass at the gate"],
  ["gate_pass.exit", "Record vehicle exit at the gate"],
  ["gate_pass.return", "Record vehicle return at the gate"],
  ["gate_pass.view_history", "View completed Gate Pass history and audit trail"],
];

const ROLE_PERMISSIONS = {
  TEAM_LEAD: ["gate_pass.create", "gate_pass.edit_draft", "gate_pass.submit", "gate_pass.view_own"],
  ADMIN: [
    "gate_pass.create",
    "gate_pass.edit_draft",
    "gate_pass.submit",
    "gate_pass.view_site",
    "gate_pass.approve",
    "gate_pass.reject",
    "gate_pass.cancel",
    "gate_pass.view_history",
  ],
  SITE_MANAGER: [
    "gate_pass.create",
    "gate_pass.edit_draft",
    "gate_pass.submit",
    "gate_pass.view_site",
    "gate_pass.approve",
    "gate_pass.reject",
    "gate_pass.cancel",
    "gate_pass.view_history",
  ],
  GATE_GUARD: ["gate_pass.verify", "gate_pass.exit", "gate_pass.return"],
};

export async function up(pgm) {
  for (const role of ROLES) {
    pgm.sql(
      `INSERT INTO roles (name) VALUES ('${role}') ON CONFLICT (name) DO NOTHING;`,
    );
  }

  pgm.createTable("permissions", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    code: {
      type: "varchar(100)",
      notNull: true,
      unique: true,
    },
    description: {
      type: "text",
      notNull: true,
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
  });

  for (const [code, description] of PERMISSIONS) {
    pgm.sql(
      `INSERT INTO permissions (code, description) VALUES ('${code}', '${description}');`,
    );
  }

  pgm.createTable("role_permissions", {
    role_id: {
      type: "uuid",
      notNull: true,
      references: "roles",
      onDelete: "CASCADE",
    },
    permission_id: {
      type: "uuid",
      notNull: true,
      references: "permissions",
      onDelete: "CASCADE",
    },
  });

  pgm.addConstraint("role_permissions", "role_permissions_pkey", {
    primaryKey: ["role_id", "permission_id"],
  });

  for (const [role, codes] of Object.entries(ROLE_PERMISSIONS)) {
    for (const code of codes) {
      pgm.sql(`
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id
        FROM roles r, permissions p
        WHERE r.name = '${role}' AND p.code = '${code}'
        ON CONFLICT DO NOTHING;
      `);
    }
  }
}

export async function down(pgm) {
  pgm.dropTable("role_permissions");
  pgm.dropTable("permissions");
  // Roles are left in place on down — other data (users) may already
  // reference them, and role deletion is not this migration's concern.
}
