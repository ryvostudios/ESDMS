export const shorthands = undefined;

// Extends the existing protected/forensic audit table (governance_audit_log,
// migration 1787404000000) to cover Workforce's sensitive events, rather
// than creating a second, parallel "protected audit" table — the original
// spec's Protected Security Audit list already groups user/permission
// events with "employee creation; employee transfers; compensation
// revisions; contract finalization; contract views/downloads; exports" as
// ONE audit concept. See docs/DECISIONS.md.
//
// No table-boundary work needed here (RLS/grants/policy already cover
// governance_audit_log) — this migration only widens its schema.
const NEW_ACTIONS = [
  "EMPLOYEE_CREATED",
  "EMPLOYEE_TRANSFERRED",
  "COMPENSATION_RECORDED",
  "CONTRACT_FINALIZED",
  "CONTRACT_AMENDED",
  "CONTRACT_VIEWED",
  "CONTRACT_DOWNLOADED",
  "HISTORY_REMOVED",
  "WORKFORCE_EXPORT_GENERATED",
  "WORKFORCE_BULK_EXPORT_GENERATED",
];

const EXISTING_ACTIONS = [
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
  pgm.addColumn("governance_audit_log", {
    target_employee_id: { type: "uuid", references: "employees", onDelete: "RESTRICT" },
    target_contract_id: { type: "uuid", references: "employee_contracts", onDelete: "RESTRICT" },
  });
  pgm.createIndex("governance_audit_log", "target_employee_id");

  pgm.dropConstraint("governance_audit_log", "governance_audit_log_action_check");
  pgm.addConstraint("governance_audit_log", "governance_audit_log_action_check", {
    check: `action IN (${[...EXISTING_ACTIONS, ...NEW_ACTIONS].map((a) => `'${a}'`).join(", ")})`,
  });
}

export async function down(pgm) {
  pgm.dropConstraint("governance_audit_log", "governance_audit_log_action_check");
  pgm.addConstraint("governance_audit_log", "governance_audit_log_action_check", {
    check: `action IN (${EXISTING_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
  });
  pgm.dropColumns("governance_audit_log", ["target_employee_id", "target_contract_id"]);
}
