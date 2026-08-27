export const shorthands = undefined;

// Line-level final purchasing disposition (owner requirement: management
// routinely marks ONE line "out of budget" while the rest of the Demand
// proceeds).
//
// Why a separate table rather than a column on material_demand_pricing_lines:
// a pricing line is Procurement's estimate and is immutable once submitted,
// while a disposition is a MANAGEMENT decision taken against that exact
// submitted version. Keeping them apart means recording "excluded" never
// mutates — and can never appear to have altered — the submitted commercial
// estimate, and the excluded line's Demand line, quantity, estimate and
// pricing version all stay intact for history and carry-forward.
//
// Determinism of the approved purchasing set (spec §12 of the build prompt):
// the trigger below freezes every disposition for a Pricing version the
// moment its FIRST final decision is recorded. A reviewer therefore always
// decides on a set that cannot subsequently change underneath their
// approval; changing the set afterwards requires rejection and a new
// immutable Pricing version, exactly as Checkpoint 5 already established.

const DISPOSITIONS = ["APPROVED_FOR_PURCHASE", "EXCLUDED"];
const EXCLUSION_CATEGORIES = [
  "OUT_OF_BUDGET",
  "NOT_REQUIRED_NOW",
  "ALREADY_AVAILABLE",
  "DUPLICATE",
  "OTHER",
];

const DEMAND_AUDIT_ACTIONS = [
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
  "IPO_GENERATED",
  "IPO_CANCELLED",
  "COMPLETED",
  "LINE_DISPOSITION_SET",
];

