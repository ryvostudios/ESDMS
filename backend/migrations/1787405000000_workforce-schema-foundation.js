export const shorthands = undefined;

// Workforce/Employee Management schema foundation. One migration for the
// whole module's tables (checkpoint "A" of the build) rather than one
// migration per table — the DB runtime-security boundary (RLS +
// scripts/provision-db-roles.sql + test/db-privilege-boundary.test.js +
// docs/SECURITY.md counts) has to be updated for every new table regardless
// of how many migrations they're split across, so bundling avoids paying
// that fixed cost 20 times. See docs/DECISIONS.md.
//
// Reused patterns instead of new mechanisms where an equivalent already
// exists and is proven in this codebase:
//   - site-scoped master data (positions) mirrors `departments` exactly,
//     composite-FK'd to its site the same way db-relational-coherence.js
//     pins departments/gate_passes to their site.
//   - versioned, append-only files (employee_documents,
//     employee_profile_photos) mirror gate_pass_files: increasing integer
//     version, `forbid_delete()` trigger, "current" = latest version by
//     query, never an update.
//   - "pointer to the current file, ownership-pinned by composite FK"
//     (employee_personal_details.current_photo_id) mirrors
//     gate_passes.departure_photo_file_id from db-relational-coherence.js.
//   - the protected/forensic audit trail already exists
//     (governance_audit_log, migration 1787404000000) — Workforce's
//     compensation/contract/export/history-removal events extend that
//     table (new action codes + two new nullable target columns) rather
//     than creating a second, parallel "protected audit" table. See the
//     companion migration 1787406000000_workforce-protected-audit.js.
//   - permission codes follow the existing `module.action` convention
//     (gate_pass.*, users.*, permission_overrides.*).

const EMPLOYMENT_STATUSES = ["ACTIVE", "INACTIVE", "RESIGNED", "TERMINATED"];
const DOCUMENT_VERIFICATION_STATUSES = ["UPLOADED", "VERIFIED", "NEEDS_REPLACEMENT"];
const DOCUMENT_REQUEST_STATUSES = ["PENDING", "FULFILLED", "CANCELLED"];
const CONTRACT_STATUSES = ["DRAFT", "CURRENT", "SUPERSEDED", "EXPIRED", "TERMINATED"];
const CONTRACT_KINDS = ["ORIGINAL", "AMENDMENT"];
const LEAVE_REQUEST_STATUSES = ["SUBMITTED", "APPROVED", "REJECTED", "CANCELLED"];
const TEMP_ASSIGNMENT_STATUSES = ["ACTIVE", "ENDED", "CANCELLED"];
const CUSTOM_FIELD_TYPES = [
  "TEXT",
  "LONG_TEXT",
  "NUMBER",
  "DATE",
  "BOOLEAN",
  "DROPDOWN",
  "MULTI_SELECT",
  "EMAIL",
  "PHONE",
  "URL",
  "PERCENTAGE",
];

