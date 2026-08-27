export const shorthands = undefined;

// Checkpoint 6a of Procurement & Material Receiving V1 — the official IPO
// and Procurement purchasing (see docs/PROCUREMENT_RECEIVING_SPEC.md
// §15-§16, §30).
//
// Reused patterns instead of new mechanisms:
//   - numbering mirrors gate_pass_number_counters / material_demand_number_counters
//     exactly (year-keyed sequential counter, atomic INSERT .. ON CONFLICT
//     DO UPDATE .. RETURNING). document_number_counters generalizes that one
//     counter shape across IPO and (next migration) Delivery Challan rather
//     than adding one bespoke counter table per document type. Formatting is
//     data (document_number_settings), so prefix/suffix/padding are
//     configurable later without touching business logic or IPO identity.
//   - snapshot-plus-live-FK, exactly as material_demand_lines established:
//     an IPO line carries the item name/UOM/quantity/estimated price AS
//     APPROVED, so later master-data edits can never change what an IPO
//     historically authorized.
//   - composite FKs pin every child row to the exact parent it claims
//     (ipo_lines -> ipos AND -> the same Demand's lines; ipos -> the exact
//     approved Pricing version of the exact Demand revision).
//   - one append-only audit table for the whole supply-chain domain
//     (procurement_audit_log), using the existing forbid_update_delete()
//     trigger. IPO, Delivery Challan and Receiving are separate modules but
//     one physical purchasing chain: a single entity-tagged stream keyed by
//     ipo_id is what the traceability/history view actually reads, and it
//     is the same shape governance_audit_log already uses across Workforce
//     modules.
//
// Exactly-once IPO generation is a DATABASE guarantee, not a service
// convention: unique (demand_id, demand_revision). A replayed final
// approval can only ever conflict, never produce a second IPO.

const IPO_STATUSES = ["GENERATED", "ACKNOWLEDGED", "PURCHASING", "COMPLETED", "CANCELLED"];
const PURCHASE_STATUSES = ["NOT_PURCHASED", "PARTIALLY_PURCHASED", "PURCHASED"];

const AUDIT_ENTITY_TYPES = ["IPO", "DELIVERY_CHALLAN", "MATERIAL_RECEIPT"];

// One list for the whole supply-chain domain. Later migrations in this
// phase extend it rather than creating a second audit mechanism.
const AUDIT_ACTIONS = [
  "IPO_GENERATED",
  "IPO_ACKNOWLEDGED",
  "PURCHASE_RECORDED",
  "PURCHASING_CLOSED",
  "IPO_CANCELLED",
  "IPO_COMPLETED",
];

const MATERIAL_DEMAND_STATUSES = [
  "DRAFT",
  "PENDING_INITIAL_REVIEW",
  "REJECTED",
  "READY_FOR_PRICING",
  "PENDING_FINAL_APPROVAL",
  "PRICING_REVISION_REQUIRED",
  "READY_FOR_IPO",
  "IPO_GENERATED",
  "IPO_CANCELLED",
  "COMPLETED",
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
];

const PERMISSIONS = [
  ["ipo.view", "View official IPO records within authorized scope (no pricing implied)"],
  ["ipo.cancel", "Cancel an authorized IPO, preserving its number and history"],
  ["procurement.purchase", "Record actual purchasing against IPO lines and view actual purchase prices"],
];

// Deliberately conservative, matching the Checkpoint 3/4 precedent:
// procurement.purchase is CEO-only by default (real Procurement staff get an
// explicit per-user GRANT, exactly like procurement.pricing); ipo.cancel is
// CEO-only (no role implies authority to void a purchasing document);
// ipo.view is operational, so department/management roles receive it, but it
// carries no price visibility on its own — that stays with
// procurement.view_prices / procurement.purchase.
const ROLE_PERMISSIONS = {
  CEO: ["ipo.view", "ipo.cancel", "procurement.purchase"],
  UPPER_MANAGEMENT: ["ipo.view"],
  SITE_MANAGER: ["ipo.view"],
  TEAM_LEAD: ["ipo.view"],
  ADMIN: ["ipo.view"],
};

