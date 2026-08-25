export const shorthands = undefined;

// Checkpoint 2 of the Procurement & Material Receiving V1 build (see
// docs/PROCUREMENT_RECEIVING_SPEC.md §7-§9, §30). Adds the Department
// Demand List foundation: draft creation from the department's own
// Material Catalog (Checkpoint 1), submission into the workflow. Only the
// `submit` transition exists — no approval/reject/reopen action, no
// pricing, no IPO, no Delivery Challan, no Receiving, no stock.
//
// Historical-reference strategy (see docs/DECISIONS.md): a Demand line
// stores a SNAPSHOT of the item name and UOM at creation time
// (item_name_snapshot, uom_code_snapshot, uom_name_snapshot) alongside a
// live FK (catalog_entry_id) to the Department Material Catalog entry.
// Display always prefers the snapshot — a later item rename or catalog
// archive must never change what an old Demand appears to have asked for.
// Only name + UOM are snapshotted (the two fields a Demand line actually
// shows); nothing else is duplicated.
//
// Reused patterns instead of new mechanisms:
//   - demand numbering mirrors gate_pass_number_counters exactly
//     (year-keyed sequential counter, format PREFIX-YYYY-NNNNNN).
//   - the audit table mirrors gate_pass_audit_log exactly (append-only via
//     the existing forbid_update_delete() trigger, one row per
//     create/edit/submit, not per-line).
//   - line-to-catalog-entry ownership is pinned by composite FK, the same
//     "child row must belong to the exact parent it claims" trick
//     db-relational-coherence.js already established for gate_pass_files.
//   - department scoping reuses the newly-extracted
//     shared/authorization/department-scope.js helper (see
//     docs/DECISIONS.md) rather than a third bespoke implementation.
//   - notification uses the existing notification_outbox — no schema
//     change needed there.

const MATERIAL_DEMAND_STATUSES = ["DRAFT", "PENDING_INITIAL_REVIEW"];
const AUDIT_ACTIONS = ["CREATE", "EDIT_DRAFT", "SUBMIT"];

const PERMISSIONS = [
  ["demand.view", "View a department's Material Demand Lists"],
  ["demand.create", "Create a Material Demand List for a department"],
  ["demand.edit", "Edit a Material Demand List while it is in DRAFT"],
  ["demand.submit", "Submit a Material Demand List into the review workflow"],
  ["demand.all_departments", "View and manage Material Demand Lists across all departments"],
];

// Same conservative UPPER_MANAGEMENT treatment corrected into the Material
// Catalog migration: view only, no create/edit/submit, no all_departments
// by default. ADMIN/SITE_MANAGER/TEAM_LEAD get create/edit/submit scoped
// to their own department only — none get all_departments by default,
// matching "ADMIN must not become a universal cross-department demand
// creator merely because the role is ADMIN". EMPLOYEE gets view only, per
// explicit instruction that Demand creation is not automatic for every
// employee. GATE_GUARD gets nothing.
const ROLE_PERMISSIONS = {
  CEO: ["demand.view", "demand.create", "demand.edit", "demand.submit", "demand.all_departments"],
  ADMIN: ["demand.view", "demand.create", "demand.edit", "demand.submit"],
  SITE_MANAGER: ["demand.view", "demand.create", "demand.edit", "demand.submit"],
  TEAM_LEAD: ["demand.view", "demand.create", "demand.edit", "demand.submit"],
  UPPER_MANAGEMENT: ["demand.view"],
  EMPLOYEE: ["demand.view"],
};

