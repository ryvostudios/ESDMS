export const shorthands = undefined;

// Checkpoint 1 of the Procurement & Material Receiving V1 build (see
// docs/DECISIONS.md's "V1 Scope Narrowed to Procurement & Material
// Receiving" entry and docs/PROCUREMENT_RECEIVING_SPEC.md). This migration
// adds only the material-catalog foundation — Company Item (global physical
// identity), Department Material Catalog (department-scoped, reusable,
// references Company Item), and Units of Measure (global reference data).
// No Demand/IPO/Delivery Challan/Receiving table is created here — those
// are later checkpoints. No stock/ledger table is created at all — V1 does
// not calculate current stock (see the spec's "No Inventory Balance in V1").
//
// Reused patterns instead of new mechanisms:
//   - units_of_measure mirrors employment_types exactly (global reference
//     data, code+name, archive-not-delete).
//   - department_material_catalog does NOT denormalize site_id: a catalog
//     entry always has a required department_id, and departments already
//     carry site_id (see 1787357134154_add-site-model.js), so site is one
//     indexed join away — unlike positions, which needed its own site_id
//     because department_id is nullable there.
//   - permission codes follow the existing `module.action` convention
//     (material_catalog.view / .manage / .all_departments), matching
//     workforce.all_sites' "role alone never implies the broad-scope
//     capability" shape.
//   - created_by_user_id on company_items/department_material_catalog
//     mirrors employees.created_by_user_id — unlike departments/positions
//     (curated master data), these rows are added ad hoc by many ordinary
//     department users, so knowing who added an entry is worth the one FK
//     column.

const UNITS_OF_MEASURE = [
  ["BAG", "Bags"],
  ["BOX", "Boxes"],
  ["GAL", "Gallons"],
  ["KG", "Kilograms"],
  ["LTR", "Litres"],
  ["M", "Metres"],
  ["PCS", "Pieces"],
  ["ROLL", "Rolls"],
  ["SET", "Sets"],
  ["TON", "Tons"],
];

const PERMISSIONS = [
  ["material_catalog.view", "View a department material catalog"],
  ["material_catalog.manage", "Add materials to a department catalog and archive/unarchive entries"],
  ["material_catalog.all_departments", "View and manage material catalogs across all departments"],
];

// UPPER_MANAGEMENT gets the same deliberately conservative treatment
// Workforce already established (see 1787405000000_workforce-schema-
// foundation.js's ROLE_PERMISSIONS comment: "UPPER_MANAGEMENT... never the
// full set" — its baseline there excludes workforce.all_sites entirely).
// Holding UPPER_MANAGEMENT must not by itself grant either routine editing
// or cross-department viewing; a CEO can delegate .manage/.all_departments
// to a specific UM member later via the existing per-user GRANT mechanism.
// Existing Gate Pass roles (ADMIN, SITE_MANAGER, TEAM_LEAD) receive
// material_catalog.* by default because material handling is genuinely
// their existing domain (unlike Workforce, an HR domain those roles
// intentionally receive none of) — each stays scoped to their own
// department; only CEO gets material_catalog.all_departments by default.
const ROLE_PERMISSIONS = {
  CEO: ["material_catalog.view", "material_catalog.manage", "material_catalog.all_departments"],
  ADMIN: ["material_catalog.view", "material_catalog.manage"],
  SITE_MANAGER: ["material_catalog.view", "material_catalog.manage"],
  TEAM_LEAD: ["material_catalog.view", "material_catalog.manage"],
  UPPER_MANAGEMENT: ["material_catalog.view"],
  EMPLOYEE: ["material_catalog.view"],
};

export async function up(pgm) {
  pgm.createTable("units_of_measure", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    code: { type: "varchar(20)", notNull: true, unique: true },
    name: { type: "varchar(100)", notNull: true, unique: true },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  for (const [code, name] of UNITS_OF_MEASURE) {
    pgm.sql(`INSERT INTO units_of_measure (code, name) VALUES ('${code}', '${name}');`);
  }

  // Company Item: the physical/material identity, global — not site- or
  // department-scoped. Department Material Catalog (below) is the
  // department-specific, reusable list that references it.
  pgm.createTable("company_items", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "varchar(150)", notNull: true },
    description: { type: "text" },
    is_active: { type: "boolean", notNull: true, default: true },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  // No unique constraint on name: duplicate prevention is a search-then-warn
  // UX (see material-catalog.repository.js searchCompanyItems), matching
  // the existing Employee duplicate-detection convention (warns, not a
  // hard block) rather than Gate Pass's harder uniqueness constraints.
  pgm.createIndex("company_items", "name");

  pgm.createTable("department_material_catalog", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    department_id: { type: "uuid", notNull: true, references: "departments", onDelete: "RESTRICT" },
    company_item_id: { type: "uuid", notNull: true, references: "company_items", onDelete: "RESTRICT" },
    default_uom_id: { type: "uuid", notNull: true, references: "units_of_measure", onDelete: "RESTRICT" },
    is_active: { type: "boolean", notNull: true, default: true },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("department_material_catalog", "department_material_catalog_dept_item_key", {
    unique: ["department_id", "company_item_id"],
  });
  pgm.createIndex("department_material_catalog", "department_id");

  for (const [code, description] of PERMISSIONS) {
    pgm.sql(
      `INSERT INTO permissions (code, description) VALUES ('${code}', '${description.replace(/'/g, "''")}');`,
    );
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

  // --- RLS on every new table (runtime grants/policies: see
  // scripts/provision-db-roles.sql and test/db-privilege-boundary.test.js)
  const NEW_TABLES = ["units_of_measure", "company_items", "department_material_catalog"];
  for (const table of NEW_TABLES) {
    pgm.sql(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
  }
}

export async function down(pgm) {
  // role_permissions rows cascade-delete with their permission (see
  // ON DELETE CASCADE on role_permissions.permission_id in
  // 1787347983007_rbac-foundation.js) — deleting the permissions below is
  // sufficient, no separate per-role cleanup needed.
  pgm.sql(`DELETE FROM user_permission_overrides WHERE permission_id IN (SELECT id FROM permissions WHERE code LIKE 'material_catalog.%');`);
  pgm.sql(`DELETE FROM permissions WHERE code LIKE 'material_catalog.%';`);

  pgm.dropTable("department_material_catalog");
  pgm.dropTable("company_items");
  pgm.dropTable("units_of_measure");
}
