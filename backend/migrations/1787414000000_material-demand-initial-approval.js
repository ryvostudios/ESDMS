export const shorthands = undefined;

// Checkpoint 3 of the Procurement & Material Receiving V1 build (see
// docs/PROCUREMENT_RECEIVING_SPEC.md). Adds the first approval gate:
// PENDING_INITIAL_REVIEW -> (Management Review + Formal Approval, both
// APPROVED) -> READY_FOR_PRICING, or either REJECTED -> REJECTED. No
// pricing, no IPO, no Delivery Challan, no Receiving, no stock.
//
// Reused patterns instead of new mechanisms:
//   - material_demand_approvals is append-only via the existing
//     forbid_update_delete() trigger (same function gate_pass_audit_log
//     and material_demand_audit_log already use) — approval history is
//     never editable, by anyone, including CEO.
//   - one row per (demand_id, revision, approval_type) — a UNIQUE
//     constraint makes "approve the same slot twice" a DB-level
//     impossibility, not just an application check, and gives concurrent
//     UM/CFO approval race-safety for free once combined with the
//     existing lockById row-lock pattern.
//   - revision is recorded on every approval row (not just read from the
//     current demand) so a future reopen/new-revision cannot cause an old
//     approval to silently appear to apply to a different Demand
//     revision.
//   - permission codes follow the existing `module.action` convention;
//     default role grants follow the already-corrected Material Catalog/
//     Material Demand pattern (no role's holding of one permission
//     implies a broader scope grant by itself).

const AUDIT_ACTIONS = [
  "CREATE",
  "EDIT_DRAFT",
  "SUBMIT",
  "MANAGEMENT_REVIEW_APPROVED",
  "MANAGEMENT_REVIEW_REJECTED",
  "FORMAL_APPROVAL_APPROVED",
  "FORMAL_APPROVAL_REJECTED",
  "READY_FOR_PRICING",
];

const MATERIAL_DEMAND_STATUSES = ["DRAFT", "PENDING_INITIAL_REVIEW", "REJECTED", "READY_FOR_PRICING"];

const PERMISSIONS = [
  ["demand.review", "Record the Management Review decision on a submitted Material Demand"],
  ["demand.approve", "Record the Formal/CFO Approval decision on a submitted Material Demand"],
  ["procurement.pricing", "Be notified of, and eventually act on, Demands ready for Procurement pricing (Checkpoint 4 defines the actual pricing workflow)"],
];

// No CFO role exists in ESDMS (see docs/PROCUREMENT_RECEIVING_SPEC.md /
// docs/DECISIONS.md) — Formal Approval authority is deliberately narrow
// (CEO only by default), delegable to a specific Upper Management user
// (the real CFO) via the existing per-user GRANT mechanism, the same
// pattern already established for users.create_um/manage_um and
// business_history.remove. UPPER_MANAGEMENT does not auto-receive
// demand.approve merely by holding the role.
//
// Management Review authority is broader (SITE_MANAGER/UPPER_MANAGEMENT/
// CEO — the roles that already exist to operate a site day-to-day) but
// deliberately excludes ADMIN: ADMIN is a system-administration role, not
// a line-management one, and holding it must not imply management
// authority over Demands. A specific ADMIN user who is also expected to
// review Demands gets demand.review via an explicit per-user GRANT, the
// same as anyone else.
//
// procurement.pricing has no dedicated role yet (Checkpoint 4 defines the
// actual pricing workflow and its real staff). It is intentionally NOT
// given to any role as a placeholder — not even ADMIN — so it stays a
// true capability: CEO retains it through the same exceptional-authority
// pattern used for demand.review/demand.approve, and real Procurement
// staff (including an ADMIN who is also a procurement officer) receive it
// only via an explicit per-user GRANT.
const ROLE_PERMISSIONS = {
  CEO: ["demand.review", "demand.approve", "procurement.pricing"],
  SITE_MANAGER: ["demand.review"],
  UPPER_MANAGEMENT: ["demand.review"],
};

export async function up(pgm) {
  // The original varchar(20) fit CREATE/EDIT_DRAFT/SUBMIT; the new
  // decision-outcome action codes below (e.g. "MANAGEMENT_REVIEW_APPROVED",
  // 26 chars) do not.
  pgm.alterColumn("material_demand_audit_log", "action", { type: "varchar(30)" });

  pgm.dropConstraint("material_demands", "material_demands_status_check");
  pgm.addConstraint("material_demands", "material_demands_status_check", {
    check: `status IN (${MATERIAL_DEMAND_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });

  pgm.dropConstraint("material_demand_audit_log", "material_demand_audit_log_action_check");
  pgm.addConstraint("material_demand_audit_log", "material_demand_audit_log_action_check", {
    check: `action IN (${AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
  });

  pgm.createTable("material_demand_approvals", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    demand_id: { type: "uuid", notNull: true, references: "material_demands", onDelete: "CASCADE" },
    revision: { type: "integer", notNull: true },
    approval_type: { type: "varchar(20)", notNull: true },
    decision: { type: "varchar(20)", notNull: true },
    actor_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    reason: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("material_demand_approvals", "material_demand_approvals_type_check", {
    check: "approval_type IN ('MANAGEMENT_REVIEW', 'FORMAL_APPROVAL')",
  });
  pgm.addConstraint("material_demand_approvals", "material_demand_approvals_decision_check", {
    check: "decision IN ('APPROVED', 'REJECTED')",
  });
  pgm.addConstraint("material_demand_approvals", "material_demand_approvals_revision_check", {
    check: "revision > 0",
  });
  // The DB-level guarantee behind "a reviewer must not be able to approve
  // the same slot twice" — first writer for a given (demand, revision,
  // stage) wins; every subsequent attempt fails at the database, not just
  // in application logic.
  pgm.addConstraint("material_demand_approvals", "material_demand_approvals_slot_key", {
    unique: ["demand_id", "revision", "approval_type"],
  });
  pgm.createIndex("material_demand_approvals", "demand_id");

  pgm.sql(`
    CREATE TRIGGER material_demand_approvals_append_only
    BEFORE UPDATE OR DELETE ON material_demand_approvals
    FOR EACH ROW
    EXECUTE FUNCTION forbid_update_delete();
  `);

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

  pgm.sql(`ALTER TABLE public.material_demand_approvals ENABLE ROW LEVEL SECURITY;`);
}

export async function down(pgm) {
  pgm.sql(`DELETE FROM user_permission_overrides WHERE permission_id IN (SELECT id FROM permissions WHERE code IN ('demand.review', 'demand.approve', 'procurement.pricing'));`);
  pgm.sql(`DELETE FROM permissions WHERE code IN ('demand.review', 'demand.approve', 'procurement.pricing');`);

  pgm.dropTable("material_demand_approvals");

  pgm.dropConstraint("material_demand_audit_log", "material_demand_audit_log_action_check");
  pgm.addConstraint("material_demand_audit_log", "material_demand_audit_log_action_check", {
    check: "action IN ('CREATE', 'EDIT_DRAFT', 'SUBMIT')",
  });

  pgm.dropConstraint("material_demands", "material_demands_status_check");
  pgm.addConstraint("material_demands", "material_demands_status_check", {
    check: "status IN ('DRAFT', 'PENDING_INITIAL_REVIEW')",
  });

  pgm.alterColumn("material_demand_audit_log", "action", { type: "varchar(20)" });
}