export async function up(pgm) {
  // Needed for the material_demand_lines -> department_material_catalog
  // ownership composite FK below (mirrors departments_id_site_id_key /
  // gate_pass_files_id_gate_pass_id_key from db-relational-coherence.js).
  pgm.addConstraint("department_material_catalog", "department_material_catalog_id_department_id_key", {
    unique: ["id", "department_id"],
  });

  pgm.createTable("material_demand_number_counters", {
    year: { type: "integer", primaryKey: true },
    last_value: { type: "integer", notNull: true, default: 0 },
  });

  pgm.createTable("material_demands", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    demand_number: { type: "varchar(20)", notNull: true, unique: true },
    site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "RESTRICT" },
    department_id: { type: "uuid", notNull: true, references: "departments", onDelete: "RESTRICT" },
    status: { type: "varchar(30)", notNull: true, default: "DRAFT" },
    revision: { type: "integer", notNull: true, default: 1 },
    note: { type: "text" },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    submitted_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("material_demands", "material_demands_status_check", {
    check: `status IN (${MATERIAL_DEMAND_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });
  pgm.addConstraint("material_demands", "material_demands_revision_check", {
    check: "revision > 0",
  });
  // A Demand's department must belong to the Demand's own site — same
  // invariant gate_passes_department_site_fkey already enforces.
  pgm.addConstraint("material_demands", "material_demands_department_site_fkey", {
    foreignKeys: { columns: ["department_id", "site_id"], references: "departments(id, site_id)" },
  });
  pgm.createIndex("material_demands", "status");
  pgm.createIndex("material_demands", "department_id");
  pgm.createIndex("material_demands", "site_id");
  pgm.createIndex("material_demands", "created_at");

  pgm.sql(`
    CREATE TRIGGER material_demands_set_updated_at
    BEFORE UPDATE ON material_demands
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  `);

  // Operational/audit record: no ordinary application path deletes one.
  pgm.sql(`
    CREATE TRIGGER material_demands_forbid_delete
    BEFORE DELETE ON material_demands
    FOR EACH ROW
    EXECUTE FUNCTION forbid_delete();
  `);

  pgm.createTable("material_demand_lines", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    demand_id: { type: "uuid", notNull: true, references: "material_demands", onDelete: "CASCADE" },
    line_no: { type: "integer", notNull: true },
    // Denormalized from the parent Demand purely to support the ownership
    // composite FK below (a line's catalog entry must belong to the exact
    // same department as its parent Demand) — never read independently of
    // demand_id in application code.
    department_id: { type: "uuid", notNull: true, references: "departments", onDelete: "RESTRICT" },
    catalog_entry_id: { type: "uuid", notNull: true, references: "department_material_catalog", onDelete: "RESTRICT" },
    item_name_snapshot: { type: "varchar(150)", notNull: true },
    uom_code_snapshot: { type: "varchar(20)", notNull: true },
    uom_name_snapshot: { type: "varchar(100)", notNull: true },
    requested_quantity: { type: "numeric(12,2)", notNull: true },
    note: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("material_demand_lines", "material_demand_lines_quantity_check", {
    check: "requested_quantity > 0",
  });
  pgm.addConstraint("material_demand_lines", "material_demand_lines_demand_line_no_key", {
    unique: ["demand_id", "line_no"],
  });
  // Prevents the same catalog material appearing twice on one Demand —
  // DB-level guarantee behind the service-layer check.
  pgm.addConstraint("material_demand_lines", "material_demand_lines_demand_catalog_entry_key", {
    unique: ["demand_id", "catalog_entry_id"],
  });
  pgm.addConstraint("material_demand_lines", "material_demand_lines_catalog_department_fkey", {
    foreignKeys: {
      columns: ["catalog_entry_id", "department_id"],
      references: "department_material_catalog(id, department_id)",
    },
  });
  pgm.createIndex("material_demand_lines", "demand_id");

  // Lines are rewritable while the parent Demand is DRAFT (add/remove rows
  // under the service's row-locked transaction) — no unconditional
  // append-only trigger here, matching gate_pass_items' own reasoning.
  // material_demands itself forbids DELETE, so lines can never be
  // orphaned by losing their parent.

  pgm.createTable("material_demand_audit_log", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    demand_id: { type: "uuid", notNull: true, references: "material_demands", onDelete: "CASCADE" },
    actor_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    action: { type: "varchar(20)", notNull: true },
    previous_status: { type: "varchar(30)" },
    new_status: { type: "varchar(30)" },
    metadata: { type: "jsonb" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("material_demand_audit_log", "material_demand_audit_log_action_check", {
    check: `action IN (${AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
  });
  pgm.createIndex("material_demand_audit_log", "demand_id");
  pgm.createIndex("material_demand_audit_log", "created_at");

  pgm.sql(`
    CREATE TRIGGER material_demand_audit_log_append_only
    BEFORE UPDATE OR DELETE ON material_demand_audit_log
    FOR EACH ROW
    EXECUTE FUNCTION forbid_update_delete();
  `);

  for (const [code, description] of PERMISSIONS) {
    pgm.sql(`INSERT INTO permissions (code, description) VALUES ('${code}', '${description.replace(/'/g, "''")}');`);
  }

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

  const NEW_TABLES = [
    "material_demand_number_counters",
    "material_demands",
    "material_demand_lines",
    "material_demand_audit_log",
  ];
  for (const table of NEW_TABLES) {
    pgm.sql(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
  }
}

export async function down(pgm) {
  pgm.sql(`DELETE FROM user_permission_overrides WHERE permission_id IN (SELECT id FROM permissions WHERE code LIKE 'demand.%');`);
  pgm.sql(`DELETE FROM permissions WHERE code LIKE 'demand.%';`);

  pgm.dropTable("material_demand_audit_log");
  pgm.dropTable("material_demand_lines");
  pgm.dropTable("material_demands");
  pgm.dropTable("material_demand_number_counters");
  pgm.dropConstraint("department_material_catalog", "department_material_catalog_id_department_id_key");
}
