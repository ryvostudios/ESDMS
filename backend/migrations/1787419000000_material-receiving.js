export const shorthands = undefined;

// Checkpoint 7 — Material Receiving, department confirmation, and Admin
// fallback custody/handover (see docs/PROCUREMENT_RECEIVING_SPEC.md
// §19-§24, §30).
//
// This records WHAT PHYSICALLY ARRIVED. It is deliberately NOT inventory:
// no stock balance, ledger, batch, FIFO, issue, usage or return table is
// created here or anywhere in this phase (§24). Nothing in this schema can
// answer "how much is in stock today", because ESDMS does not yet know what
// was consumed.
//
// Two receiving paths share one table, because they are the same physical
// event with different custody:
//   DEPARTMENT      — an appropriate member of the owning department
//                     receives directly. No Admin involvement at all.
//   ADMIN_FALLBACK  — nobody from the department was available; Admin takes
//                     temporary custody, then hands over. The original
//                     receiver is NEVER rewritten by the handover: both the
//                     Admin receiver and the eventual department recipient
//                     are preserved as separate columns and separate audit
//                     events.

const RECEIPT_STATUSES = ["AWAITING_HANDOVER", "PENDING_CONFIRMATION", "COMPLETED"];
const RECEIPT_TYPES = ["DEPARTMENT", "ADMIN_FALLBACK"];
const DISCREPANCY_TYPES = ["SHORT", "DAMAGED", "WRONG_SPEC", "REJECTED"];

const AUDIT_ACTIONS = [
  "IPO_GENERATED",
  "IPO_ACKNOWLEDGED",
  "PURCHASE_RECORDED",
  "PURCHASING_CLOSED",
  "IPO_CANCELLED",
  "IPO_COMPLETED",
  "DC_CREATED",
  "DC_UPDATED",
  "DC_FINALIZED",
  "DC_CANCELLED",
  "DC_COMPLETED",
  "RECEIPT_RECORDED",
  "ADMIN_CUSTODY_RECORDED",
  "RECEIPT_DISCREPANCY",
  "HANDOVER_COMPLETED",
  "RECEIPT_CONFIRMED",
];

const PERMISSIONS = [
  ["receiving.view", "View Delivery Challan receiving records within authorized scope"],
  ["receiving.receive", "Record physical receipt of the actor's own department's material"],
  [
    "receiving.fallback_receive",
    "Take temporary Admin custody of another department's material at the actor's own site",
  ],
  ["receiving.confirm", "Confirm and close a department receiving cycle"],
];

// The owner's rule, encoded: any appropriate active EMPLOYEE of the owning
// department may physically receive that department's material, so EMPLOYEE
// holds receiving.receive by default and needs no Admin approval. Only
// TEAM_LEAD (and CEO) close the cycle. receiving.fallback_receive is ADMIN's
// alone by default and is what makes cross-department temporary custody
// possible at all — ordinary receiving.receive never crosses a department
// boundary. HR and GATE_GUARD receive nothing.
const ROLE_PERMISSIONS = {
  CEO: ["receiving.view", "receiving.receive", "receiving.fallback_receive", "receiving.confirm"],
  ADMIN: ["receiving.view", "receiving.fallback_receive"],
  SITE_MANAGER: ["receiving.view", "receiving.confirm"],
  UPPER_MANAGEMENT: ["receiving.view"],
  TEAM_LEAD: ["receiving.view", "receiving.receive", "receiving.confirm"],
  EMPLOYEE: ["receiving.view", "receiving.receive"],
};

