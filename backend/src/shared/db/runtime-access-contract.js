// The single declarative description of what the running API's database role
// must actually be able to do.
//
// Before this existed, three places independently described the runtime
// database boundary and could drift apart silently:
//
//   - scripts/provision-db-roles.sql   (what is GRANTed)
//   - test/db-privilege-boundary.test.js (what is asserted)
//   - schema-compatibility.js          (what readiness checked — which was
//                                       only object EXISTENCE)
//
// That drift is exactly how a deployment reached "readiness green, /login
// 500 with PostgreSQL 42501": the migration added a table, the provisioning
// script was not re-run, and nothing on the readiness path ever asked
// whether the runtime role could still READ anything.
//
// This module is now the contract. provision-db-roles.sql remains the thing
// that GRANTS (it must stay pure SQL so it can be run by an operator with
// psql alone), but a test asserts the two agree, so adding a table to one
// without the other fails CI rather than production.

export const DML = Object.freeze(["SELECT", "INSERT", "UPDATE", "DELETE"]);
const READ_ONLY = Object.freeze(["SELECT"]);
// Assignment provenance is append/remove only — there is no unaudited
// UPDATE path over who holds a capability bundle.
const APPEND_REMOVE = Object.freeze(["SELECT", "INSERT", "DELETE"]);

// Every public table the running API is allowed to touch, and with which
// privileges. Ordered as in provision-db-roles.sql so a diff between the two
// stays readable.
export const RUNTIME_TABLE_PRIVILEGES = Object.freeze({
  company_items: DML,
  department_material_catalog: DML,
  carry_forward_allocations: DML,
  delivery_challan_lines: DML,
  delivery_challans: DML,
  departments: DML,
  drivers: DML,
  document_number_counters: DML,
  document_number_settings: DML,
  employee_business_history: DML,
  employee_compensation_records: DML,
  employee_contract_number_counters: DML,
  employee_contracts: DML,
  employee_custom_field_values: DML,
  employee_custom_fields: DML,
  employee_document_requests: DML,
  employee_document_types: DML,
  employee_documents: DML,
  employee_emergency_contacts: DML,
  employee_personal_details: DML,
  employee_profile_photos: DML,
  employee_profile_sections: DML,
  employee_rotation_ledger: DML,
  employees: DML,
  employment_assignments: DML,
  employment_types: DML,
  gate_pass_audit_log: DML,
  gate_pass_files: DML,
  gate_pass_items: DML,
  gate_pass_number_counters: DML,
  gate_passes: DML,
  governance_audit_log: DML,
  ipo_lines: DML,
  ipo_purchase_events: DML,
  ipos: DML,
  leave_requests: DML,
  leave_types: DML,
  material_demand_approvals: DML,
  material_demand_audit_log: DML,
  material_demand_lines: DML,
  material_demand_pricing: DML,
  material_demand_pricing_lines: DML,
  material_demand_number_counters: DML,
  material_demand_line_dispositions: DML,
  material_demands: DML,
  material_receipt_lines: DML,
  material_receipts: DML,
  notification_outbox: DML,
  procurement_audit_log: DML,
  procurement_documents: DML,
  permissions: DML,
  positions: DML,
  role_permissions: DML,
  roles: DML,
  rotation_policies: DML,
  sites: DML,
  temporary_assignments: DML,
  units_of_measure: DML,
  user_permission_overrides: DML,
  users: DML,
  vehicles: DML,
  cloud_storage_connections: Object.freeze(["SELECT", "UPDATE"]),
  cloud_storage_active: Object.freeze(["SELECT", "UPDATE"]),
  cloud_storage_oauth_states: APPEND_REMOVE,
  cloud_storage_objects: Object.freeze(["SELECT", "INSERT", "UPDATE"]),
  cms_settings: Object.freeze(["SELECT", "UPDATE"]),
  // Capability definitions are migration-owned reference data: readable by
  // the runtime, never rewritten by it.
  permission_bundles: READ_ONLY,
  permission_bundle_permissions: READ_ONLY,
  user_permission_bundle_assignments: APPEND_REMOVE,
});

export const RUNTIME_TABLES = Object.freeze(Object.keys(RUNTIME_TABLE_PRIVILEGES));

// Every contract table must also carry the single converged runtime RLS
// policy. A table with RLS enabled and no matching policy is a deny-all for
// the non-owner runtime login — indistinguishable, from the application's
// point of view, from a missing GRANT.
export const RUNTIME_POLICY_NAME = "esdms_runtime_access";

// Deliberately owner-only: the runtime role has no privilege and no policy
// on the migration ledger, and readiness must never assert otherwise.
export const OWNER_ONLY_TABLES = Object.freeze(["pgmigrations"]);

// The one function the runtime may execute — the narrow bridge that lets
// readiness report migration state without granting access to pgmigrations.
export const RUNTIME_FUNCTIONS = Object.freeze(["esdms_schema_migration_state(text)"]);
