export const shorthands = undefined;

// Checkpoint 6b — Delivery Challan (see docs/PROCUREMENT_RECEIVING_SPEC.md
// §17, §30). A DC is a first-class operational document, deliberately NOT
// merged with Gate Pass (docs/DECISIONS.md, "Keep Gate Pass and Delivery
// Challan Separate"): different actors, different lifecycle, different
// printed content. Nothing here touches gate_pass* tables.
//
// One IPO may produce several DCs, because partial purchasing produces
// partial deliveries. The invariant that keeps that safe is allocation:
// across all non-cancelled DCs, the quantity allocated from an IPO line can
// never exceed that line's actual purchased quantity. It is enforced in the
// service under the IPO row lock (which serializes every DC write for one
// IPO) and re-checked by a trigger below, which also makes a finalized DC's
// content immutable.

const DC_STATUSES = ["DRAFT", "FINALIZED", "RECEIVING", "COMPLETED", "CANCELLED"];

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
];

const PERMISSIONS = [
  ["dc.view", "View Delivery Challans within authorized scope"],
  ["dc.manage", "Create, edit, finalize and cancel Delivery Challans"],
];

// dc.manage follows procurement.pricing/procurement.purchase exactly: CEO by
// default only, real Procurement staff by explicit per-user GRANT. dc.view is
// operational (no pricing) and goes to the roles that actually receive or
// oversee material.
const ROLE_PERMISSIONS = {
  CEO: ["dc.view", "dc.manage"],
  UPPER_MANAGEMENT: ["dc.view"],
  SITE_MANAGER: ["dc.view"],
  ADMIN: ["dc.view"],
  TEAM_LEAD: ["dc.view"],
  EMPLOYEE: ["dc.view"],
};

