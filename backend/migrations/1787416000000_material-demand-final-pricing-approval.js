export const shorthands = undefined;

// Checkpoint 5: the second approval gate and controlled repricing. Existing
// Checkpoint 3 decisions are preserved as INITIAL decisions; FINAL decisions
// are bound to one exact immutable submitted Pricing version. No IPO entity is
// created here — READY_FOR_IPO is deliberately only a workflow boundary.

const MATERIAL_DEMAND_STATUSES = [
  "DRAFT",
  "PENDING_INITIAL_REVIEW",
  "REJECTED",
  "READY_FOR_PRICING",
  "PENDING_FINAL_APPROVAL",
  "PRICING_REVISION_REQUIRED",
  "READY_FOR_IPO",
];

const AUDIT_ACTIONS = [
  "CREATE",
  "EDIT_DRAFT",
  "SUBMIT",
  "MANAGEMENT_REVIEW_APPROVED",
  "MANAGEMENT_REVIEW_REJECTED",
  "FORMAL_APPROVAL_APPROVED",
  "FORMAL_APPROVAL_REJECTED",
  "READY_FOR_PRICING",
  "PRICING_DRAFT_CREATED",
  "PRICING_DRAFT_SAVED",
  "PRICING_SUBMITTED",
  "PENDING_FINAL_APPROVAL",
  "FINAL_MANAGEMENT_APPROVED",
  "FINAL_MANAGEMENT_REJECTED",
  "FINAL_FORMAL_APPROVED",
  "FINAL_FORMAL_REJECTED",
  "PRICING_REVISION_REQUIRED",
  "PRICING_VERSION_CREATED",
  "READY_FOR_IPO",
];

export async function up(pgm) {
  pgm.dropConstraint("material_demands", "material_demands_status_check");
  pgm.addConstraint("material_demands", "material_demands_status_check", {
    check: `status IN (${MATERIAL_DEMAND_STATUSES.map((status) => `'${status}'`).join(", ")})`,
  });

  pgm.dropConstraint("material_demand_audit_log", "material_demand_audit_log_action_check");
  pgm.addConstraint("material_demand_audit_log", "material_demand_audit_log_action_check", {
    check: `action IN (${AUDIT_ACTIONS.map((action) => `'${action}'`).join(", ")})`,
  });

  // Checkpoint 4 guaranteed one header per Demand revision. All existing
  // headers are therefore Pricing Version 1.
  pgm.addColumn("material_demand_pricing", {
    version: { type: "integer", notNull: true, default: 1 },
  });
  pgm.addConstraint("material_demand_pricing", "material_demand_pricing_version_check", {
    check: "version > 0",
  });
  pgm.dropConstraint("material_demand_pricing", "material_demand_pricing_demand_revision_key");
  pgm.addConstraint("material_demand_pricing", "material_demand_pricing_demand_revision_version_key", {
    unique: ["demand_id", "demand_revision", "version"],
  });
  pgm.addConstraint("material_demand_pricing", "material_demand_pricing_id_demand_revision_key", {
    unique: ["id", "demand_id", "demand_revision"],
  });
  pgm.sql(`
    CREATE UNIQUE INDEX material_demand_pricing_one_draft_idx
      ON material_demand_pricing (demand_id, demand_revision)
      WHERE status = 'DRAFT';
  `);

  // Add the stage with a temporary default so prior approval rows are
  // backfilled without rewriting or recreating their immutable history.
  pgm.addColumn("material_demand_approvals", {
    approval_stage: { type: "varchar(10)", notNull: true, default: "INITIAL" },
    pricing_id: { type: "uuid" },
  });
  pgm.sql(`ALTER TABLE material_demand_approvals ALTER COLUMN approval_stage DROP DEFAULT;`);
  pgm.addConstraint("material_demand_approvals", "material_demand_approvals_stage_check", {
    check: "approval_stage IN ('INITIAL', 'FINAL')",
  });
  pgm.addConstraint("material_demand_approvals", "material_demand_approvals_stage_pricing_check", {
    check: `
      (approval_stage = 'INITIAL' AND pricing_id IS NULL)
      OR
      (approval_stage = 'FINAL' AND pricing_id IS NOT NULL)
    `,
  });
  pgm.addConstraint("material_demand_approvals", "material_demand_approvals_pricing_binding_fkey", {
    foreignKeys: {
      columns: ["pricing_id", "demand_id", "revision"],
      references: "material_demand_pricing(id, demand_id, demand_revision)",
      onDelete: "RESTRICT",
    },
  });
  pgm.dropConstraint("material_demand_approvals", "material_demand_approvals_slot_key");
  pgm.sql(`
    CREATE UNIQUE INDEX material_demand_approvals_initial_slot_idx
      ON material_demand_approvals (demand_id, revision, approval_type)
      WHERE approval_stage = 'INITIAL';

    CREATE UNIQUE INDEX material_demand_approvals_final_slot_idx
      ON material_demand_approvals (demand_id, revision, pricing_id, approval_type)
      WHERE approval_stage = 'FINAL';
  `);
  pgm.createIndex("material_demand_approvals", "pricing_id");
}

