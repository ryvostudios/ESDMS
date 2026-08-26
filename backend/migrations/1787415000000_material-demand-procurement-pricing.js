export const shorthands = undefined;

// Checkpoint 4 of Procurement & Material Receiving V1. Commercial pricing
// is deliberately stored outside the operational Demand tables so an
// ordinary Demand query cannot retrieve price data accidentally. A pricing
// header is bound to one Demand revision; its lines are relationally pinned
// to lines from that same Demand.

const MATERIAL_DEMAND_STATUSES = [
  "DRAFT",
  "PENDING_INITIAL_REVIEW",
  "REJECTED",
  "READY_FOR_PRICING",
  "PENDING_FINAL_APPROVAL",
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

  // Supports the composite ownership FK on pricing lines below. The
  // existing primary key remains unchanged.
  pgm.addConstraint("material_demand_lines", "material_demand_lines_id_demand_id_key", {
    unique: ["id", "demand_id"],
  });

  pgm.createTable("material_demand_pricing", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    demand_id: { type: "uuid", notNull: true, references: "material_demands", onDelete: "RESTRICT" },
    demand_revision: { type: "integer", notNull: true },
    status: { type: "varchar(20)", notNull: true, default: "DRAFT" },
    currency: { type: "varchar(3)", notNull: true, default: "PKR" },
    created_by_user_id: { type: "uuid", notNull: true, references: "users", onDelete: "RESTRICT" },
    submitted_by_user_id: { type: "uuid", references: "users", onDelete: "RESTRICT" },
    submitted_at: { type: "timestamptz" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("material_demand_pricing", "material_demand_pricing_demand_revision_key", {
    unique: ["demand_id", "demand_revision"],
  });
  pgm.addConstraint("material_demand_pricing", "material_demand_pricing_id_demand_id_key", {
    unique: ["id", "demand_id"],
  });
  pgm.addConstraint("material_demand_pricing", "material_demand_pricing_revision_check", {
    check: "demand_revision > 0",
  });
  pgm.addConstraint("material_demand_pricing", "material_demand_pricing_status_check", {
    check: "status IN ('DRAFT', 'SUBMITTED')",
  });
  pgm.addConstraint("material_demand_pricing", "material_demand_pricing_currency_check", {
    check: "currency = 'PKR'",
  });
  pgm.addConstraint("material_demand_pricing", "material_demand_pricing_submission_check", {
    check: `
      (status = 'DRAFT' AND submitted_by_user_id IS NULL AND submitted_at IS NULL)
      OR
      (status = 'SUBMITTED' AND submitted_by_user_id IS NOT NULL AND submitted_at IS NOT NULL)
    `,
  });
  pgm.createIndex("material_demand_pricing", "created_by_user_id");
  pgm.createIndex("material_demand_pricing", "submitted_by_user_id");

  pgm.createTable("material_demand_pricing_lines", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    pricing_id: { type: "uuid", notNull: true },
    // Denormalized only to make both parent relationships enforceable as
    // composite foreign keys: the pricing header and Demand line must
    // belong to the exact same Demand.
    demand_id: { type: "uuid", notNull: true },
    demand_line_id: { type: "uuid", notNull: true },
    estimated_unit_price: { type: "numeric(14,2)", notNull: true },
    procurement_note: { type: "text" },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    updated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("material_demand_pricing_lines", "material_demand_pricing_lines_price_check", {
    // PostgreSQL numeric supports non-finite values, and numeric NaN sorts
    // above ordinary numbers. `> 0` alone would therefore admit NaN and
    // positive Infinity even though the API rejects them.
    check: `estimated_unit_price > 0
      AND estimated_unit_price NOT IN ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric)`,
  });
  pgm.addConstraint("material_demand_pricing_lines", "material_demand_pricing_lines_pricing_demand_fkey", {
    foreignKeys: {
      columns: ["pricing_id", "demand_id"],
      references: "material_demand_pricing(id, demand_id)",
      onDelete: "CASCADE",
    },
  });
  pgm.addConstraint("material_demand_pricing_lines", "material_demand_pricing_lines_line_demand_fkey", {
    foreignKeys: {
      columns: ["demand_line_id", "demand_id"],
      references: "material_demand_lines(id, demand_id)",
      onDelete: "RESTRICT",
    },
  });
  pgm.addConstraint("material_demand_pricing_lines", "material_demand_pricing_lines_pricing_line_key", {
    unique: ["pricing_id", "demand_line_id"],
  });
  pgm.createIndex("material_demand_pricing_lines", ["demand_line_id", "demand_id"]);
  pgm.createIndex("material_demand_pricing_lines", "demand_id");

  pgm.sql(`
    CREATE TRIGGER material_demand_pricing_set_updated_at
    BEFORE UPDATE ON material_demand_pricing
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();

    CREATE TRIGGER material_demand_pricing_lines_set_updated_at
    BEFORE UPDATE ON material_demand_pricing_lines
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  `);

  // Header and line guards provide defense in depth below the service.
  // The line guard takes a SHARE lock on the header so a direct line write
  // cannot race the DRAFT -> SUBMITTED update and land afterward.
  pgm.sql(`
    CREATE FUNCTION material_demand_pricing_forbid_finalized_change()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    BEGIN
      IF OLD.status = 'SUBMITTED' THEN
        RAISE EXCEPTION 'submitted material demand pricing is immutable';
      END IF;
      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $function$;

    CREATE FUNCTION material_demand_pricing_lines_forbid_finalized_change()
    RETURNS trigger
    LANGUAGE plpgsql
    SET search_path = pg_catalog, public
    AS $function$
    DECLARE
      parent_status text;
      target_pricing_id uuid;
    BEGIN
      target_pricing_id := CASE WHEN TG_OP = 'INSERT' THEN NEW.pricing_id ELSE OLD.pricing_id END;
      SELECT status INTO parent_status
      FROM public.material_demand_pricing
      WHERE id = target_pricing_id
      FOR SHARE;

      IF parent_status = 'SUBMITTED' THEN
        RAISE EXCEPTION 'submitted material demand pricing lines are immutable';
      END IF;

      IF TG_OP = 'DELETE' THEN
        RETURN OLD;
      END IF;
      RETURN NEW;
    END;
    $function$;

    REVOKE ALL ON FUNCTION material_demand_pricing_forbid_finalized_change() FROM PUBLIC;
    REVOKE ALL ON FUNCTION material_demand_pricing_lines_forbid_finalized_change() FROM PUBLIC;

    CREATE TRIGGER material_demand_pricing_forbid_finalized_change
    BEFORE UPDATE OR DELETE ON material_demand_pricing
    FOR EACH ROW
    EXECUTE FUNCTION material_demand_pricing_forbid_finalized_change();

    CREATE TRIGGER material_demand_pricing_lines_forbid_finalized_change
    BEFORE INSERT OR UPDATE OR DELETE ON material_demand_pricing_lines
    FOR EACH ROW
    EXECUTE FUNCTION material_demand_pricing_lines_forbid_finalized_change();
  `);

  pgm.sql(`
    INSERT INTO permissions (code, description)
    VALUES ('procurement.view_prices', 'View protected Procurement estimated pricing within authorized Demand scope');
  `);

  for (const role of ["CEO", "UPPER_MANAGEMENT", "SITE_MANAGER"]) {
    pgm.sql(`
      INSERT INTO role_permissions (role_id, permission_id)
      SELECT r.id, p.id
      FROM roles r, permissions p
      WHERE r.name = '${role}' AND p.code = 'procurement.view_prices'
      ON CONFLICT DO NOTHING;
    `);
  }

  for (const table of ["material_demand_pricing", "material_demand_pricing_lines"]) {
    pgm.sql(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
  }
}

export async function down(pgm) {
  pgm.sql(`
    DELETE FROM user_permission_overrides
    WHERE permission_id = (SELECT id FROM permissions WHERE code = 'procurement.view_prices');
    DELETE FROM permissions WHERE code = 'procurement.view_prices';
  `);

  pgm.dropTable("material_demand_pricing_lines");
  pgm.dropTable("material_demand_pricing");
  pgm.dropConstraint("material_demand_lines", "material_demand_lines_id_demand_id_key");
  pgm.sql(`
    DROP FUNCTION material_demand_pricing_lines_forbid_finalized_change();
    DROP FUNCTION material_demand_pricing_forbid_finalized_change();
  `);

  pgm.dropConstraint("material_demand_audit_log", "material_demand_audit_log_action_check");
  pgm.addConstraint("material_demand_audit_log", "material_demand_audit_log_action_check", {
    check: `action IN ('CREATE', 'EDIT_DRAFT', 'SUBMIT', 'MANAGEMENT_REVIEW_APPROVED',
      'MANAGEMENT_REVIEW_REJECTED', 'FORMAL_APPROVAL_APPROVED',
      'FORMAL_APPROVAL_REJECTED', 'READY_FOR_PRICING')`,
  });

  pgm.dropConstraint("material_demands", "material_demands_status_check");
  pgm.addConstraint("material_demands", "material_demands_status_check", {
    check: "status IN ('DRAFT', 'PENDING_INITIAL_REVIEW', 'REJECTED', 'READY_FOR_PRICING')",
  });
}