// Every module.action permission this build introduces. Only CEO is
// granted the full set at the role level (mirrors governance-foundation's
// own pattern) — UPPER_MANAGEMENT/HR/EMPLOYEE get the specific, narrower
// baseline from ROLE_PERMISSIONS below, never "everything Workforce."
const PERMISSIONS = [
  ["employees.view", "View the employee directory and employee records"],
  ["employees.create", "Create a new Employee record"],
  ["employees.update", "Edit an Employee's core HR-owned fields"],
  ["employees.status_change", "Change an Employee's employment status (activate/resign/terminate)"],
  ["employees.transfer", "Create a new effective-dated employment assignment (site/department/position/reporting manager)"],
  ["employees.account.create", "Create an ordinary EMPLOYEE-role login account linked to an Employee"],
  ["employees.account.reset", "Reset an Employee's login password"],
  ["profile.self.view", "View one's own Employee profile"],
  ["profile.self.edit", "Edit one's own permitted Employee profile fields"],
  ["employee_documents.view", "View employee document metadata"],
  ["employee_documents.manage", "Upload/replace employee documents and manage document requests"],
  ["employee_documents.download", "Download employee document files"],
  ["employee_documents.verify", "Mark an employee document verified or needing replacement"],
  ["employee_documents.bulk_export", "Generate a bulk ZIP export of employee documents"],
  ["positions.manage", "Create/edit/archive Positions"],
  ["departments.manage", "Create/edit/archive Departments"],
  ["employment_types.manage", "Create/edit/archive Employment Types"],
  ["workforce.configuration.manage", "Configure profile sections, custom fields, and document types"],
  ["workforce.reports.view", "View Workforce reports"],
  ["workforce.export", "Export Workforce data (Excel/bulk)"],
  ["workforce.all_sites", "View/manage Workforce data across all sites, not just one's own"],
  ["rotation.view", "View rotation policy assignment and balance"],
  ["rotation.manage", "Configure rotation policies and assign employees to a policy"],
  ["rotation.adjust", "Record a manual rotation ledger adjustment"],
  ["leave.self.create", "Submit one's own leave request"],
  ["leave.self.view", "View one's own leave requests"],
  ["leave.manage", "Configure Leave Types"],
  ["leave.approve", "Approve or reject a submitted leave request"],
  ["compensation.view", "View an employee's current compensation"],
  ["compensation.change", "Record a new compensation record for an employee"],
  ["compensation.history", "View an employee's full compensation history"],
  ["compensation.export", "Include compensation in a Workforce export/report"],
  ["contract.view", "View employment contract metadata"],
  ["contract.create", "Create a draft employment contract"],
  ["contract.edit_draft", "Edit or replace a draft contract's file/metadata"],
  ["contract.finalize", "Finalize a draft contract, making it immutable"],
  ["contract.download", "Download a contract file"],
  ["contract.amend", "Create an amendment referencing a finalized contract"],
  ["business_history.correct", "Add a correction/annotation to a business-history entry"],
  ["business_history.remove", "Logically remove a business-history entry (CEO; delegable per-user)"],
];

// UPPER_MANAGEMENT and HR each get a specific, conservative baseline —
// never the full set — per "ordinary UM must not automatically..." /
// "HR must not automatically...". CEO can delegate anything else later via
// user_permission_overrides. EMPLOYEE's baseline is the fixed self-service
// surface. Existing Gate Pass roles (ADMIN, SITE_MANAGER, TEAM_LEAD,
// GATE_GUARD) intentionally receive none of this — Workforce access for
// them would be a separate, explicit grant, not a default.
const ROLE_PERMISSIONS = {
  UPPER_MANAGEMENT: [
    "employees.view",
    "workforce.reports.view",
    "rotation.view",
    "leave.approve",
    "employee_documents.view",
    "profile.self.view",
    "profile.self.edit",
  ],
  HR: [
    "employees.view",
    "employees.create",
    "employees.update",
    "employees.status_change",
    "employees.transfer",
    "employees.account.create",
    "employees.account.reset",
    "employee_documents.view",
    "employee_documents.manage",
    "employee_documents.verify",
    "employee_documents.download",
    "employee_documents.bulk_export",
    "positions.manage",
    "departments.manage",
    "employment_types.manage",
    "workforce.configuration.manage",
    "workforce.reports.view",
    "workforce.export",
    "rotation.view",
    "rotation.manage",
    "rotation.adjust",
    "leave.manage",
    "leave.approve",
    "profile.self.view",
    "profile.self.edit",
  ],
  EMPLOYEE: [
    "profile.self.view",
    "profile.self.edit",
    "leave.self.create",
    "leave.self.view",
  ],
};