export async function up(pgm) {
  pgm.dropConstraint("material_demands", "material_demands_status_check");
  pgm.addConstraint("material_demands", "material_demands_status_check", {
    check: `status IN (${MATERIAL_DEMAND_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });

  pgm.dropConstraint("material_demand_audit_log", "material_demand_audit_log_action_check");
  pgm.addConstraint("material_demand_audit_log", "material_demand_audit_log_action_check", {
    check: `action IN (${DEMAND_AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
  });

  // --- Document numbering -------------------------------------------------
  // The smallest configurable model that satisfies "prefix/suffix/starting
  // number/format are eventually configurable" without a numbering engine:
  // formatting is one settings row per document type; issuance is the
  // existing atomic year-keyed counter. Changing the format later never
  // changes an already-issued number, because the formatted string is
  // persisted on the document itself.
  pgm.createTable("document_number_settings", {
    document_type: { type: "varchar(30)", primaryKey: true },
    prefix: { type: "varchar(10)", notNull: true },
    // The authentic E-Set reference format is ESET/2026/32, so the segment
    // separator is configuration too, not a hard-coded dash.
    separator: { type: "varchar(1)", notNull: true, default: "/" },
    suffix: { type: "varchar(10)", notNull: true, default: "" },
    pad_width: { type: "integer", notNull: true, default: 6 },
    // The next number a fresh year starts from. Changing it never rewrites
    // history and never lowers an existing year's counter.
    start_value: { type: "integer", notNull: true, default: 1 },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_by_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
  });
  pgm.addConstraint("document_number_settings", "document_number_settings_pad_width_check", {
    check: "pad_width BETWEEN 1 AND 12",
  });
  pgm.addConstraint("document_number_settings", "document_number_settings_start_value_check", {
    check: "start_value > 0",
  });
  pgm.addConstraint("document_number_settings", "document_number_settings_separator_check", {
    check: "separator IN ('/', '-', '.', '_')",
  });
  pgm.addConstraint("document_number_settings", "document_number_settings_prefix_check", {
    // Keeps a configured prefix/suffix inside the character set the rest of
    // the system treats as a safe document reference (filenames, exports).
    check: "prefix ~ '^[A-Z0-9-]{1,10}$' AND suffix ~ '^[A-Z0-9-]{0,10}$'",
  });
  pgm.createIndex("document_number_settings", "updated_by_user_id");

  pgm.createTable("document_number_counters", {
    document_type: { type: "varchar(30)", notNull: true },
    year: { type: "integer", notNull: true },
    last_value: { type: "integer", notNull: true, default: 0 },
  });
  pgm.addConstraint("document_number_counters", "document_number_counters_pkey", {
    primaryKey: ["document_type", "year"],
  });
  pgm.addConstraint("document_number_counters", "document_number_counters_last_value_check", {
    check: "last_value >= 0",
  });

  pgm.sql(`
    INSERT INTO document_number_settings (document_type, prefix, separator, suffix, pad_width, start_value)
    VALUES ('IPO', 'ESET', '/', '', 1, 1);
  `);

  // --- IPO ----------------------------------------------------------------
  pgm.createTable("ipos", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    ipo_number: { type: "varchar(40)", notNull: true, unique: true },
    demand_id: { type: "uuid", notNull: true, references: "material_demands", onDelete: "RESTRICT" },
    demand_revision: { type: "integer", notNull: true },
    pricing_id: { type: "uuid", notNull: true },
    // The exact line-level purchasing set this IPO was authorized from — the
    // same fingerprint both final approvals carried when the gate completed.
    // Stored rather than recomputed, because the Demand's current set can
    // legitimately move on afterwards; an issued IPO must keep pointing at the
    // authorization that actually produced it, forever.
    disposition_fingerprint: { type: "varchar(64)", notNull: true },
    site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "RESTRICT" },
    department_id: { type: "uuid", notNull: true, references: "departments", onDelete: "RESTRICT" },
    status: { type: "varchar(20)", notNull: true, default: "GENERATED" },
    currency: { type: "varchar(3)", notNull: true, default: "PKR" },
    // The approved commercial snapshot. Recomputing this from live pricing
    // later would let an upstream change silently restate an issued IPO.
    estimated_total: { type: "numeric(26,2)", notNull: true },
    generated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    generated_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    acknowledged_by_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    acknowledged_at: { type: "timestamptz" },
    // Explicit Procurement declaration that no further purchasing will
    // happen against this IPO — the resolution condition that lets any
    // outstanding approved quantity become traceable carry-forward instead
    // of an eternally open cycle (§23, §30).
    purchasing_closed_by_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    purchasing_closed_at: { type: "timestamptz" },
    completed_at: { type: "timestamptz" },
    cancelled_by_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    cancelled_at: { type: "timestamptz" },
    cancellation_category: { type: "varchar(30)" },
    cancellation_reason: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  // Exactly-once generation, enforced by the database.
  pgm.addConstraint("ipos", "ipos_demand_revision_key", { unique: ["demand_id", "demand_revision"] });
  // Site coherence, enforced relationally rather than trusted from the
  // service: an IPO physically cannot claim a site other than its Demand's,
  // and (below) a Delivery Challan cannot claim a site other than its IPO's.
  pgm.addConstraint("material_demands", "material_demands_id_site_id_key", { unique: ["id", "site_id"] });
  pgm.addConstraint("ipos", "ipos_demand_site_fkey", {
    foreignKeys: {
      columns: ["demand_id", "site_id"],
      references: "material_demands(id, site_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("ipos", "ipos_id_site_id_key", { unique: ["id", "site_id"] });
  pgm.addConstraint("ipos", "ipos_id_demand_id_key", { unique: ["id", "demand_id"] });
  pgm.addConstraint("ipos", "ipos_id_department_id_key", { unique: ["id", "department_id"] });
  pgm.addConstraint("ipos", "ipos_pricing_binding_fkey", {
    foreignKeys: {
      columns: ["pricing_id", "demand_id", "demand_revision"],
      references: "material_demand_pricing(id, demand_id, demand_revision)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("ipos", "ipos_status_check", {
    check: `status IN (${IPO_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });
  pgm.addConstraint("ipos", "ipos_currency_check", { check: "currency = 'PKR'" });
  // Same format the approval rows use (see the disposition migration), so the
  // two can never drift into incompatible representations.
  pgm.addConstraint("ipos", "ipos_disposition_fingerprint_check", {
    check: "disposition_fingerprint ~ '^[0-9a-f]{64}$'",
  });
  pgm.addConstraint("ipos", "ipos_revision_check", { check: "demand_revision > 0" });
  pgm.addConstraint("ipos", "ipos_estimated_total_check", {
    check: `estimated_total >= 0
      AND estimated_total NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`,
  });
  pgm.addConstraint("ipos", "ipos_acknowledgement_check", {
    check: "(acknowledged_by_user_id IS NULL) = (acknowledged_at IS NULL)",
  });
  pgm.addConstraint("ipos", "ipos_purchasing_closed_check", {
    check: "(purchasing_closed_by_user_id IS NULL) = (purchasing_closed_at IS NULL)",
  });
  pgm.addConstraint("ipos", "ipos_cancellation_check", {
    check: `
      (status <> 'CANCELLED' AND cancelled_by_user_id IS NULL AND cancelled_at IS NULL
        AND cancellation_reason IS NULL AND cancellation_category IS NULL)
      OR
      (status = 'CANCELLED' AND cancelled_by_user_id IS NOT NULL AND cancelled_at IS NOT NULL
        AND cancellation_reason IS NOT NULL)
    `,
  });
  // No authoritative E-Set cancellation-category list exists yet, so V1 uses
  // a small closed set and keeps the field optional; the free-text reason is
  // always required. Extending the set later is an additive constraint change
  // that cannot invalidate recorded history.
  pgm.addConstraint("ipos", "ipos_cancellation_category_check", {
    check: `cancellation_category IS NULL OR cancellation_category IN
      ('NO_LONGER_REQUIRED', 'BUDGET_WITHDRAWN', 'DUPLICATE', 'SUPPLIER_UNAVAILABLE', 'OTHER')`,
  });
  pgm.addConstraint("ipos", "ipos_completion_check", {
    check: "(status = 'COMPLETED') = (completed_at IS NOT NULL)",
  });
  pgm.createIndex("ipos", "demand_id");
  pgm.createIndex("ipos", "pricing_id");
  pgm.createIndex("ipos", "site_id");
  pgm.createIndex("ipos", "department_id");
  pgm.createIndex("ipos", "generated_by_user_id");
  pgm.createIndex("ipos", "acknowledged_by_user_id");
  pgm.createIndex("ipos", "purchasing_closed_by_user_id");
  pgm.createIndex("ipos", "cancelled_by_user_id");
  pgm.createIndex("ipos", "status");

  pgm.createTable("ipo_lines", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    ipo_id: { type: "uuid", notNull: true },
    // Denormalized only so both parent relationships are enforceable as
    // composite foreign keys.
    demand_id: { type: "uuid", notNull: true },
    demand_line_id: { type: "uuid", notNull: true },
    line_no: { type: "integer", notNull: true },
    // The physical item identity, snapshotted so Previous Purchase Price can
    // be looked up from actual purchasing history without walking a possibly
    // re-pointed department catalog entry.
    company_item_id: { type: "uuid", notNull: true, references: "company_items", onDelete: "RESTRICT" },
    item_name_snapshot: { type: "varchar(150)", notNull: true },
    uom_code_snapshot: { type: "varchar(20)", notNull: true },
    uom_name_snapshot: { type: "varchar(50)", notNull: true },
    approved_quantity: { type: "numeric(12,2)", notNull: true },
    estimated_unit_price: { type: "numeric(14,2)", notNull: true },
    // Maintained aggregate over ipo_purchase_events (below), kept on the line
    // so every scope/queue query stays a simple read. A trigger proves it can
    // never drift from the events it summarizes.
    purchased_quantity: { type: "numeric(12,2)", notNull: true, default: 0 },
    purchase_status: { type: "varchar(20)", notNull: true, default: "NOT_PURCHASED" },
    procurement_note: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("ipo_lines", "ipo_lines_ipo_demand_fkey", {
    foreignKeys: {
      columns: ["ipo_id", "demand_id"],
      references: "ipos(id, demand_id)",
      onDelete: "CASCADE",
    },
  });
  pgm.addConstraint("ipo_lines", "ipo_lines_demand_line_fkey", {
    foreignKeys: {
      columns: ["demand_line_id", "demand_id"],
      references: "material_demand_lines(id, demand_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("ipo_lines", "ipo_lines_ipo_demand_line_key", { unique: ["ipo_id", "demand_line_id"] });
  pgm.addConstraint("ipo_lines", "ipo_lines_ipo_line_no_key", { unique: ["ipo_id", "line_no"] });
  pgm.addConstraint("ipo_lines", "ipo_lines_id_ipo_id_key", { unique: ["id", "ipo_id"] });
  pgm.addConstraint("ipo_lines", "ipo_lines_quantity_check", {
    check: `approved_quantity > 0
      AND approved_quantity NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`,
  });
  pgm.addConstraint("ipo_lines", "ipo_lines_estimated_price_check", {
    check: `estimated_unit_price > 0
      AND estimated_unit_price NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`,
  });
  // Over-purchase is rejected by the database, not only by the service:
  // V1 permits no purchased quantity above the approved quantity (§11).
  // purchase_status is a stored derivation of the quantities; this proves it
  // can never drift from them.
  pgm.addConstraint("ipo_lines", "ipo_lines_purchase_state_check", {
    check: `
      (purchased_quantity = 0 AND purchase_status = 'NOT_PURCHASED')
      OR
      (purchased_quantity > 0 AND purchased_quantity < approved_quantity
        AND purchase_status = 'PARTIALLY_PURCHASED')
      OR
      (purchased_quantity = approved_quantity AND purchase_status = 'PURCHASED')
    `,
  });
  pgm.createIndex("ipo_lines", "ipo_id");
  pgm.createIndex("ipo_lines", ["demand_line_id", "demand_id"]);
  pgm.createIndex("ipo_lines", "demand_id");
  pgm.createIndex("ipo_lines", "company_item_id");

  // --- Purchase events ----------------------------------------------------
  // One IPO line is realistically bought more than once, at different prices:
  //   60 bags @ Rs 100, then 20 bags @ Rs 110.
  // A single cumulative quantity + "the" actual price cannot represent that
  // without silently destroying the first transaction, so each purchase is
  // its own immutable event and the line-level total is derived from them.
  pgm.createTable("ipo_purchase_events", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    ipo_id: { type: "uuid", notNull: true },
    ipo_line_id: { type: "uuid", notNull: true },
    quantity: { type: "numeric(12,2)", notNull: true },
    actual_unit_price: { type: "numeric(14,2)", notNull: true },
    // A correction reverses one SPECIFIC earlier purchase, and inherits that
    // purchase's price. Without this link a negative event would be a free-
    // floating "purchase at any price I like", and reversing 60 bought at 100
    // with -60 at 1 would leave 5,940 of value behind on a line that was
    // fully undone.
    reverses_purchase_event_id: { type: "uuid" },
    // For a reversal this is the required correction reason.
    procurement_note: { type: "text" },
    purchased_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    purchased_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    // Client-supplied, stable per logical operation. A retried HTTP request
    // carries the same value, so a lost response can never book a second
    // real purchase (see the unique index below).
    operation_id: { type: "uuid", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("ipo_purchase_events", "ipo_purchase_events_line_fkey", {
    foreignKeys: {
      columns: ["ipo_line_id", "ipo_id"],
      references: "ipo_lines(id, ipo_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("ipo_purchase_events", "ipo_purchase_events_id_line_key", {
    unique: ["id", "ipo_line_id"],
  });
  // Composite, so a reversal is structurally incapable of reaching a purchase
  // on another IPO line — and therefore on another IPO, since a line belongs
  // to exactly one. Cross-context reversal is impossible, not merely checked.
  pgm.addConstraint("ipo_purchase_events", "ipo_purchase_events_reversal_line_fkey", {
    foreignKeys: {
      columns: ["reverses_purchase_event_id", "ipo_line_id"],
      references: "ipo_purchase_events(id, ipo_line_id)",
      onDelete: "RESTRICT",
    },
  });
  // One event per LINE per operation. A single purchasing operation
  // legitimately books several lines at once, so uniqueness cannot be on the
  // operation alone; a replay of that whole operation still collides on every
  // one of its rows, which is exactly the protection needed.
  pgm.addConstraint("ipo_purchase_events", "ipo_purchase_events_operation_line_key", {
    unique: ["operation_id", "ipo_line_id"],
  });
  // Positive = a purchase, which stands alone. Negative = a correction, which
  // must name the exact purchase it reverses. The two shapes are mutually
  // exclusive, so a negative event can never be a free-standing "purchase" and
  // a positive one can never masquerade as a correction.
  pgm.addConstraint("ipo_purchase_events", "ipo_purchase_events_quantity_check", {
    check: `quantity <> 0
      AND quantity NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`,
  });
  pgm.addConstraint("ipo_purchase_events", "ipo_purchase_events_reversal_shape_check", {
    check: `
      (quantity > 0 AND reverses_purchase_event_id IS NULL)
      OR
      (quantity < 0 AND reverses_purchase_event_id IS NOT NULL
        AND procurement_note IS NOT NULL AND length(btrim(procurement_note)) > 0)
    `,
  });
  pgm.addConstraint("ipo_purchase_events", "ipo_purchase_events_no_self_reversal_check", {
    check: "reverses_purchase_event_id IS NULL OR reverses_purchase_event_id <> id",
  });
  pgm.addConstraint("ipo_purchase_events", "ipo_purchase_events_price_check", {
    check: `actual_unit_price > 0
      AND actual_unit_price NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`,
  });
  pgm.createIndex("ipo_purchase_events", "ipo_id");
  pgm.createIndex("ipo_purchase_events", "operation_id");
  pgm.createIndex("ipo_purchase_events", ["ipo_line_id", "ipo_id"]);
  pgm.createIndex("ipo_purchase_events", "purchased_by_user_id");
  // Previous Actual Price: newest purchase event for a physical item.
  pgm.createIndex("ipo_purchase_events", ["ipo_line_id", "purchased_at"]);
  pgm.createIndex("ipo_purchase_events", "reverses_purchase_event_id");

  // A recorded purchase is a financial fact: never edited, never deleted.
  pgm.sql(`
    CREATE TRIGGER ipo_purchase_events_append_only
    BEFORE UPDATE OR DELETE ON ipo_purchase_events
    FOR EACH ROW
    EXECUTE FUNCTION forbid_update_delete();
  `);

  // A reversal is bounded by the purchase it reverses, and inherits its price.
  //
  // Both rules have to live here as well as in the service: the price rule is
  // what stops "-60 @ 1" silently leaving 5,940 of value on a fully undone
  // line, and the quantity rule is aggregate logic over sibling rows, so it
  // cannot be expressed as a row CHECK. Locking the original row first is what
  // makes it safe under concurrency — two reversals of the same purchase
  // serialize instead of both seeing the same remaining balance.
  pgm.sql(`
    CREATE FUNCTION ipo_purchase_events_reversal_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      original_quantity numeric;
      original_price numeric;
      original_is_reversal boolean;
      already_reversed numeric;
    BEGIN
      IF NEW.reverses_purchase_event_id IS NULL THEN
        RETURN NEW;
      END IF;

      SELECT quantity, actual_unit_price, reverses_purchase_event_id IS NOT NULL
        INTO original_quantity, original_price, original_is_reversal
      FROM public.ipo_purchase_events
      WHERE id = NEW.reverses_purchase_event_id
      FOR UPDATE;

      IF NOT FOUND THEN
        RAISE EXCEPTION 'a reversal must reference an existing purchase event';
      END IF;
      IF original_is_reversal OR original_quantity <= 0 THEN
        RAISE EXCEPTION 'a reversal may only reference an original purchase, never another reversal';
      END IF;
      IF NEW.actual_unit_price <> original_price THEN
        RAISE EXCEPTION 'a reversal must carry the price of the purchase it reverses (%, not %)',
          original_price, NEW.actual_unit_price;
      END IF;

      SELECT COALESCE(SUM(-quantity), 0) INTO already_reversed
      FROM public.ipo_purchase_events
      WHERE reverses_purchase_event_id = NEW.reverses_purchase_event_id
        AND id <> NEW.id;

      IF already_reversed + (-NEW.quantity) > original_quantity THEN
        RAISE EXCEPTION 'reversing % exceeds the % originally purchased in that event (% already reversed)',
          -NEW.quantity, original_quantity, already_reversed;
      END IF;

      RETURN NEW;
    END;
    $function$;

    REVOKE ALL ON FUNCTION ipo_purchase_events_reversal_guard() FROM PUBLIC;

    CREATE TRIGGER ipo_purchase_events_reversal_guard
    BEFORE INSERT ON ipo_purchase_events
    FOR EACH ROW
    EXECUTE FUNCTION ipo_purchase_events_reversal_guard();
  `);

  // The line-level aggregate can never drift from the events it summarizes,
  // regardless of which writer moved it.
  pgm.sql(`
    CREATE FUNCTION ipo_lines_purchased_quantity_matches_events()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      event_total numeric;
    BEGIN
      SELECT COALESCE(SUM(quantity), 0) INTO event_total
      FROM public.ipo_purchase_events WHERE ipo_line_id = NEW.id;

      IF NEW.purchased_quantity <> event_total THEN
        RAISE EXCEPTION 'purchased quantity (%) must equal the sum of recorded purchase events (%)',
          NEW.purchased_quantity, event_total;
      END IF;
      RETURN NEW;
    END;
    $function$;

    REVOKE ALL ON FUNCTION ipo_lines_purchased_quantity_matches_events() FROM PUBLIC;

    CREATE CONSTRAINT TRIGGER ipo_lines_purchased_quantity_matches_events
    AFTER UPDATE OF purchased_quantity ON ipo_lines
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW
    EXECUTE FUNCTION ipo_lines_purchased_quantity_matches_events();
  `);

  // --- Supply-chain audit -------------------------------------------------
  pgm.createTable("procurement_audit_log", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    // Every row belongs to one purchasing chain, so the whole IPO -> DC ->
    // Receiving history is one indexed, ordered read.
    ipo_id: { type: "uuid", notNull: true, references: "ipos", onDelete: "RESTRICT" },
    entity_type: { type: "varchar(20)", notNull: true },
    entity_id: { type: "uuid", notNull: true },
    actor_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    action: { type: "varchar(40)", notNull: true },
    previous_status: { type: "varchar(40)" },
    new_status: { type: "varchar(40)" },
    metadata: { type: "jsonb" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });
  pgm.addConstraint("procurement_audit_log", "procurement_audit_log_entity_type_check", {
    check: `entity_type IN (${AUDIT_ENTITY_TYPES.map((t) => `'${t}'`).join(", ")})`,
  });
  pgm.addConstraint("procurement_audit_log", "procurement_audit_log_action_check", {
    check: `action IN (${AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
  });
  pgm.createIndex("procurement_audit_log", "ipo_id");
  pgm.createIndex("procurement_audit_log", ["entity_type", "entity_id"]);
  pgm.createIndex("procurement_audit_log", "actor_user_id");
  pgm.createIndex("procurement_audit_log", "created_at");
  pgm.sql(`
    CREATE TRIGGER procurement_audit_log_append_only
    BEFORE UPDATE OR DELETE ON procurement_audit_log
    FOR EACH ROW
    EXECUTE FUNCTION forbid_update_delete();
  `);

  pgm.sql(`
    CREATE TRIGGER ipos_set_updated_at
    BEFORE UPDATE ON ipos
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TRIGGER ipo_lines_set_updated_at
    BEFORE UPDATE ON ipo_lines
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  // Defense in depth below the service: an issued IPO's identity and its
  // approved commercial snapshot are immutable, and no IPO or IPO line is
  // ever physically deleted (cancellation preserves both, and the number
  // stays consumed).
  pgm.sql(`
    CREATE FUNCTION ipos_forbid_snapshot_change()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'an issued IPO cannot be deleted';
      END IF;
      IF NEW.ipo_number IS DISTINCT FROM OLD.ipo_number
         OR NEW.demand_id IS DISTINCT FROM OLD.demand_id
         OR NEW.demand_revision IS DISTINCT FROM OLD.demand_revision
         OR NEW.pricing_id IS DISTINCT FROM OLD.pricing_id
         OR NEW.disposition_fingerprint IS DISTINCT FROM OLD.disposition_fingerprint
         OR NEW.site_id IS DISTINCT FROM OLD.site_id
         OR NEW.department_id IS DISTINCT FROM OLD.department_id
         OR NEW.currency IS DISTINCT FROM OLD.currency
         OR NEW.estimated_total IS DISTINCT FROM OLD.estimated_total
         OR NEW.generated_at IS DISTINCT FROM OLD.generated_at
         OR NEW.generated_by_user_id IS DISTINCT FROM OLD.generated_by_user_id THEN
        RAISE EXCEPTION 'the approved IPO snapshot is immutable';
      END IF;
      IF OLD.status = 'CANCELLED' AND NEW.status <> 'CANCELLED' THEN
        RAISE EXCEPTION 'a cancelled IPO cannot be reopened';
      END IF;
      RETURN NEW;
    END;
    $function$;

    CREATE FUNCTION ipo_lines_forbid_snapshot_change()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'an issued IPO line cannot be deleted';
      END IF;
      IF NEW.ipo_id IS DISTINCT FROM OLD.ipo_id
         OR NEW.demand_id IS DISTINCT FROM OLD.demand_id
         OR NEW.demand_line_id IS DISTINCT FROM OLD.demand_line_id
         OR NEW.line_no IS DISTINCT FROM OLD.line_no
         OR NEW.company_item_id IS DISTINCT FROM OLD.company_item_id
         OR NEW.item_name_snapshot IS DISTINCT FROM OLD.item_name_snapshot
         OR NEW.uom_code_snapshot IS DISTINCT FROM OLD.uom_code_snapshot
         OR NEW.uom_name_snapshot IS DISTINCT FROM OLD.uom_name_snapshot
         OR NEW.approved_quantity IS DISTINCT FROM OLD.approved_quantity
         OR NEW.estimated_unit_price IS DISTINCT FROM OLD.estimated_unit_price THEN
        RAISE EXCEPTION 'the approved IPO line snapshot is immutable';
      END IF;

      -- Once Procurement formally closes purchasing, the recorded purchasing
      -- facts become history. Service-layer refusal is not enough for a
      -- financial record: block it here too, for every writer.
      IF EXISTS (SELECT 1 FROM public.ipos WHERE id = OLD.ipo_id AND purchasing_closed_at IS NOT NULL) THEN
        IF NEW.purchased_quantity IS DISTINCT FROM OLD.purchased_quantity
           OR NEW.purchase_status IS DISTINCT FROM OLD.purchase_status
           OR NEW.procurement_note IS DISTINCT FROM OLD.procurement_note THEN
          RAISE EXCEPTION 'purchasing facts are frozen once purchasing has been closed';
        END IF;
      END IF;

      RETURN NEW;
    END;
    $function$;

    REVOKE ALL ON FUNCTION ipos_forbid_snapshot_change() FROM PUBLIC;
    REVOKE ALL ON FUNCTION ipo_lines_forbid_snapshot_change() FROM PUBLIC;

    CREATE TRIGGER ipos_forbid_snapshot_change
    BEFORE UPDATE OR DELETE ON ipos
    FOR EACH ROW EXECUTE FUNCTION ipos_forbid_snapshot_change();

    CREATE TRIGGER ipo_lines_forbid_snapshot_change
    BEFORE UPDATE OR DELETE ON ipo_lines
    FOR EACH ROW EXECUTE FUNCTION ipo_lines_forbid_snapshot_change();
  `);

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

  for (const table of [
    "document_number_settings",
    "document_number_counters",
    "ipos",
    "ipo_lines",
    "ipo_purchase_events",
    "procurement_audit_log",
  ]) {
    pgm.sql(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
  }
}

export async function down(pgm) {
  pgm.sql(`
    DO $block$
    BEGIN
      IF EXISTS (SELECT 1 FROM ipos) THEN
        RAISE EXCEPTION 'cannot downgrade: issued IPOs exist and their numbers must never be released';
      END IF;
    END;
    $block$;
  `);

  pgm.sql(`
    DELETE FROM user_permission_overrides
    WHERE permission_id IN (SELECT id FROM permissions WHERE code IN ('ipo.view', 'ipo.cancel', 'procurement.purchase'));
    DELETE FROM permissions WHERE code IN ('ipo.view', 'ipo.cancel', 'procurement.purchase');
  `);

  pgm.dropTable("procurement_audit_log");
  pgm.dropTable("ipo_purchase_events");
  pgm.dropTable("ipo_lines");
  pgm.dropTable("ipos");
  pgm.dropTable("document_number_counters");
  pgm.dropTable("document_number_settings");
  pgm.sql(`
    DROP FUNCTION IF EXISTS ipo_purchase_events_reversal_guard();
    DROP FUNCTION IF EXISTS ipo_lines_purchased_quantity_matches_events();
    DROP FUNCTION IF EXISTS ipo_lines_forbid_snapshot_change();
    DROP FUNCTION IF EXISTS ipos_forbid_snapshot_change();
  `);
  pgm.dropConstraint("material_demands", "material_demands_id_site_id_key");

  pgm.dropConstraint("material_demand_audit_log", "material_demand_audit_log_action_check");
  pgm.addConstraint("material_demand_audit_log", "material_demand_audit_log_action_check", {
    check: `action IN (${DEMAND_AUDIT_ACTIONS.slice(0, 19)
      .map((a) => `'${a}'`)
      .join(", ")})`,
  });

  pgm.dropConstraint("material_demands", "material_demands_status_check");
  pgm.addConstraint("material_demands", "material_demands_status_check", {
    check: `status IN (${MATERIAL_DEMAND_STATUSES.slice(0, 7)
      .map((s) => `'${s}'`)
      .join(", ")})`,
  });
}