export async function up(pgm) {
  pgm.dropConstraint("procurement_audit_log", "procurement_audit_log_action_check");
  pgm.addConstraint("procurement_audit_log", "procurement_audit_log_action_check", {
    check: `action IN (${AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
  });

  pgm.sql(`
    INSERT INTO document_number_settings (document_type, prefix, separator, suffix, pad_width, start_value)
    VALUES ('DELIVERY_CHALLAN', 'ESET-DC', '/', '', 1, 1);
  `);

  pgm.createTable("delivery_challans", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    dc_number: { type: "varchar(40)", notNull: true, unique: true },
    ipo_id: { type: "uuid", notNull: true },
    // Denormalized from the IPO so the delivery destination is enforceable
    // as a composite FK and cannot drift from the IPO it was cut against.
    department_id: { type: "uuid", notNull: true },
    site_id: { type: "uuid", notNull: true, references: "sites", onDelete: "RESTRICT" },
    status: { type: "varchar(20)", notNull: true, default: "DRAFT" },
    note: { type: "text" },
    // Client-supplied, stable per logical shipment. A retried creation
    // request carries the same value, so a lost HTTP response can never cut
    // a second challan (and consume a second DC number) for one shipment.
    operation_id: { type: "uuid", notNull: true },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    finalized_by_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    finalized_at: { type: "timestamptz" },
    completed_at: { type: "timestamptz" },
    cancelled_by_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    cancelled_at: { type: "timestamptz" },
    cancellation_reason: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("delivery_challans", "delivery_challans_ipo_department_fkey", {
    foreignKeys: {
      columns: ["ipo_id", "department_id"],
      references: "ipos(id, department_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("delivery_challans", "delivery_challans_id_ipo_id_key", { unique: ["id", "ipo_id"] });
  pgm.addConstraint("delivery_challans", "delivery_challans_operation_key", { unique: ["operation_id"] });
  // Site coherence: a challan cannot claim a site other than its IPO's.
  pgm.addConstraint("delivery_challans", "delivery_challans_ipo_site_fkey", {
    foreignKeys: {
      columns: ["ipo_id", "site_id"],
      references: "ipos(id, site_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("delivery_challans", "delivery_challans_id_site_id_key", { unique: ["id", "site_id"] });
  pgm.addConstraint("delivery_challans", "delivery_challans_status_check", {
    check: `status IN (${DC_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });
  pgm.addConstraint("delivery_challans", "delivery_challans_finalized_check", {
    check: `
      (status = 'DRAFT' AND finalized_by_user_id IS NULL AND finalized_at IS NULL)
      OR
      (status <> 'DRAFT' AND (status = 'CANCELLED' OR (finalized_by_user_id IS NOT NULL AND finalized_at IS NOT NULL)))
    `,
  });
  pgm.addConstraint("delivery_challans", "delivery_challans_cancellation_check", {
    check: `
      (status <> 'CANCELLED' AND cancelled_by_user_id IS NULL AND cancelled_at IS NULL AND cancellation_reason IS NULL)
      OR
      (status = 'CANCELLED' AND cancelled_by_user_id IS NOT NULL AND cancelled_at IS NOT NULL
        AND cancellation_reason IS NOT NULL)
    `,
  });
  pgm.addConstraint("delivery_challans", "delivery_challans_completion_check", {
    check: "(status = 'COMPLETED') = (completed_at IS NOT NULL)",
  });
  pgm.createIndex("delivery_challans", "ipo_id");
  pgm.createIndex("delivery_challans", "department_id");
  pgm.createIndex("delivery_challans", "site_id");
  pgm.createIndex("delivery_challans", "status");
  pgm.createIndex("delivery_challans", "created_by_user_id");
  pgm.createIndex("delivery_challans", "finalized_by_user_id");
  pgm.createIndex("delivery_challans", "cancelled_by_user_id");

  pgm.createTable("delivery_challan_lines", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    dc_id: { type: "uuid", notNull: true },
    // Denormalized only to make both parent relationships composite FKs: the
    // DC and the IPO line must belong to the same IPO.
    ipo_id: { type: "uuid", notNull: true },
    ipo_line_id: { type: "uuid", notNull: true },
    line_no: { type: "integer", notNull: true },
    item_name_snapshot: { type: "varchar(150)", notNull: true },
    uom_code_snapshot: { type: "varchar(20)", notNull: true },
    uom_name_snapshot: { type: "varchar(50)", notNull: true },
    quantity: { type: "numeric(12,2)", notNull: true },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("delivery_challan_lines", "delivery_challan_lines_dc_ipo_fkey", {
    foreignKeys: {
      columns: ["dc_id", "ipo_id"],
      references: "delivery_challans(id, ipo_id)",
      onDelete: "CASCADE",
    },
  });
  pgm.addConstraint("delivery_challan_lines", "delivery_challan_lines_ipo_line_fkey", {
    foreignKeys: {
      columns: ["ipo_line_id", "ipo_id"],
      references: "ipo_lines(id, ipo_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("delivery_challan_lines", "delivery_challan_lines_dc_ipo_line_key", {
    unique: ["dc_id", "ipo_line_id"],
  });
  pgm.addConstraint("delivery_challan_lines", "delivery_challan_lines_dc_line_no_key", {
    unique: ["dc_id", "line_no"],
  });
  pgm.addConstraint("delivery_challan_lines", "delivery_challan_lines_id_dc_id_key", { unique: ["id", "dc_id"] });
  pgm.addConstraint("delivery_challan_lines", "delivery_challan_lines_quantity_check", {
    check: `quantity > 0
      AND quantity NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`,
  });
  pgm.createIndex("delivery_challan_lines", "dc_id");
  pgm.createIndex("delivery_challan_lines", ["ipo_line_id", "ipo_id"]);
  pgm.createIndex("delivery_challan_lines", "ipo_id");

  pgm.sql(`
    CREATE TRIGGER delivery_challans_set_updated_at
    BEFORE UPDATE ON delivery_challans
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

    CREATE TRIGGER delivery_challan_lines_set_updated_at
    BEFORE UPDATE ON delivery_challan_lines
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
  `);

  // Two independent guarantees below the service:
  //   1. a DC that has left DRAFT can never have its item/quantity content
  //      rewritten or deleted — corrections go through cancel + replace,
  //      never a silent edit of finalized history;
  //   2. no purchased quantity can be allocated to DC lines twice. The sum
  //      is taken over every DC of the same IPO that is not CANCELLED, and
  //      the parent IPO line is locked FOR UPDATE first, so two concurrent
  //      allocations of the same line serialize instead of both passing.
  pgm.sql(`
    CREATE FUNCTION delivery_challans_forbid_finalized_change()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'a delivery challan cannot be deleted';
      END IF;
      IF OLD.status <> 'DRAFT' THEN
        IF NEW.dc_number IS DISTINCT FROM OLD.dc_number
           OR NEW.ipo_id IS DISTINCT FROM OLD.ipo_id
           OR NEW.department_id IS DISTINCT FROM OLD.department_id
           OR NEW.site_id IS DISTINCT FROM OLD.site_id
           OR NEW.note IS DISTINCT FROM OLD.note
           OR NEW.finalized_by_user_id IS DISTINCT FROM OLD.finalized_by_user_id
           OR NEW.finalized_at IS DISTINCT FROM OLD.finalized_at THEN
          RAISE EXCEPTION 'a finalized delivery challan is immutable';
        END IF;
      END IF;
      IF OLD.status IN ('CANCELLED', 'COMPLETED') AND NEW.status <> OLD.status THEN
        RAISE EXCEPTION 'a % delivery challan cannot change status', lower(OLD.status);
      END IF;
      RETURN NEW;
    END;
    $function$;

    CREATE FUNCTION delivery_challan_lines_guard()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      parent_status text;
      target_dc_id uuid;
      target_ipo_line_id uuid;
      purchased numeric;
      allocated numeric;
    BEGIN
      target_dc_id := CASE WHEN TG_OP = 'DELETE' THEN OLD.dc_id ELSE NEW.dc_id END;

      SELECT status INTO parent_status
      FROM public.delivery_challans WHERE id = target_dc_id FOR SHARE;

      IF parent_status IS DISTINCT FROM 'DRAFT' THEN
        RAISE EXCEPTION 'delivery challan lines can only change while the challan is a draft';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;

      SELECT purchased_quantity INTO purchased
      FROM public.ipo_lines WHERE id = NEW.ipo_line_id FOR UPDATE;

      SELECT COALESCE(SUM(l.quantity), 0) INTO allocated
      FROM public.delivery_challan_lines l
      JOIN public.delivery_challans d ON d.id = l.dc_id
      WHERE l.ipo_line_id = NEW.ipo_line_id
        AND d.status <> 'CANCELLED'
        AND l.id <> NEW.id;

      IF allocated + NEW.quantity > purchased THEN
        RAISE EXCEPTION 'delivery challan allocation exceeds the purchased quantity for this IPO line';
      END IF;

      RETURN NEW;
    END;
    $function$;

    REVOKE ALL ON FUNCTION delivery_challans_forbid_finalized_change() FROM PUBLIC;
    REVOKE ALL ON FUNCTION delivery_challan_lines_guard() FROM PUBLIC;

    CREATE TRIGGER delivery_challans_forbid_finalized_change
    BEFORE UPDATE OR DELETE ON delivery_challans
    FOR EACH ROW EXECUTE FUNCTION delivery_challans_forbid_finalized_change();

    CREATE TRIGGER delivery_challan_lines_guard
    BEFORE INSERT OR UPDATE OR DELETE ON delivery_challan_lines
    FOR EACH ROW EXECUTE FUNCTION delivery_challan_lines_guard();
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

  for (const table of ["delivery_challans", "delivery_challan_lines"]) {
    pgm.sql(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
  }
}

export async function down(pgm) {
  pgm.sql(`
    DO $block$
    BEGIN
      IF EXISTS (SELECT 1 FROM delivery_challans) THEN
        RAISE EXCEPTION 'cannot downgrade: delivery challans exist and their numbers must never be released';
      END IF;
    END;
    $block$;
  `);

  pgm.sql(`
    DELETE FROM user_permission_overrides
    WHERE permission_id IN (SELECT id FROM permissions WHERE code IN ('dc.view', 'dc.manage'));
    DELETE FROM permissions WHERE code IN ('dc.view', 'dc.manage');
  `);

  pgm.dropTable("delivery_challan_lines");
  pgm.dropTable("delivery_challans");
  pgm.sql(`
    DROP FUNCTION IF EXISTS delivery_challan_lines_guard();
    DROP FUNCTION IF EXISTS delivery_challans_forbid_finalized_change();
  `);
  pgm.sql(`DELETE FROM document_number_settings WHERE document_type = 'DELIVERY_CHALLAN';`);

  pgm.dropConstraint("procurement_audit_log", "procurement_audit_log_action_check");
  pgm.addConstraint("procurement_audit_log", "procurement_audit_log_action_check", {
    check: `action IN (${AUDIT_ACTIONS.slice(0, 6)
      .map((a) => `'${a}'`)
      .join(", ")})`,
  });
}