export async function up(pgm) {
  pgm.dropConstraint("procurement_audit_log", "procurement_audit_log_action_check");
  pgm.addConstraint("procurement_audit_log", "procurement_audit_log_action_check", {
    check: `action IN (${AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
  });

  // Lets a receipt prove, by composite FK, that the department it claims is
  // the department the Delivery Challan was actually cut for.
  pgm.addConstraint("delivery_challans", "delivery_challans_id_department_id_key", {
    unique: ["id", "department_id"],
  });

  pgm.createTable("material_receipts", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    dc_id: { type: "uuid", notNull: true },
    ipo_id: { type: "uuid", notNull: true },
    // The INTENDED owning department — never the Admin receiver's own.
    department_id: { type: "uuid", notNull: true },
    site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "RESTRICT" },
    receipt_type: { type: "varchar(20)", notNull: true },
    status: { type: "varchar(30)", notNull: true },
    // Client-supplied, stable per logical receipt. A retried request carries
    // the same value, so a lost HTTP response can never book the same
    // physical delivery twice; a genuinely separate partial receipt carries a
    // different one.
    operation_id: { type: "uuid", notNull: true },
    // The authenticated application user who recorded the receipt. Never
    // rewritten, including after an Admin handover.
    received_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    // Optional: the real physical receiver when that person has no login
    // account of their own (Employee != User stays intact — this records
    // who physically took the material, it never forges the actor).
    physical_receiver_employee_id: { type: "uuid", references: "employees", onDelete: "RESTRICT" },
    received_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    handover_to_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    handover_at: { type: "timestamptz" },
    confirmed_by_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    confirmed_at: { type: "timestamptz" },
    has_discrepancy: { type: "boolean", notNull: true, default: false },
    note: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("material_receipts", "material_receipts_dc_ipo_fkey", {
    foreignKeys: {
      columns: ["dc_id", "ipo_id"],
      references: "delivery_challans(id, ipo_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("material_receipts", "material_receipts_dc_department_fkey", {
    foreignKeys: {
      columns: ["dc_id", "department_id"],
      references: "delivery_challans(id, department_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("material_receipts", "material_receipts_id_dc_id_key", { unique: ["id", "dc_id"] });
  pgm.addConstraint("material_receipts", "material_receipts_operation_key", { unique: ["operation_id"] });
  // Site coherence: a receipt cannot claim a site other than its challan's.
  pgm.addConstraint("material_receipts", "material_receipts_dc_site_fkey", {
    foreignKeys: {
      columns: ["dc_id", "site_id"],
      references: "delivery_challans(id, site_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("material_receipts", "material_receipts_type_check", {
    check: `receipt_type IN (${RECEIPT_TYPES.map((t) => `'${t}'`).join(", ")})`,
  });
  pgm.addConstraint("material_receipts", "material_receipts_status_check", {
    check: `status IN (${RECEIPT_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });
  // A direct department receipt never has a handover; an Admin fallback
  // receipt is AWAITING_HANDOVER exactly while it has none, and carries both
  // handover columns for good once it does.
  pgm.addConstraint("material_receipts", "material_receipts_custody_check", {
    check: `
      (receipt_type = 'DEPARTMENT'
        AND status <> 'AWAITING_HANDOVER'
        AND handover_to_user_id IS NULL AND handover_at IS NULL)
      OR
      (receipt_type = 'ADMIN_FALLBACK'
        AND (
          (status = 'AWAITING_HANDOVER' AND handover_to_user_id IS NULL AND handover_at IS NULL)
          OR
          (status <> 'AWAITING_HANDOVER' AND handover_to_user_id IS NOT NULL AND handover_at IS NOT NULL)
        ))
    `,
  });
  pgm.addConstraint("material_receipts", "material_receipts_confirmation_check", {
    check: `
      (status = 'COMPLETED' AND confirmed_by_user_id IS NOT NULL AND confirmed_at IS NOT NULL)
      OR
      (status <> 'COMPLETED' AND confirmed_by_user_id IS NULL AND confirmed_at IS NULL)
    `,
  });
  pgm.createIndex("material_receipts", "dc_id");
  pgm.createIndex("material_receipts", "ipo_id");
  pgm.createIndex("material_receipts", "department_id");
  pgm.createIndex("material_receipts", "site_id");
  pgm.createIndex("material_receipts", "status");
  pgm.createIndex("material_receipts", "received_by_user_id");
  pgm.createIndex("material_receipts", "physical_receiver_employee_id");
  pgm.createIndex("material_receipts", "handover_to_user_id");
  pgm.createIndex("material_receipts", "confirmed_by_user_id");

  pgm.createTable("material_receipt_lines", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    receipt_id: { type: "uuid", notNull: true },
    dc_id: { type: "uuid", notNull: true },
    dc_line_id: { type: "uuid", notNull: true },
    line_no: { type: "integer", notNull: true },
    item_name_snapshot: { type: "varchar(150)", notNull: true },
    uom_code_snapshot: { type: "varchar(20)", notNull: true },
    uom_name_snapshot: { type: "varchar(50)", notNull: true },
    // The DC line's own quantity at the moment of receipt, so the four
    // numbers (DC / received / discrepancy / outstanding) stay independently
    // readable forever without recomputing from mutable parents.
    dc_quantity: { type: "numeric(12,2)", notNull: true },
    received_quantity: { type: "numeric(12,2)", notNull: true },
    discrepancy_quantity: { type: "numeric(12,2)", notNull: true, default: 0 },
    discrepancy_type: { type: "varchar(20)" },
    discrepancy_note: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("material_receipt_lines", "material_receipt_lines_receipt_dc_fkey", {
    foreignKeys: {
      columns: ["receipt_id", "dc_id"],
      references: "material_receipts(id, dc_id)",
      onDelete: "CASCADE",
    },
  });
  pgm.addConstraint("material_receipt_lines", "material_receipt_lines_dc_line_fkey", {
    foreignKeys: {
      columns: ["dc_line_id", "dc_id"],
      references: "delivery_challan_lines(id, dc_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("material_receipt_lines", "material_receipt_lines_receipt_line_key", {
    unique: ["receipt_id", "dc_line_id"],
  });
  pgm.addConstraint("material_receipt_lines", "material_receipt_lines_receipt_line_no_key", {
    unique: ["receipt_id", "line_no"],
  });
  pgm.addConstraint("material_receipt_lines", "material_receipt_lines_discrepancy_type_check", {
    check: `discrepancy_type IS NULL OR discrepancy_type IN (${DISCREPANCY_TYPES.map((t) => `'${t}'`).join(", ")})`,
  });
  // Over-receipt against one receipt's own DC quantity is impossible, a
  // discrepancy quantity always names its type, and an all-zero line (which
  // would assert nothing) is rejected.
  pgm.addConstraint("material_receipt_lines", "material_receipt_lines_quantity_check", {
    check: `
      dc_quantity > 0
      AND received_quantity >= 0
      AND discrepancy_quantity >= 0
      AND received_quantity + discrepancy_quantity > 0
      AND received_quantity + discrepancy_quantity <= dc_quantity
      AND received_quantity NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
      AND discrepancy_quantity NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)
      AND (discrepancy_quantity > 0) = (discrepancy_type IS NOT NULL)
    `,
  });
  pgm.createIndex("material_receipt_lines", "receipt_id");
  pgm.createIndex("material_receipt_lines", ["dc_line_id", "dc_id"]);
  pgm.createIndex("material_receipt_lines", "dc_id");

  pgm.sql(`
    CREATE TRIGGER material_receipts_set_updated_at
    BEFORE UPDATE ON material_receipts
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  // A recorded receipt line is history: never edited, never deleted. A
  // correction is a new receipt (or a discrepancy record), never a rewrite.
  pgm.sql(`
    CREATE TRIGGER material_receipt_lines_append_only
    BEFORE UPDATE OR DELETE ON material_receipt_lines
    FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
  `);

  pgm.sql(`
    CREATE FUNCTION material_receipts_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a material receipt cannot be deleted';
      END IF;
      IF NEW.dc_id IS DISTINCT FROM OLD.dc_id
         OR NEW.ipo_id IS DISTINCT FROM OLD.ipo_id
         OR NEW.department_id IS DISTINCT FROM OLD.department_id
         OR NEW.site_id IS DISTINCT FROM OLD.site_id
         OR NEW.receipt_type IS DISTINCT FROM OLD.receipt_type
         OR NEW.received_by_user_id IS DISTINCT FROM OLD.received_by_user_id
         OR NEW.physical_receiver_employee_id IS DISTINCT FROM OLD.physical_receiver_employee_id
         OR NEW.received_at IS DISTINCT FROM OLD.received_at THEN
        RAISE EXCEPTION 'the original receipt record is immutable';
      END IF;
      IF OLD.status = 'COMPLETED' AND NEW.status <> 'COMPLETED' THEN
        RAISE EXCEPTION 'a completed receipt cannot be reopened';
      END IF;
      -- Once a custody or closure event has happened it is history. Each
      -- tuple freezes independently the moment it is first written, so the
      -- full chain (who received, who took handover and when, who confirmed
      -- and when) always remains reconstructable. Corrections go through the
      -- ordinary correction paths, never a silent rewrite.
      IF OLD.handover_at IS NOT NULL
         AND (NEW.handover_at IS DISTINCT FROM OLD.handover_at
              OR NEW.handover_to_user_id IS DISTINCT FROM OLD.handover_to_user_id) THEN
        RAISE EXCEPTION 'a completed handover cannot be rewritten';
      END IF;

      IF OLD.confirmed_at IS NOT NULL
         AND (NEW.confirmed_at IS DISTINCT FROM OLD.confirmed_at
              OR NEW.confirmed_by_user_id IS DISTINCT FROM OLD.confirmed_by_user_id) THEN
        RAISE EXCEPTION 'a completed confirmation cannot be rewritten';
      END IF;

      IF OLD.status = 'COMPLETED' AND NEW.has_discrepancy IS DISTINCT FROM OLD.has_discrepancy THEN
        RAISE EXCEPTION 'a completed receipt discrepancy outcome cannot be rewritten';
      END IF;
      RETURN NEW;
    END;
    $function$;

    -- Total quantity accounted for against one DC line (received + recorded
    -- discrepancy) can never exceed that DC line's quantity, across every
    -- receipt. The DC line is locked first so two concurrent receivers of the
    -- same line serialize rather than both passing the check.
    CREATE FUNCTION material_receipt_lines_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      dc_line_quantity numeric;
      already_accounted numeric;
    BEGIN
      SELECT quantity INTO dc_line_quantity
      FROM public.delivery_challan_lines WHERE id = NEW.dc_line_id FOR UPDATE;

      SELECT COALESCE(SUM(received_quantity + discrepancy_quantity), 0) INTO already_accounted
      FROM public.material_receipt_lines
      WHERE dc_line_id = NEW.dc_line_id AND id <> NEW.id;

      IF already_accounted + NEW.received_quantity + NEW.discrepancy_quantity > dc_line_quantity THEN
        RAISE EXCEPTION 'receipt exceeds the unresolved delivery challan quantity for this line';
      END IF;

      RETURN NEW;
    END;
    $function$;

    REVOKE ALL ON FUNCTION material_receipts_guard() FROM PUBLIC;
    REVOKE ALL ON FUNCTION material_receipt_lines_guard() FROM PUBLIC;

    CREATE TRIGGER material_receipts_guard
    BEFORE UPDATE OR DELETE ON material_receipts
    FOR EACH ROW EXECUTE FUNCTION material_receipts_guard();

    CREATE TRIGGER material_receipt_lines_guard
    BEFORE INSERT ON material_receipt_lines
    FOR EACH ROW EXECUTE FUNCTION material_receipt_lines_guard();
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

  for (const table of ["material_receipts", "material_receipt_lines"]) {
    pgm.sql(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
  }
}

export async function down(pgm) {
  pgm.sql(`
    DO $block$
    BEGIN
      IF EXISTS (SELECT 1 FROM material_receipts) THEN
        RAISE EXCEPTION 'cannot downgrade: receiving history exists and must not be destroyed';
      END IF;
    END;
    $block$;
  `);

  pgm.sql(`
    DELETE FROM user_permission_overrides
    WHERE permission_id IN (SELECT id FROM permissions WHERE code LIKE 'receiving.%');
    DELETE FROM permissions WHERE code LIKE 'receiving.%';
  `);

  pgm.dropTable("material_receipt_lines");
  pgm.dropTable("material_receipts");
  pgm.sql(`
    DROP FUNCTION IF EXISTS material_receipt_lines_guard();
    DROP FUNCTION IF EXISTS material_receipts_guard();
  `);
  pgm.dropConstraint("delivery_challans", "delivery_challans_id_department_id_key");

  pgm.dropConstraint("procurement_audit_log", "procurement_audit_log_action_check");
  pgm.addConstraint("procurement_audit_log", "procurement_audit_log_action_check", {
    check: `action IN (${AUDIT_ACTIONS.slice(0, 11)
      .map((a) => `'${a}'`)
      .join(", ")})`,
  });
}
