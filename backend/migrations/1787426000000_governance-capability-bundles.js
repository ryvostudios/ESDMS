export const shorthands = undefined;

const PROCUREMENT_PERMISSIONS = [
  "demand.view",
  "procurement.site_scope",
  "procurement.pricing",
  "procurement.view_prices",
  "procurement.purchase",
  "ipo.view",
  "dc.view",
  "dc.manage",
];

export async function up(pgm) {
  pgm.sql(`
    INSERT INTO permissions (code, description)
    VALUES ('procurement.site_scope', 'Operate Procurement workflows across departments at the assigned site; never across sites')
    ON CONFLICT (code) DO NOTHING;
  `);

  pgm.createTable("permission_bundles", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    code: { type: "varchar(60)", notNull: true, unique: true },
    display_name: { type: "varchar(100)", notNull: true },
    description: { type: "text", notNull: true },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.createTable("permission_bundle_permissions", {
    bundle_id: { type: "uuid", notNull: true, references: "permission_bundles", onDelete: "CASCADE" },
    permission_id: { type: "uuid", notNull: true, references: "permissions", onDelete: "RESTRICT" },
  });
  pgm.addConstraint("permission_bundle_permissions", "permission_bundle_permissions_pkey", {
    primaryKey: ["bundle_id", "permission_id"],
  });
  pgm.createIndex("permission_bundle_permissions", "permission_id");

  pgm.createTable("user_permission_bundle_assignments", {
    user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    bundle_id: { type: "uuid", notNull: true, references: "permission_bundles", onDelete: "RESTRICT" },
    assigned_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    assigned_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("user_permission_bundle_assignments", "user_permission_bundle_assignments_pkey", {
    primaryKey: ["user_id", "bundle_id"],
  });
  pgm.createIndex("user_permission_bundle_assignments", "bundle_id");
  pgm.createIndex("user_permission_bundle_assignments", "assigned_by_user_id");

  pgm.sql(`
    INSERT INTO permission_bundles (code, display_name, description)
    VALUES
      ('PROCUREMENT_STAFF', 'Procurement Staff', 'Site-bound Procurement operations and price access; excludes Demand approval and IPO cancellation.'),
      ('FORMAL_APPROVER', 'Formal / Financial Approver', 'Formal Demand approval authority, kept separate from Procurement operations.');

    INSERT INTO permission_bundle_permissions (bundle_id, permission_id)
    SELECT b.id, p.id
    FROM permission_bundles b
    JOIN permissions p ON p.code = ANY(ARRAY[${PROCUREMENT_PERMISSIONS.map((code) => `'${code}'`).join(", ")}])
    WHERE b.code = 'PROCUREMENT_STAFF';

    INSERT INTO permission_bundle_permissions (bundle_id, permission_id)
    SELECT b.id, p.id
    FROM permission_bundles b
    JOIN permissions p ON p.code = 'demand.approve'
    WHERE b.code = 'FORMAL_APPROVER';
  `);

  pgm.dropConstraint("governance_audit_log", "governance_audit_log_action_check");
  pgm.addConstraint("governance_audit_log", "governance_audit_log_action_check", {
    check: `action IN (
      'USER_CREATED', 'USER_ROLE_CHANGED', 'USER_ACTIVATED', 'USER_DEACTIVATED',
      'PERMISSION_GRANTED', 'PERMISSION_DENIED', 'PERMISSION_OVERRIDE_REMOVED',
      'PRIVILEGE_ESCALATION_ATTEMPT', 'EMPLOYEE_CREATED', 'EMPLOYEE_TRANSFERRED',
      'COMPENSATION_RECORDED', 'CONTRACT_FINALIZED', 'CONTRACT_AMENDED',
      'CONTRACT_VIEWED', 'CONTRACT_DOWNLOADED', 'HISTORY_REMOVED',
      'WORKFORCE_EXPORT_GENERATED', 'WORKFORCE_BULK_EXPORT_GENERATED',
      'WORKFORCE_BULK_IMPORT_COMPLETED', 'EMPLOYEE_EXISTING_USER_LINKED',
      'USER_TEMP_PASSWORD_REGENERATED', 'PROCUREMENT_EXPORT_GENERATED',
      'DEMAND_DRAFT_DELETED', 'CAPABILITY_BUNDLE_ASSIGNED', 'CAPABILITY_BUNDLE_REMOVED'
    )`,
  });

  for (const table of ["permission_bundles", "permission_bundle_permissions", "user_permission_bundle_assignments"]) {
    pgm.sql(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
  }
}

export async function down(pgm) {
  pgm.dropTable("user_permission_bundle_assignments");
  pgm.dropTable("permission_bundle_permissions");
  pgm.dropTable("permission_bundles");
}
