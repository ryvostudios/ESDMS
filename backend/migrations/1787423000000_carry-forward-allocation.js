export const shorthands = undefined;

// Carry-forward allocation (corrective pass).
//
// Surfacing an unresolved prior requirement was already implemented, but a
// carried quantity left no claim against its source — so the SAME outstanding
// 40 metres could be carried into Demand A, Demand B and Demand C, and each
// would look legitimate. This makes the claim authoritative.
//
// Three genuinely distinct, non-overlapping sources of unresolved requirement:
//
//   UNPURCHASED_IPO_QUANTITY — approved and ordered, but Procurement closed
//                              purchasing having bought less than approved.
//   OUT_OF_BUDGET            — management excluded the line from the approved
//                              purchasing set, so it never reached an IPO.
//   RECEIVING_SHORTAGE       — purchased and delivered, but the department
//                              confirmed a short/damaged/rejected quantity.
//
// They cannot double-count by construction: the first two are quantities that
// were never purchased, the third is a quantity that WAS purchased and
// delivered but did not physically arrive intact.
//
// Allocation becomes authoritative at SUBMIT, not while drafting. That is
// deliberate: a reservation created merely because someone opened a form
// would either leak (abandoned drafts holding quantity forever) or need a
// lifetime/expiry mechanism this scale does not justify. Submitting is the
// moment the department actually commits to the request, and the availability
// check happens there, under a lock on the source.

const SOURCE_TYPES = ["UNPURCHASED_IPO_QUANTITY", "OUT_OF_BUDGET", "RECEIVING_SHORTAGE"];

