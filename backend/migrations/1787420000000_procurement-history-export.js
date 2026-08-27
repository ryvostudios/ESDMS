export const shorthands = undefined;

// Checkpoint 8 — the only database change the history/document layer needs:
// one export capability for the Procurement & Material Receiving chain.
//
// PDFs (Demand List, IPO, Delivery Challan) are generated on demand from
// already-persisted authoritative data and are never stored, so they need no
// table of their own; every download re-checks permission and scope at
// request time (docs/SECURITY.md), which is exactly the property a stored,
// retrievable document would have had to re-establish anyway.
//
// Export authority NEVER widens data authority. Holding procurement.export
// lets a user export what they can already see; every commercial column is
// gated again, at query-projection level, on procurement.view_prices /
// procurement.purchase — matching the existing compensation.export precedent
// in Workforce reporting (docs/SECURITY.md §13).

const GOVERNANCE_AUDIT_ACTIONS = [
  "USER_CREATED",
  "USER_ROLE_CHANGED",
  "USER_ACTIVATED",
  "USER_DEACTIVATED",
  "PERMISSION_GRANTED",
  "PERMISSION_DENIED",
  "PERMISSION_OVERRIDE_REMOVED",
  "PRIVILEGE_ESCALATION_ATTEMPT",
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
  "WORKFORCE_BULK_IMPORT_COMPLETED",
  "EMPLOYEE_EXISTING_USER_LINKED",
  "USER_TEMP_PASSWORD_REGENERATED",
  // New: every Procurement/Receiving export is recorded in the same
  // append-only governance stream Workforce exports already use, with the
  // dataset, row count, whether pricing was included, and the filters
  // actually applied — so an export's scope is provable after the fact.
  "PROCUREMENT_EXPORT_GENERATED",
];

const PERMISSIONS = [
  [
    "procurement.export",
    "Export Demand, IPO, Delivery Challan and Receiving history to Excel within authorized scope",
  ],
];

const ROLE_PERMISSIONS = {
  CEO: ["procurement.export"],
  UPPER_MANAGEMENT: ["procurement.export"],
  SITE_MANAGER: ["procurement.export"],
  ADMIN: ["procurement.export"],
  TEAM_LEAD: ["procurement.export"],
};

export async function up(pgm) {
  pgm.dropConstraint("governance_audit_log", "governance_audit_log_action_check");
  pgm.addConstraint("governance_audit_log", "governance_audit_log_action_check", {
    check: `action IN (${GOVERNANCE_AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
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
}

export async function down(pgm) {
  pgm.sql("DELETE FROM governance_audit_log WHERE action = 'PROCUREMENT_EXPORT_GENERATED';");
  pgm.dropConstraint("governance_audit_log", "governance_audit_log_action_check");
  pgm.addConstraint("governance_audit_log", "governance_audit_log_action_check", {
    check: `action IN (${GOVERNANCE_AUDIT_ACTIONS.slice(0, -1)
      .map((a) => `'${a}'`)
      .join(", ")})`,
  });

  pgm.sql(`
    DELETE FROM user_permission_overrides
    WHERE permission_id IN (SELECT id FROM permissions WHERE code = 'procurement.export');
    DELETE FROM permissions WHERE code = 'procurement.export';
  `);
}
