export const shorthands = undefined;

// Driver and Vehicle master data, plus the Gate Pass evidence model that
// depends on them.
//
// Two invariants shape this migration:
//
//  1. A Gate Pass is a historical record. It already stores driver_name,
//     driver_phone and vehicle_registration as its own columns; those stay
//     authoritative and are NOT replaced by the new foreign keys. The FKs
//     are added alongside as provenance ("which master row was chosen"),
//     so renaming a Driver or re-registering a Vehicle later can never
//     rewrite what an old, already-approved Gate Pass says happened.
//
//  2. Master rows are deactivated, never deleted. ON DELETE RESTRICT means
//     the database itself refuses to remove a Driver or Vehicle that any
//     Gate Pass still references, so "no hard delete after use" survives an
//     application bug, not just a missing endpoint.

const PERMISSIONS = [
  ["driver.view", "View the Driver master list and Driver details"],
  ["driver.manage", "Add, edit, deactivate and reactivate Drivers at the assigned site"],
  ["vehicle.view", "View the Vehicle master list and Vehicle details"],
  ["vehicle.manage", "Add, edit, deactivate and reactivate Vehicles at the assigned site"],
];

const ROLE_PERMISSIONS = {
  CEO: ["driver.view", "driver.manage", "vehicle.view", "vehicle.manage"],
  ADMIN: ["driver.view", "driver.manage", "vehicle.view", "vehicle.manage"],
  SITE_MANAGER: ["driver.view", "driver.manage", "vehicle.view", "vehicle.manage"],
  UPPER_MANAGEMENT: ["driver.view", "vehicle.view"],
  // A Team Lead raises Gate Passes, so they must be able to pick an existing
  // Driver/Vehicle — but creating master data is a separate authority they
  // do not get by default.
  TEAM_LEAD: ["driver.view", "vehicle.view"],
};

// Evidence photos are per-event and unbounded in count (a Guard may photograph
// several angles), so they live purely as gate_pass_files rows. The existing
// single departure_photo_file_id / return_photo_file_id columns stay as the
// FIRST photo of each event: the status-coherence CHECK added in
// 1787358453703 depends on them being non-null, and weakening that check to
// support multiple photos would trade a real database guarantee for nothing.
const FILE_TYPES = [
  "DEPARTURE_PHOTO",
  "RETURN_PHOTO",
  // Inbound evidence documenting something that was never on the approved
  // pass. Deliberately its own type rather than a flag on RETURN_PHOTO: it
  // must be impossible to render it as an approved outbound item, and a
  // distinct type makes that a schema fact rather than a reporting
  // convention.
  "RETURN_ADDITIONAL_PHOTO",
  "APPROVED_PDF",
  "COMPLETED_PDF",
];