export async function up(pgm) {
  // A Demand line may declare that part of what it asks for is carried
  // forward from a specific earlier source. Nullable throughout: an ordinary
  // new line declares nothing and behaves exactly as before.
  pgm.addColumns("material_demand_lines", {
    carry_forward_source_type: { type: "varchar(30)" },
    carry_forward_source_id: { type: "uuid" },
    carry_forward_quantity: { type: "numeric(12,2)" },
  });
  pgm.addConstraint("material_demand_lines", "material_demand_lines_carry_forward_check", {
    check: `
      (carry_forward_source_type IS NULL AND carry_forward_source_id IS NULL
        AND carry_forward_quantity IS NULL)
      OR
      (carry_forward_source_type IN (${SOURCE_TYPES.map((t) => `'${t}'`).join(", ")})
        AND carry_forward_source_id IS NOT NULL
        AND carry_forward_quantity > 0
        AND carry_forward_quantity <= requested_quantity
        AND carry_forward_quantity NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric))
    `,
  });
  pgm.createIndex("material_demand_lines", ["carry_forward_source_type", "carry_forward_source_id"]);

  pgm.createTable("carry_forward_allocations", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    source_type: { type: "varchar(30)", notNull: true },
    // Exactly one of these is set, matching source_type — a real foreign key
    // per source rather than an untyped polymorphic id, so a claim can never
    // reference a source that does not exist.
    source_ipo_line_id: { type: "uuid", references: "ipo_lines", onDelete: "RESTRICT" },
    source_disposition_id: {
      type: "uuid",
      references: "material_demand_line_dispositions",
      onDelete: "RESTRICT",
    },
    source_receipt_line_id: { type: "uuid", references: "material_receipt_lines", onDelete: "RESTRICT" },
    // Denormalized for scope filtering and for the per-source availability
    // index; both are copied from the source under the same lock.
    department_id: { type: "uuid", notNull: true, references: "departments", onDelete: "RESTRICT" },
    site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "RESTRICT" },
    source_quantity: { type: "numeric(12,2)", notNull: true },
    allocated_quantity: { type: "numeric(12,2)", notNull: true },
    target_demand_id: { type: "uuid", notNull: true },
    target_demand_line_id: { type: "uuid", notNull: true },
    status: { type: "varchar(20)", notNull: true, default: "ACTIVE" },
    released_at: { type: "timestamptz" },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("carry_forward_allocations", "carry_forward_allocations_target_line_fkey", {
    foreignKeys: {
      columns: ["target_demand_line_id", "target_demand_id"],
      references: "material_demand_lines(id, demand_id)",
      onDelete: "CASCADE",
    },
  });
  // One claim per carrying line — a line cannot quietly claim twice.
  pgm.addConstraint("carry_forward_allocations", "carry_forward_allocations_target_line_key", {
    unique: ["target_demand_line_id"],
  });
  pgm.addConstraint("carry_forward_allocations", "carry_forward_allocations_source_type_check", {
    check: `source_type IN (${SOURCE_TYPES.map((t) => `'${t}'`).join(", ")})`,
  });
  pgm.addConstraint("carry_forward_allocations", "carry_forward_allocations_source_check", {
    check: `
      (source_type = 'UNPURCHASED_IPO_QUANTITY' AND source_ipo_line_id IS NOT NULL
        AND source_disposition_id IS NULL AND source_receipt_line_id IS NULL)
      OR
      (source_type = 'OUT_OF_BUDGET' AND source_disposition_id IS NOT NULL
        AND source_ipo_line_id IS NULL AND source_receipt_line_id IS NULL)
      OR
      (source_type = 'RECEIVING_SHORTAGE' AND source_receipt_line_id IS NOT NULL
        AND source_ipo_line_id IS NULL AND source_disposition_id IS NULL)
    `,
  });
  pgm.addConstraint("carry_forward_allocations", "carry_forward_allocations_status_check", {
    check: `
      (status = 'ACTIVE' AND released_at IS NULL)
      OR
      (status = 'RELEASED' AND released_at IS NOT NULL)
    `,
  });
  pgm.addConstraint("carry_forward_allocations", "carry_forward_allocations_quantity_check", {
    check: `
      source_quantity > 0
      AND allocated_quantity > 0
      AND allocated_quantity <= source_quantity
      AND allocated_quantity NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
      AND source_quantity NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
    `,
  });
  pgm.createIndex("carry_forward_allocations", "source_ipo_line_id");
  pgm.createIndex("carry_forward_allocations", "source_disposition_id");
  pgm.createIndex("carry_forward_allocations", "source_receipt_line_id");
  pgm.createIndex("carry_forward_allocations", "target_demand_id");
  pgm.createIndex("carry_forward_allocations", ["department_id", "status"]);
  pgm.createIndex("carry_forward_allocations", "site_id");
  pgm.createIndex("carry_forward_allocations", "created_by_user_id");

  pgm.sql(`
    CREATE TRIGGER carry_forward_allocations_set_updated_at
    BEFORE UPDATE ON carry_forward_allocations
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  // Over-allocation is impossible below the service too. The source row is
  // locked FOR UPDATE first, so two Demands submitting simultaneously against
  // the same remaining 40 serialize rather than both passing the check.
  pgm.sql(`
    CREATE FUNCTION carry_forward_allocations_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      already numeric;
    BEGIN
      IF NEW.status <> 'ACTIVE' THEN
        RETURN NEW;
      END IF;

      -- Lock the authoritative source row for this claim.
      IF NEW.source_type = 'UNPURCHASED_IPO_QUANTITY' THEN
        PERFORM 1 FROM public.ipo_lines WHERE id = NEW.source_ipo_line_id FOR UPDATE;
      ELSIF NEW.source_type = 'OUT_OF_BUDGET' THEN
        PERFORM 1 FROM public.material_demand_line_dispositions
        WHERE id = NEW.source_disposition_id FOR UPDATE;
      ELSE
        PERFORM 1 FROM public.material_receipt_lines WHERE id = NEW.source_receipt_line_id FOR UPDATE;
      END IF;

      SELECT COALESCE(SUM(allocated_quantity), 0) INTO already
      FROM public.carry_forward_allocations
      WHERE status = 'ACTIVE'
        AND id <> NEW.id
        AND source_type = NEW.source_type
        AND source_ipo_line_id IS NOT DISTINCT FROM NEW.source_ipo_line_id
        AND source_disposition_id IS NOT DISTINCT FROM NEW.source_disposition_id
        AND source_receipt_line_id IS NOT DISTINCT FROM NEW.source_receipt_line_id;

      IF already + NEW.allocated_quantity > NEW.source_quantity THEN
        RAISE EXCEPTION 'carry-forward allocation exceeds the quantity still available from this source';
      END IF;

      RETURN NEW;
    END;
    $function$;

    REVOKE ALL ON FUNCTION carry_forward_allocations_guard() FROM PUBLIC;

    CREATE TRIGGER carry_forward_allocations_guard
    BEFORE INSERT OR UPDATE ON carry_forward_allocations
    FOR EACH ROW EXECUTE FUNCTION carry_forward_allocations_guard();
  `);

  // An allocation is a historical statement — "quantity X from source S went
  // into Demand D line L" — and the ledger is only worth having if that
  // statement cannot later be rewritten. The over-allocation guard above stops
  // a source being claimed twice; this stops a claim being quietly restated
  // afterwards, which would achieve the same thing one UPDATE later.
  //
  // Only the release lifecycle may ever move: status ACTIVE -> RELEASED and
  // released_at NULL -> a timestamp (plus updated_at, maintained by trigger).
  // Everything else is compared wholesale rather than column by column, so a
  // column added to this table in future is frozen by default instead of
  // silently escaping the rule.
  //
  // Release is itself a fact, so a RELEASED row is frozen entirely: it cannot
  // be reactivated and its release timestamp cannot be moved. Undoing an
  // allocation means releasing it and claiming again through the normal
  // workflow, which leaves both events readable.
  //
  // Named to sort before the other triggers on this table so it rejects an
  // illegitimate write before set_updated_at touches the row.
  pgm.sql(`
    CREATE FUNCTION carry_forward_allocations_forbid_history_change()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'carry-forward allocations are historical records and cannot be deleted';
      END IF;

      IF OLD.status <> 'ACTIVE' THEN
        RAISE EXCEPTION 'a released carry-forward allocation is immutable';
      END IF;

      IF NEW.status <> 'RELEASED' OR NEW.released_at IS NULL THEN
        RAISE EXCEPTION 'an active carry-forward allocation may only be released';
      END IF;

      IF (to_jsonb(NEW) - 'status' - 'released_at' - 'updated_at')
         IS DISTINCT FROM
         (to_jsonb(OLD) - 'status' - 'released_at' - 'updated_at') THEN
        RAISE EXCEPTION 'carry-forward allocation source, target and quantity are immutable';
      END IF;

      RETURN NEW;
    END;
    $function$;

    REVOKE ALL ON FUNCTION carry_forward_allocations_forbid_history_change() FROM PUBLIC;

    CREATE TRIGGER carry_forward_allocations_forbid_history_change
    BEFORE UPDATE OR DELETE ON carry_forward_allocations
    FOR EACH ROW EXECUTE FUNCTION carry_forward_allocations_forbid_history_change();
  `);

  pgm.sql("ALTER TABLE public.carry_forward_allocations ENABLE ROW LEVEL SECURITY;");
}

export async function down(pgm) {
  pgm.sql(`
    DO $block$
    BEGIN
      IF EXISTS (SELECT 1 FROM carry_forward_allocations) THEN
        RAISE EXCEPTION 'cannot downgrade: carry-forward allocations exist and their source linkage must not be destroyed';
      END IF;
    END;
    $block$;
  `);

  pgm.dropTable("carry_forward_allocations");
  pgm.sql("DROP FUNCTION IF EXISTS carry_forward_allocations_guard();");
  pgm.sql("DROP FUNCTION IF EXISTS carry_forward_allocations_forbid_history_change();");
  pgm.dropConstraint("material_demand_lines", "material_demand_lines_carry_forward_check");
  pgm.dropColumns("material_demand_lines", [
    "carry_forward_source_type",
    "carry_forward_source_id",
    "carry_forward_quantity",
  ]);
}