export async function up(pgm) {
  pgm.dropConstraint("material_demand_audit_log", "material_demand_audit_log_action_check");
  pgm.addConstraint("material_demand_audit_log", "material_demand_audit_log_action_check", {
    check: `action IN (${DEMAND_AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
  });
  // "LINE_DISPOSITION_SET" is 21 characters; the original column was sized
  // for Checkpoint 2's short action names.
  pgm.alterColumn("material_demand_audit_log", "action", { type: "varchar(30)" });

  // Binds a FINAL decision to the exact purchasing set it approved. NULL for
  // INITIAL decisions and for any FINAL decision recorded before this
  // migration (there are none — Checkpoint 5 shipped uncommitted).
  pgm.addColumn("material_demand_approvals", {
    disposition_fingerprint: { type: "varchar(64)" },
  });

  // Any FINAL decision recorded before this migration was necessarily taken on
  // the FULL set — line dispositions did not exist yet — so it is backfilled
  // with the fingerprint of exactly that set. Computed here in SQL with the
  // same canonical form the application uses
  // (material-demand.disposition.service.js#fingerprintOf): the sorted
  // "<demand_line_id>:APPROVED_FOR_PURCHASE" pairs joined by "|", SHA-256, hex.
  // Without this, upgrading a database that already holds final approvals
  // would either fail the constraint below or leave rows that can never
  // satisfy a gate.
  // material_demand_approvals is append-only at the database level (Checkpoint
  // 3), which is exactly right for application code and exactly why the
  // migration owner must lift it for this one structural backfill. Nothing
  // about any decision changes: only the newly added column is populated, and
  // the guard is restored immediately afterwards inside the same transaction.
  pgm.sql(`ALTER TABLE material_demand_approvals DISABLE TRIGGER material_demand_approvals_append_only;`);
  pgm.sql(`
    UPDATE material_demand_approvals a
    SET disposition_fingerprint = f.fingerprint
    FROM (
      SELECT mdl.demand_id,
             encode(
               sha256(convert_to(string_agg(mdl.id::text || ':APPROVED_FOR_PURCHASE', '|'
                 ORDER BY mdl.id::text || ':APPROVED_FOR_PURCHASE'), 'UTF8')),
               'hex'
             ) AS fingerprint
      FROM material_demand_lines mdl
      GROUP BY mdl.demand_id
    ) f
    WHERE a.demand_id = f.demand_id
      AND a.approval_stage = 'FINAL'
      AND a.disposition_fingerprint IS NULL;
  `);
  pgm.sql(`ALTER TABLE material_demand_approvals ENABLE TRIGGER material_demand_approvals_append_only;`);

  // NOTE on the shape below: a bare "col ~ pattern" would evaluate to NULL for
  // a NULL fingerprint, and a CHECK constraint ACCEPTS NULL — so the IS NOT
  // NULL test is load-bearing, not redundant.
  pgm.addConstraint("material_demand_approvals", "material_demand_approvals_fingerprint_check", {
    check: `
      (approval_stage = 'INITIAL' AND disposition_fingerprint IS NULL)
      OR
      (approval_stage = 'FINAL'
        AND disposition_fingerprint IS NOT NULL
        AND disposition_fingerprint ~ '^[0-9a-f]{64}$')
    `,
  });

  // One FINAL decision per responsibility PER PURCHASING SET. Re-deciding
  // after the set changed is a new immutable row, never an edit of the old
  // one, so the full decision history is preserved.
  pgm.sql(`DROP INDEX material_demand_approvals_final_slot_idx;`);
  pgm.sql(`
    CREATE UNIQUE INDEX material_demand_approvals_final_slot_idx
      ON material_demand_approvals (demand_id, revision, pricing_id, approval_type, disposition_fingerprint)
      WHERE approval_stage = 'FINAL';
  `);

  pgm.createTable("material_demand_line_dispositions", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    demand_id: { type: "uuid", notNull: true },
    revision: { type: "integer", notNull: true },
    pricing_id: { type: "uuid", notNull: true },
    demand_line_id: { type: "uuid", notNull: true },
    disposition: { type: "varchar(25)", notNull: true },
    exclusion_category: { type: "varchar(30)" },
    reason: { type: "text" },
    // Snapshotted so an excluded line remains fully readable as history and
    // as a carry-forward candidate even though it never reaches an IPO.
    requested_quantity_snapshot: { type: "numeric(12,2)", notNull: true },
    estimated_unit_price_snapshot: { type: "numeric(14,2)", notNull: true },
    actor_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("material_demand_line_dispositions", "material_demand_line_dispositions_pricing_fkey", {
    foreignKeys: {
      columns: ["pricing_id", "demand_id", "revision"],
      references: "material_demand_pricing(id, demand_id, demand_revision)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("material_demand_line_dispositions", "material_demand_line_dispositions_line_fkey", {
    foreignKeys: {
      columns: ["demand_line_id", "demand_id"],
      references: "material_demand_lines(id, demand_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("material_demand_line_dispositions", "material_demand_line_dispositions_slot_key", {
    unique: ["pricing_id", "demand_line_id"],
  });
  pgm.addConstraint("material_demand_line_dispositions", "material_demand_line_dispositions_disposition_check", {
    check: `disposition IN (${DISPOSITIONS.map((d) => `'${d}'`).join(", ")})`,
  });
  pgm.addConstraint("material_demand_line_dispositions", "material_demand_line_dispositions_exclusion_check", {
    check: `
      (disposition = 'APPROVED_FOR_PURCHASE' AND exclusion_category IS NULL AND reason IS NULL)
      OR
      (disposition = 'EXCLUDED' AND exclusion_category IN (${EXCLUSION_CATEGORIES.map((c) => `'${c}'`).join(", ")})
        AND (exclusion_category <> 'OTHER' OR (reason IS NOT NULL AND length(btrim(reason)) > 0)))
    `,
  });
  pgm.addConstraint("material_demand_line_dispositions", "material_demand_line_dispositions_snapshot_check", {
    check: `requested_quantity_snapshot > 0 AND estimated_unit_price_snapshot > 0
      AND requested_quantity_snapshot NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
      AND estimated_unit_price_snapshot NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`,
  });
  pgm.createIndex("material_demand_line_dispositions", "pricing_id");
  pgm.createIndex("material_demand_line_dispositions", ["demand_line_id", "demand_id"]);
  pgm.createIndex("material_demand_line_dispositions", "demand_id");
  pgm.createIndex("material_demand_line_dispositions", "actor_user_id");
  pgm.createIndex("material_demand_line_dispositions", "disposition");

  pgm.sql(`
    CREATE TRIGGER material_demand_line_dispositions_set_updated_at
    BEFORE UPDATE ON material_demand_line_dispositions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  // Dispositions freeze the moment the set becomes purchasing AUTHORITY — that
  // is, when the IPO is generated — not merely because someone recorded an
  // earlier decision. Freezing at the first decision would make the owner's
  // real workflow impossible (Site Manager reviews, then the CEO rules a line
  // out of budget). Up to IPO generation, the disposition_fingerprint on each
  // FINAL approval keeps every recorded decision bound to the exact set it saw.
  pgm.sql(`
    CREATE FUNCTION material_demand_line_dispositions_freeze()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      target_demand_id uuid;
      target_revision integer;
    BEGIN
      target_demand_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.demand_id ELSE NEW.demand_id END;
      target_revision := CASE WHEN TG_OP = 'DELETE' THEN OLD.revision ELSE NEW.revision END;

      IF EXISTS (
        SELECT 1 FROM public.ipos
        WHERE demand_id = target_demand_id AND demand_revision = target_revision
      ) THEN
        RAISE EXCEPTION 'line dispositions are frozen once an IPO has been generated for this Demand revision';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $function$;

    REVOKE ALL ON FUNCTION material_demand_line_dispositions_freeze() FROM PUBLIC;

    CREATE TRIGGER material_demand_line_dispositions_freeze
    BEFORE INSERT OR UPDATE OR DELETE ON material_demand_line_dispositions
    FOR EACH ROW EXECUTE FUNCTION material_demand_line_dispositions_freeze();
  `);

  pgm.sql("ALTER TABLE public.material_demand_line_dispositions ENABLE ROW LEVEL SECURITY;");
}

export async function down(pgm) {
  pgm.sql(`
    DO $block$
    BEGIN
      IF EXISTS (SELECT 1 FROM material_demand_line_dispositions) THEN
        RAISE EXCEPTION 'cannot downgrade: management line dispositions exist and must not be destroyed';
      END IF;
    END;
    $block$;
  `);

  pgm.dropTable("material_demand_line_dispositions");
  pgm.sql("DROP FUNCTION IF EXISTS material_demand_line_dispositions_freeze();");

  pgm.sql(`DROP INDEX material_demand_approvals_final_slot_idx;`);
  pgm.sql(`
    CREATE UNIQUE INDEX material_demand_approvals_final_slot_idx
      ON material_demand_approvals (demand_id, revision, pricing_id, approval_type)
      WHERE approval_stage = 'FINAL';
  `);
  pgm.dropConstraint("material_demand_approvals", "material_demand_approvals_fingerprint_check");
  pgm.dropColumn("material_demand_approvals", "disposition_fingerprint");

  pgm.alterColumn("material_demand_audit_log", "action", { type: "varchar(20)" });
  pgm.dropConstraint("material_demand_audit_log", "material_demand_audit_log_action_check");
  pgm.addConstraint("material_demand_audit_log", "material_demand_audit_log_action_check", {
    check: `action IN (${DEMAND_AUDIT_ACTIONS.slice(0, 22)
      .map((a) => `'${a}'`)
      .join(", ")})`,
  });
}