export async function up(pgm) {
  pgm.createTable("drivers", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "RESTRICT" },
    name: { type: "varchar(150)", notNull: true },
    phone: { type: "varchar(30)", notNull: true },
    cnic: { type: "varchar(30)" },
    licence_number: { type: "varchar(50)" },
    licence_expiry: { type: "date" },
    company: { type: "varchar(150)" },
    driver_type: { type: "varchar(30)", notNull: true, default: "COMPANY" },
    // Optional only. A Driver is not required to be an employee (contractor
    // and vendor drivers are the common case), and the link is provenance,
    // never authority: it grants the linked employee nothing.
    employee_id: { type: "uuid", references: "employees", onDelete: "RESTRICT" },
    is_active: { type: "boolean", notNull: true, default: true },
    notes: { type: "text" },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("drivers", "drivers_driver_type_check", {
    check: "driver_type IN ('COMPANY', 'CONTRACTOR', 'VENDOR')",
  });
  // Scoped per site, not globally: two sites may legitimately deal with the
  // same contractor driver, and one site must never be able to probe another
  // site's master data by watching for a uniqueness conflict.
  pgm.sql(`
    CREATE UNIQUE INDEX drivers_site_cnic_key
      ON drivers (site_id, cnic) WHERE cnic IS NOT NULL;
    CREATE UNIQUE INDEX drivers_site_licence_key
      ON drivers (site_id, licence_number) WHERE licence_number IS NOT NULL;
  `);
  pgm.createIndex("drivers", "site_id");
  pgm.createIndex("drivers", "employee_id");
  pgm.createIndex("drivers", ["site_id", "is_active"]);

  pgm.createTable("vehicles", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "RESTRICT" },
    registration_number: { type: "varchar(30)", notNull: true },
    vehicle_type: { type: "varchar(40)", notNull: true, default: "OTHER" },
    make: { type: "varchar(60)" },
    model: { type: "varchar(60)" },
    color: { type: "varchar(40)" },
    owner_company: { type: "varchar(150)" },
    is_active: { type: "boolean", notNull: true, default: true },
    notes: { type: "text" },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("vehicles", "vehicles_vehicle_type_check", {
    check: "vehicle_type IN ('TRUCK', 'PICKUP', 'VAN', 'CAR', 'BUS', 'TRAILER', 'BIKE', 'OTHER')",
  });
  // Registration is compared case-insensitively: "ABC-123" and "abc-123" are
  // the same physical vehicle, and allowing both would silently split one
  // vehicle's Gate Pass history across two master rows.
  pgm.sql(`
    CREATE UNIQUE INDEX vehicles_site_registration_key
      ON vehicles (site_id, lower(registration_number));
  `);
  pgm.createIndex("vehicles", "site_id");
  pgm.createIndex("vehicles", ["site_id", "is_active"]);

  for (const table of ["drivers", "vehicles"]) {
    pgm.sql(`
      CREATE TRIGGER ${table}_set_updated_at
      BEFORE UPDATE ON ${table}
      FOR EACH ROW EXECUTE FUNCTION set_updated_at();
    `);
  }

  // --- Gate Pass provenance links --------------------------------------

  pgm.addColumn("gate_passes", {
    driver_id: { type: "uuid", references: "drivers", onDelete: "RESTRICT" },
    vehicle_id: { type: "uuid", references: "vehicles", onDelete: "RESTRICT" },
  });
  pgm.createIndex("gate_passes", "driver_id");
  pgm.createIndex("gate_passes", "vehicle_id");

  // --- Evidence model ---------------------------------------------------

  pgm.dropConstraint("gate_pass_files", "gate_pass_files_type_check");
  pgm.addConstraint("gate_pass_files", "gate_pass_files_type_check", {
    check: `file_type IN (${FILE_TYPES.map((type) => `'${type}'`).join(", ")})`,
  });

  // What the Guard says the photo shows. Required in practice for additional
  // inbound evidence (enforced by the CHECK below) because an unexplained
  // photo of an unlisted object is not usable evidence later.
  pgm.addColumn("gate_pass_files", {
    evidence_note: { type: "varchar(300)" },
  });
  pgm.addConstraint("gate_pass_files", "gate_pass_files_additional_note_check", {
    check: "file_type <> 'RETURN_ADDITIONAL_PHOTO' OR evidence_note IS NOT NULL",
  });

  pgm.createIndex("gate_pass_files", ["gate_pass_id", "file_type"]);

  // Capturing evidence outside the EXIT/RETURN transitions is its own
  // auditable act, so the append-only Gate Pass audit log needs a verb for it.
  pgm.dropConstraint("gate_pass_audit_log", "gate_pass_audit_log_action_check");
  pgm.addConstraint("gate_pass_audit_log", "gate_pass_audit_log_action_check", {
    check: `action IN ('CREATE', 'EDIT_DRAFT', 'SUBMIT', 'APPROVE', 'REJECT', 'CANCEL', 'EXIT', 'RETURN', 'EVIDENCE')`,
  });

  for (const [code, description] of PERMISSIONS) {
    pgm.sql(`INSERT INTO permissions (code, description) VALUES ('${code}', '${description.replace(/'/g, "''")}');`);
  }
  for (const [role, codes] of Object.entries(ROLE_PERMISSIONS)) {
    for (const code of codes) {
      pgm.sql(`
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id FROM roles r, permissions p
        WHERE r.name = '${role}' AND p.code = '${code}'
        ON CONFLICT DO NOTHING;
      `);
    }
  }

  for (const table of ["drivers", "vehicles"]) {
    pgm.sql(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
  }
}

export async function down(pgm) {
  pgm.dropConstraint("gate_pass_audit_log", "gate_pass_audit_log_action_check");
  pgm.addConstraint("gate_pass_audit_log", "gate_pass_audit_log_action_check", {
    check: `action IN ('CREATE', 'EDIT_DRAFT', 'SUBMIT', 'APPROVE', 'REJECT', 'CANCEL', 'EXIT', 'RETURN')`,
  });

  pgm.dropConstraint("gate_pass_files", "gate_pass_files_additional_note_check");
  pgm.dropColumn("gate_pass_files", "evidence_note");
  pgm.dropConstraint("gate_pass_files", "gate_pass_files_type_check");
  pgm.addConstraint("gate_pass_files", "gate_pass_files_type_check", {
    check: "file_type IN ('DEPARTURE_PHOTO', 'RETURN_PHOTO', 'APPROVED_PDF')",
  });

  pgm.dropColumn("gate_passes", "driver_id");
  pgm.dropColumn("gate_passes", "vehicle_id");

  pgm.dropTable("vehicles");
  pgm.dropTable("drivers");

  for (const [code] of PERMISSIONS) {
    pgm.sql(`DELETE FROM role_permissions WHERE permission_id IN (SELECT id FROM permissions WHERE code = '${code}');`);
    pgm.sql(`DELETE FROM permissions WHERE code = '${code}';`);
  }
}