export async function up(pgm) {
  for (const [code, description] of PERMISSIONS) {
    pgm.sql(`INSERT INTO permissions (code, description) VALUES ('${code}', '${description.replace(/'/g, "''")}');`);
  }

  for (const code of PERMISSIONS.map(([c]) => c)) {
    pgm.sql(`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = 'CEO' AND p.code = '${code}'
      ON CONFLICT DO NOTHING;
    `);
  }

  for (const [role, codes] of Object.entries(ROLE_PERMISSIONS)) {
    for (const code of codes) {
      pgm.sql(`
        INSERT INTO role_permissions (role_id, permission_id)
        SELECT r.id, p.id FROM roles r, permissions p WHERE r.name = '${role}' AND p.code = '${code}'
        ON CONFLICT DO NOTHING;
      `);
    }
  }

  // --- Positions (site-scoped, mirrors departments) -----------------------
  pgm.createTable("positions", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "RESTRICT" },
    code: { type: "varchar(30)", notNull: true },
    name: { type: "varchar(150)", notNull: true },
    department_id: { type: "uuid", references: "departments", onDelete: "RESTRICT" },
    description: { type: "text" },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("positions", "positions_site_id_code_key", { unique: ["site_id", "code"] });
  pgm.addConstraint("positions", "positions_site_id_name_key", { unique: ["site_id", "name"] });
  pgm.addConstraint("positions", "positions_id_site_id_key", { unique: ["id", "site_id"] });
  pgm.addConstraint("positions", "positions_department_site_fkey", {
    foreignKeys: { columns: ["department_id", "site_id"], references: "departments(id, site_id)" },
  });
  pgm.createIndex("positions", "site_id");

  // --- Employment Types (global reference data) ---------------------------
  pgm.createTable("employment_types", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    code: { type: "varchar(30)", notNull: true, unique: true },
    name: { type: "varchar(100)", notNull: true, unique: true },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  // --- Rotation policies (referenced by employment_assignments below, so
  // created before it) ------------------------------------------------------
  pgm.createTable("rotation_policies", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "varchar(100)", notNull: true, unique: true },
    work_days: { type: "integer", notNull: true },
    off_days: { type: "integer", notNull: true },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("rotation_policies", "rotation_policies_days_check", {
    check: "work_days > 0 AND off_days >= 0",
  });

  // --- Employees (core, HR-authoritative) ---------------------------------
  // Site/department/position/employment_type/reporting_manager are
  // deliberately NOT columns here — they live in employment_assignments
  // (effective-dated) below, per "do not overwrite Site/Department/
  // Position/Reporting Manager — use effective-dated history."
  pgm.createTable("employees", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_code: { type: "varchar(30)", notNull: true, unique: true },
    full_legal_name: { type: "varchar(150)", notNull: true },
    primary_site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "RESTRICT" },
    // Nullable + unique: an Employee may exist with no login (spec); at
    // most one Employee per user account when a login does exist.
    user_id: { type: "uuid", references: "users", onDelete: "SET NULL", unique: true },
    status: { type: "varchar(20)", notNull: true, default: "ACTIVE" },
    status_reason: { type: "text" },
    joining_date: { type: "date", notNull: true },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("employees", "employees_status_check", {
    check: `status IN (${EMPLOYMENT_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });
  pgm.addConstraint("employees", "employees_id_primary_site_id_key", { unique: ["id", "primary_site_id"] });
  pgm.createIndex("employees", "primary_site_id");
  pgm.createIndex("employees", "status");

  // --- Employment assignments (effective-dated history) -------------------
  pgm.createTable("employment_assignments", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_id: { type: "uuid", notNull: true, references: "employees", onDelete: "CASCADE" },
    site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "RESTRICT" },
    department_id: { type: "uuid", references: "departments", onDelete: "RESTRICT" },
    position_id: { type: "uuid", references: "positions", onDelete: "RESTRICT" },
    employment_type_id: { type: "uuid", references: "employment_types", onDelete: "RESTRICT" },
    // Rotation policy folded into the same effective-dated record rather
    // than a fourth history table — a deliberate V1 simplification (see
    // docs/DECISIONS.md); it changes independently of site/department in
    // practice about as often as position does.
    rotation_policy_id: { type: "uuid", references: "rotation_policies", onDelete: "RESTRICT" },
    reporting_manager_employee_id: { type: "uuid", references: "employees", onDelete: "RESTRICT" },
    effective_date: { type: "date", notNull: true },
    reason: { type: "text" },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("employment_assignments", "employment_assignments_employee_effective_key", {
    unique: ["employee_id", "effective_date"],
  });
  pgm.addConstraint("employment_assignments", "employment_assignments_department_site_fkey", {
    foreignKeys: { columns: ["department_id", "site_id"], references: "departments(id, site_id)" },
  });
  pgm.addConstraint("employment_assignments", "employment_assignments_position_site_fkey", {
    foreignKeys: { columns: ["position_id", "site_id"], references: "positions(id, site_id)" },
  });
  pgm.createIndex("employment_assignments", "employee_id");
  pgm.createIndex("employment_assignments", ["employee_id", "effective_date"]);

  // --- Temporary assignments (schema only this pass — see docs/DECISIONS.md)
  pgm.createTable("temporary_assignments", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_id: { type: "uuid", notNull: true, references: "employees", onDelete: "CASCADE" },
    site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "RESTRICT" },
    department_id: { type: "uuid", references: "departments", onDelete: "RESTRICT" },
    start_date: { type: "date", notNull: true },
    end_date: { type: "date", notNull: true },
    reason: { type: "text" },
    status: { type: "varchar(20)", notNull: true, default: "ACTIVE" },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("temporary_assignments", "temporary_assignments_status_check", {
    check: `status IN (${TEMP_ASSIGNMENT_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });
  pgm.addConstraint("temporary_assignments", "temporary_assignments_date_check", {
    check: "end_date >= start_date",
  });
  pgm.createIndex("temporary_assignments", "employee_id");

  // --- Profile photos (versioned, mirrors gate_pass_files) ----------------
  pgm.createTable("employee_profile_photos", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_id: { type: "uuid", notNull: true, references: "employees", onDelete: "CASCADE" },
    storage_key: { type: "text", notNull: true, unique: true },
    mime_type: { type: "varchar(100)", notNull: true },
    size_bytes: { type: "integer", notNull: true },
    checksum_sha256: { type: "varchar(64)", notNull: true },
    version: { type: "integer", notNull: true, default: 1 },
    uploaded_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("employee_profile_photos", "employee_profile_photos_size_check", { check: "size_bytes > 0" });
  pgm.addConstraint("employee_profile_photos", "employee_profile_photos_employee_version_key", {
    unique: ["employee_id", "version"],
  });
  pgm.addConstraint("employee_profile_photos", "employee_profile_photos_id_employee_id_key", {
    unique: ["id", "employee_id"],
  });
  pgm.sql(`
    CREATE TRIGGER employee_profile_photos_forbid_delete
    BEFORE DELETE ON employee_profile_photos
    FOR EACH ROW EXECUTE FUNCTION forbid_delete();
  `);

  // --- Personal details (employee-editable core fields) -------------------
  pgm.createTable("employee_personal_details", {
    employee_id: { type: "uuid", primaryKey: true, references: "employees", onDelete: "CASCADE" },
    cnic: { type: "varchar(20)" },
    mobile: { type: "varchar(30)" },
    address: { type: "text" },
    personal_email: { type: "varchar(255)" },
    current_photo_id: { type: "uuid", references: "employee_profile_photos", onDelete: "RESTRICT" },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("employee_personal_details", "employee_personal_details_photo_ownership_fkey", {
    foreignKeys: {
      columns: ["current_photo_id", "employee_id"],
      references: "employee_profile_photos(id, employee_id)",
    },
  });

  pgm.createTable("employee_emergency_contacts", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_id: { type: "uuid", notNull: true, references: "employees", onDelete: "CASCADE" },
    name: { type: "varchar(150)", notNull: true },
    relationship: { type: "varchar(60)" },
    phone: { type: "varchar(30)", notNull: true },
    alternate_phone: { type: "varchar(30)" },
    sort_order: { type: "integer", notNull: true, default: 0 },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.createIndex("employee_emergency_contacts", "employee_id");

  // --- Configurable profile sections / custom fields -----------------------
  pgm.createTable("employee_profile_sections", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "varchar(100)", notNull: true, unique: true },
    description: { type: "text" },
    sort_order: { type: "integer", notNull: true, default: 0 },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.createTable("employee_custom_fields", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    section_id: { type: "uuid", notNull: true, references: "employee_profile_sections", onDelete: "RESTRICT" },
    label: { type: "varchar(150)", notNull: true },
    field_key: { type: "varchar(60)", notNull: true, unique: true },
    field_type: { type: "varchar(20)", notNull: true },
    help_text: { type: "text" },
    is_required: { type: "boolean", notNull: true, default: false },
    employee_can_view: { type: "boolean", notNull: true, default: true },
    employee_can_edit: { type: "boolean", notNull: true, default: true },
    hr_can_view: { type: "boolean", notNull: true, default: true },
    hr_can_edit: { type: "boolean", notNull: true, default: true },
    management_can_view: { type: "boolean", notNull: true, default: false },
    is_searchable: { type: "boolean", notNull: true, default: false },
    is_filterable: { type: "boolean", notNull: true, default: false },
    is_reportable: { type: "boolean", notNull: true, default: false },
    is_sensitive: { type: "boolean", notNull: true, default: false },
    counts_toward_completion: { type: "boolean", notNull: true, default: false },
    // { minLength?, maxLength?, min?, max?, options?: string[], allowFutureDate?, allowPastDate? }
    validation: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
    sort_order: { type: "integer", notNull: true, default: 0 },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("employee_custom_fields", "employee_custom_fields_type_check", {
    check: `field_type IN (${CUSTOM_FIELD_TYPES.map((t) => `'${t}'`).join(", ")})`,
  });
  pgm.createIndex("employee_custom_fields", "section_id");

  pgm.createTable("employee_custom_field_values", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_id: { type: "uuid", notNull: true, references: "employees", onDelete: "CASCADE" },
    field_id: { type: "uuid", notNull: true, references: "employee_custom_fields", onDelete: "RESTRICT" },
    // Flexible model for the VALUE of one field only — not a substitute for
    // the relational Employee record (see docs/DECISIONS.md).
    value: { type: "jsonb", notNull: true },
    updated_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("employee_custom_field_values", "employee_custom_field_values_employee_field_key", {
    unique: ["employee_id", "field_id"],
  });
  pgm.createIndex("employee_custom_field_values", "employee_id");

  // --- Document types / documents / requests -------------------------------
  pgm.createTable("employee_document_types", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "varchar(100)", notNull: true, unique: true },
    is_required: { type: "boolean", notNull: true, default: false },
    employee_can_upload: { type: "boolean", notNull: true, default: true },
    hr_can_upload: { type: "boolean", notNull: true, default: true },
    employee_can_view: { type: "boolean", notNull: true, default: true },
    hr_can_view: { type: "boolean", notNull: true, default: true },
    expiry_required: { type: "boolean", notNull: true, default: false },
    verification_required: { type: "boolean", notNull: true, default: false },
    allowed_mime_types: { type: "text[]", notNull: true, default: pgm.func("ARRAY['application/pdf','image/jpeg','image/png']::text[]") },
    sort_order: { type: "integer", notNull: true, default: 0 },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.createTable("employee_documents", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_id: { type: "uuid", notNull: true, references: "employees", onDelete: "CASCADE" },
    document_type_id: { type: "uuid", notNull: true, references: "employee_document_types", onDelete: "RESTRICT" },
    version: { type: "integer", notNull: true, default: 1 },
    storage_key: { type: "text", notNull: true, unique: true },
    mime_type: { type: "varchar(100)", notNull: true },
    size_bytes: { type: "integer", notNull: true },
    checksum_sha256: { type: "varchar(64)", notNull: true },
    original_filename: { type: "varchar(255)" },
    uploaded_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    uploaded_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    expiry_date: { type: "date" },
    verification_status: { type: "varchar(20)", notNull: true, default: "UPLOADED" },
    verified_by_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    verified_at: { type: "timestamptz" },
    verification_remark: { type: "text" },
  });
  pgm.addConstraint("employee_documents", "employee_documents_size_check", { check: "size_bytes > 0" });
  pgm.addConstraint("employee_documents", "employee_documents_verification_status_check", {
    check: `verification_status IN (${DOCUMENT_VERIFICATION_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });
  pgm.addConstraint("employee_documents", "employee_documents_employee_type_version_key", {
    unique: ["employee_id", "document_type_id", "version"],
  });
  pgm.createIndex("employee_documents", "employee_id");
  pgm.createIndex("employee_documents", "expiry_date");
  pgm.sql(`
    CREATE TRIGGER employee_documents_forbid_delete
    BEFORE DELETE ON employee_documents
    FOR EACH ROW EXECUTE FUNCTION forbid_delete();
  `);

  pgm.createTable("employee_document_requests", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_id: { type: "uuid", notNull: true, references: "employees", onDelete: "CASCADE" },
    document_type_id: { type: "uuid", notNull: true, references: "employee_document_types", onDelete: "RESTRICT" },
    requested_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    status: { type: "varchar(20)", notNull: true, default: "PENDING" },
    note: { type: "text" },
    fulfilled_document_id: { type: "uuid", references: "employee_documents", onDelete: "SET NULL" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    resolved_at: { type: "timestamptz" },
  });
  pgm.addConstraint("employee_document_requests", "employee_document_requests_status_check", {
    check: `status IN (${DOCUMENT_REQUEST_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });
  pgm.createIndex("employee_document_requests", ["employee_id", "status"]);

  // --- Compensation ledger (insert-only by service convention; see
  // docs/DECISIONS.md for why this isn't DB-trigger-immutable like
  // contracts) --------------------------------------------------------------
  pgm.createTable("employee_compensation_records", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_id: { type: "uuid", notNull: true, references: "employees", onDelete: "CASCADE" },
    amount: { type: "numeric(14,2)", notNull: true },
    currency: { type: "varchar(3)", notNull: true, default: "PKR" },
    effective_date: { type: "date", notNull: true },
    reason: { type: "text" },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("employee_compensation_records", "employee_compensation_records_amount_check", {
    check: "amount >= 0",
  });
  pgm.addConstraint("employee_compensation_records", "employee_compensation_records_employee_effective_key", {
    unique: ["employee_id", "effective_date"],
  });
  pgm.createIndex("employee_compensation_records", "employee_id");

  // --- Contracts (strongest protection: DB-enforced immutability once
  // finalized — see the trigger function below and docs/SECURITY.md) ------
  pgm.createTable("employee_contract_number_counters", {
    year: { type: "integer", notNull: true },
    kind: { type: "varchar(20)", notNull: true },
    last_value: { type: "integer", notNull: true, default: 0 },
  });
  pgm.addConstraint("employee_contract_number_counters", "employee_contract_number_counters_pkey", {
    primaryKey: ["year", "kind"],
  });

  pgm.createTable("employee_contracts", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_id: { type: "uuid", notNull: true, references: "employees", onDelete: "RESTRICT" },
    contract_number: { type: "varchar(30)", notNull: true, unique: true },
    kind: { type: "varchar(20)", notNull: true },
    amends_contract_id: { type: "uuid", references: "employee_contracts", onDelete: "RESTRICT" },
    status: { type: "varchar(20)", notNull: true, default: "DRAFT" },
    effective_start_date: { type: "date" },
    effective_end_date: { type: "date" },
    terms_summary: { type: "text" },
    storage_key: { type: "text", unique: true },
    mime_type: { type: "varchar(100)" },
    size_bytes: { type: "integer" },
    checksum_sha256: { type: "varchar(64)" },
    finalized_at: { type: "timestamptz" },
    finalized_by_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("employee_contracts", "employee_contracts_kind_check", {
    check: `kind IN (${CONTRACT_KINDS.map((k) => `'${k}'`).join(", ")})`,
  });
  pgm.addConstraint("employee_contracts", "employee_contracts_status_check", {
    check: `status IN (${CONTRACT_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });
  pgm.addConstraint("employee_contracts", "employee_contracts_amendment_reference_check", {
    check: "(kind = 'AMENDMENT' AND amends_contract_id IS NOT NULL) OR (kind = 'ORIGINAL' AND amends_contract_id IS NULL)",
  });
  pgm.createIndex("employee_contracts", "employee_id");
  pgm.createIndex("employee_contracts", "status");

  // Column-diff immutability: once a contract leaves DRAFT, no column may
  // change EXCEPT `status` itself (and only forward through the lifecycle)
  // and `updated_at`. Effective dates are original terms and therefore
  // immutable too. This blocks every content-mutation path in one place
  // — application code, a future bug, or a direct psql session, including
  // one connected as CEO — rather than relying on service-layer discipline
  // alone. No SECURITY DEFINER (runs with ordinary trigger privileges,
  // like forbid_update_delete()); search_path pinned defensively since this
  // one references catalog-adjacent behavior via IS DISTINCT FROM chains.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION employee_contracts_enforce_immutability()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF OLD.status = 'DRAFT' THEN
        RETURN NEW;
      END IF;

      IF NEW.status = OLD.status
         OR (OLD.status = 'CURRENT' AND NEW.status IN ('SUPERSEDED', 'EXPIRED', 'TERMINATED')) THEN
        -- status transition allowed; fall through to the column-diff check
      ELSE
        RAISE EXCEPTION 'employee_contracts: % -> % is not a permitted status transition on a finalized contract', OLD.status, NEW.status;
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
         OR NEW.contract_number IS DISTINCT FROM OLD.contract_number
         OR NEW.kind IS DISTINCT FROM OLD.kind
         OR NEW.amends_contract_id IS DISTINCT FROM OLD.amends_contract_id
         OR NEW.effective_start_date IS DISTINCT FROM OLD.effective_start_date
         OR NEW.effective_end_date IS DISTINCT FROM OLD.effective_end_date
         OR NEW.terms_summary IS DISTINCT FROM OLD.terms_summary
         OR NEW.storage_key IS DISTINCT FROM OLD.storage_key
         OR NEW.mime_type IS DISTINCT FROM OLD.mime_type
         OR NEW.size_bytes IS DISTINCT FROM OLD.size_bytes
         OR NEW.checksum_sha256 IS DISTINCT FROM OLD.checksum_sha256
         OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at
         OR NEW.finalized_by_user_id IS DISTINCT FROM OLD.finalized_by_user_id
         OR NEW.created_by_user_id IS DISTINCT FROM OLD.created_by_user_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'employee_contracts: a finalized contract is immutable except for its lifecycle status';
      END IF;

      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER employee_contracts_immutability
    BEFORE UPDATE ON employee_contracts
    FOR EACH ROW EXECUTE FUNCTION employee_contracts_enforce_immutability();
  `);
  pgm.sql(`
    CREATE OR REPLACE FUNCTION employee_contracts_forbid_finalized_delete()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF OLD.status <> 'DRAFT' THEN
        RAISE EXCEPTION 'employee_contracts: a finalized contract cannot be deleted';
      END IF;
      RETURN OLD;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER employee_contracts_forbid_finalized_delete
    BEFORE DELETE ON employee_contracts
    FOR EACH ROW EXECUTE FUNCTION employee_contracts_forbid_finalized_delete();
  `);

  // --- Rotation ledger ------------------------------------------------------
  pgm.createTable("employee_rotation_ledger", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_id: { type: "uuid", notNull: true, references: "employees", onDelete: "CASCADE" },
    entry_type: { type: "varchar(20)", notNull: true },
    days: { type: "numeric(6,2)", notNull: true },
    reason: { type: "text" },
    effective_date: { type: "date", notNull: true },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("employee_rotation_ledger", "employee_rotation_ledger_entry_type_check", {
    check: "entry_type IN ('CREDIT', 'DEBIT', 'ADJUSTMENT')",
  });
  pgm.createIndex("employee_rotation_ledger", "employee_id");
  pgm.sql(`
    CREATE TRIGGER employee_rotation_ledger_forbid_delete
    BEFORE DELETE ON employee_rotation_ledger
    FOR EACH ROW EXECUTE FUNCTION forbid_delete();
  `);

  // --- Leave ------------------------------------------------------------
  pgm.createTable("leave_types", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    name: { type: "varchar(100)", notNull: true, unique: true },
    requires_document: { type: "boolean", notNull: true, default: false },
    tracks_balance: { type: "boolean", notNull: true, default: false },
    description: { type: "text" },
    is_active: { type: "boolean", notNull: true, default: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.createTable("leave_requests", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_id: { type: "uuid", notNull: true, references: "employees", onDelete: "CASCADE" },
    leave_type_id: { type: "uuid", notNull: true, references: "leave_types", onDelete: "RESTRICT" },
    start_date: { type: "date", notNull: true },
    end_date: { type: "date", notNull: true },
    requested_days: { type: "numeric(5,2)", notNull: true },
    reason: { type: "text" },
    status: { type: "varchar(20)", notNull: true, default: "SUBMITTED" },
    decided_by_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    decided_at: { type: "timestamptz" },
    decision_remark: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("leave_requests", "leave_requests_status_check", {
    check: `status IN (${LEAVE_REQUEST_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });
  pgm.addConstraint("leave_requests", "leave_requests_date_check", { check: "end_date >= start_date" });
  pgm.addConstraint("leave_requests", "leave_requests_days_check", { check: "requested_days > 0" });
  pgm.createIndex("leave_requests", ["employee_id", "status"]);

  // --- Business history (user-facing timeline; CEO can logically remove,
  // see the companion protected-audit migration for the forensic side) ----
  pgm.createTable("employee_business_history", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    employee_id: { type: "uuid", notNull: true, references: "employees", onDelete: "CASCADE" },
    event_type: { type: "varchar(50)", notNull: true },
    summary: { type: "jsonb", notNull: true, default: pgm.func("'{}'::jsonb") },
    actor_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    is_removed: { type: "boolean", notNull: true, default: false },
    removed_by_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    removed_reason: { type: "text" },
    removed_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.createIndex("employee_business_history", "employee_id");
  pgm.sql(`
    CREATE OR REPLACE FUNCTION employee_business_history_guard()
    RETURNS TRIGGER
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'employee_business_history: rows cannot be deleted; use the logical removal columns';
      END IF;

      IF NEW.id IS DISTINCT FROM OLD.id
         OR NEW.employee_id IS DISTINCT FROM OLD.employee_id
         OR NEW.event_type IS DISTINCT FROM OLD.event_type
         OR NEW.summary IS DISTINCT FROM OLD.summary
         OR NEW.actor_user_id IS DISTINCT FROM OLD.actor_user_id
         OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
        RAISE EXCEPTION 'employee_business_history: only the removal columns (is_removed, removed_by_user_id, removed_reason, removed_at) may ever be updated';
      END IF;

      RETURN NEW;
    END;
    $$;
  `);
  pgm.sql(`
    CREATE TRIGGER employee_business_history_forbid_delete
    BEFORE DELETE ON employee_business_history
    FOR EACH ROW EXECUTE FUNCTION employee_business_history_guard();
  `);
  pgm.sql(`
    CREATE TRIGGER employee_business_history_guard_update
    BEFORE UPDATE ON employee_business_history
    FOR EACH ROW EXECUTE FUNCTION employee_business_history_guard();
  `);

  // --- RLS on every new table (runtime grants/policies: see
  // scripts/provision-db-roles.sql and test/db-privilege-boundary.test.js)
  const NEW_TABLES = [
    "positions",
    "employment_types",
    "employees",
    "employment_assignments",
    "temporary_assignments",
    "employee_profile_photos",
    "employee_personal_details",
    "employee_emergency_contacts",
    "employee_profile_sections",
    "employee_custom_fields",
    "employee_custom_field_values",
    "employee_document_types",
    "employee_documents",
    "employee_document_requests",
    "employee_compensation_records",
    "employee_contract_number_counters",
    "employee_contracts",
    "rotation_policies",
    "employee_rotation_ledger",
    "leave_types",
    "leave_requests",
    "employee_business_history",
  ];
  for (const table of NEW_TABLES) {
    pgm.sql(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
  }
}

export async function down(pgm) {
  const NEW_TABLES_REVERSE = [
    "employee_business_history",
    "leave_requests",
    "leave_types",
    "employee_rotation_ledger",
    "rotation_policies",
    "employee_contracts",
    "employee_contract_number_counters",
    "employee_compensation_records",
    "employee_document_requests",
    "employee_documents",
    "employee_document_types",
    "employee_custom_field_values",
    "employee_custom_fields",
    "employee_profile_sections",
    "employee_emergency_contacts",
    "employee_personal_details",
    "employee_profile_photos",
    "temporary_assignments",
    "employment_assignments",
    "employees",
    "employment_types",
    "positions",
  ];
  for (const table of NEW_TABLES_REVERSE) {
    pgm.dropTable(table);
  }
  pgm.sql(`DROP FUNCTION IF EXISTS employee_business_history_guard();`);
  pgm.sql(`DROP FUNCTION IF EXISTS employee_contracts_forbid_finalized_delete();`);
  pgm.sql(`DROP FUNCTION IF EXISTS employee_contracts_enforce_immutability();`);
  // Permissions/role_permissions rows left in place on down, consistent
  // with every prior migration's own down().
}