export async function down(pgm) {
  // A populated Checkpoint 5 downgrade would have to destroy FINAL decision
  // history and/or later immutable pricing versions to satisfy Checkpoint 4's
  // old uniqueness model. Refuse that destructive downgrade explicitly.
  pgm.sql(`
    DO $block$
    BEGIN
      IF EXISTS (SELECT 1 FROM material_demand_approvals WHERE approval_stage = 'FINAL')
         OR EXISTS (SELECT 1 FROM material_demand_pricing WHERE version > 1) THEN
        RAISE EXCEPTION 'cannot downgrade Checkpoint 5 while final approvals or repricing versions exist';
      END IF;
    END;
    $block$;
  `);

  pgm.dropIndex("material_demand_approvals", "pricing_id");
  pgm.sql(`DROP INDEX material_demand_approvals_final_slot_idx;`);
  pgm.sql(`DROP INDEX material_demand_approvals_initial_slot_idx;`);
  pgm.addConstraint("material_demand_approvals", "material_demand_approvals_slot_key", {
    unique: ["demand_id", "revision", "approval_type"],
  });
  pgm.dropConstraint("material_demand_approvals", "material_demand_approvals_pricing_binding_fkey");
  pgm.dropConstraint("material_demand_approvals", "material_demand_approvals_stage_pricing_check");
  pgm.dropConstraint("material_demand_approvals", "material_demand_approvals_stage_check");
  pgm.dropColumns("material_demand_approvals", ["pricing_id", "approval_stage"]);

  pgm.sql(`DROP INDEX material_demand_pricing_one_draft_idx;`);
  pgm.dropConstraint("material_demand_pricing", "material_demand_pricing_id_demand_revision_key");
  pgm.dropConstraint("material_demand_pricing", "material_demand_pricing_demand_revision_version_key");
  pgm.addConstraint("material_demand_pricing", "material_demand_pricing_demand_revision_key", {
    unique: ["demand_id", "demand_revision"],
  });
  pgm.dropConstraint("material_demand_pricing", "material_demand_pricing_version_check");
  pgm.dropColumn("material_demand_pricing", "version");

  pgm.dropConstraint("material_demand_audit_log", "material_demand_audit_log_action_check");
  pgm.addConstraint("material_demand_audit_log", "material_demand_audit_log_action_check", {
    check: `action IN ('CREATE', 'EDIT_DRAFT', 'SUBMIT', 'MANAGEMENT_REVIEW_APPROVED',
      'MANAGEMENT_REVIEW_REJECTED', 'FORMAL_APPROVAL_APPROVED',
      'FORMAL_APPROVAL_REJECTED', 'READY_FOR_PRICING',
      'PRICING_DRAFT_CREATED', 'PRICING_DRAFT_SAVED', 'PRICING_SUBMITTED',
      'PENDING_FINAL_APPROVAL')`,
  });

  pgm.dropConstraint("material_demands", "material_demands_status_check");
  pgm.addConstraint("material_demands", "material_demands_status_check", {
    check: `status IN ('DRAFT', 'PENDING_INITIAL_REVIEW', 'REJECTED',
      'READY_FOR_PRICING', 'PENDING_FINAL_APPROVAL')`,
  });
}
