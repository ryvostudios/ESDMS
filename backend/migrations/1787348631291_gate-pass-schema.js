export const shorthands = undefined;

// Placeholder org reference data — no real department list has been
// supplied yet. Renaming/adding departments later is a data change, not a
// schema change, so this does not block the demo.
const SEED_DEPARTMENTS = [
  "Electrical",
  "Mechanical",
  "Civil",
  "HSE",
  "Warehouse",
  "Administration",
];

const GATE_PASS_STATUSES = [
  "DRAFT",
  "PENDING_APPROVAL",
  "APPROVED",
  "VEHICLE_OUTSIDE",
  "COMPLETED",
  "REJECTED",
  "CANCELLED",
];

const GATE_PASS_PURPOSES = [
  "INTER_DEPARTMENT_TRANSFER",
  "REPLACEMENT",
  "WARRANTY",
  "REPAIR_RECTIFICATION",
  "REJECT",
  "SAMPLE",
  "SALES",
  "RETURNABLE",
  "OTHER",
];

const AUDIT_ACTIONS = [
  "CREATE",
  "EDIT_DRAFT",
  "SUBMIT",
  "APPROVE",
  "REJECT",
  "CANCEL",
  "EXIT",
  "RETURN",
];

export async function up(pgm) {
  for (const name of SEED_DEPARTMENTS) {
    pgm.sql(
      `INSERT INTO departments (name) VALUES ('${name}') ON CONFLICT (name) DO NOTHING;`,
    );
  }

  // Server-authoritative Gate Pass numbering: ESD-YYYY-NNNNNN, sequential
  // per calendar year. A single atomic UPDATE (ON CONFLICT DO UPDATE ...
  // RETURNING) is race-safe under concurrent creates without an explicit
  // advisory lock.
  pgm.createTable("gate_pass_number_counters", {
    year: {
      type: "integer",
      primaryKey: true,
    },
    last_value: {
      type: "integer",
      notNull: true,
      default: 0,
    },
  });

  pgm.createTable("gate_passes", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    gate_pass_number: {
      type: "varchar(20)",
      notNull: true,
      unique: true,
    },
    status: {
      type: "varchar(20)",
      notNull: true,
      default: "DRAFT",
    },
    issuing_department_id: {
      type: "uuid",
      notNull: true,
      references: "departments",
      onDelete: "RESTRICT",
    },
    requested_by: {
      type: "varchar(150)",
      notNull: true,
    },
    destination: {
      type: "varchar(200)",
      notNull: true,
    },
    driver_name: {
      type: "varchar(150)",
      notNull: true,
    },
    driver_phone: {
      type: "varchar(30)",
      notNull: true,
    },
    vehicle_registration: {
      type: "varchar(30)",
      notNull: true,
    },
    job_order_id: {
      type: "varchar(50)",
    },
    purpose: {
      type: "varchar(40)",
      notNull: true,
    },
    expected_return_date: {
      type: "date",
    },
    remarks: {
      type: "text",
    },

    created_by_user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    approved_by_user_id: {
      type: "uuid",
      references: "users",
      onDelete: "RESTRICT",
    },
    approved_at: {
      type: "timestamptz",
    },
    verification_token_hash: {
      type: "varchar(64)",
      unique: true,
    },

    rejected_by_user_id: {
      type: "uuid",
      references: "users",
      onDelete: "RESTRICT",
    },
    rejected_at: {
      type: "timestamptz",
    },
    rejection_reason: {
      type: "text",
    },

    cancelled_by_user_id: {
      type: "uuid",
      references: "users",
      onDelete: "RESTRICT",
    },
    cancelled_at: {
      type: "timestamptz",
    },
    cancellation_reason: {
      type: "text",
    },

    departure_odometer: {
      type: "integer",
    },
    departure_at: {
      type: "timestamptz",
    },
    departure_by_user_id: {
      type: "uuid",
      references: "users",
      onDelete: "RESTRICT",
    },

    return_odometer: {
      type: "integer",
    },
    return_at: {
      type: "timestamptz",
    },
    return_by_user_id: {
      type: "uuid",
      references: "users",
      onDelete: "RESTRICT",
    },
    return_remarks: {
      type: "text",
    },

    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
    updated_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
  });

  pgm.addConstraint("gate_passes", "gate_passes_status_check", {
    check: `status IN (${GATE_PASS_STATUSES.map((s) => `'${s}'`).join(", ")})`,
  });
  pgm.addConstraint("gate_passes", "gate_passes_purpose_check", {
    check: `purpose IN (${GATE_PASS_PURPOSES.map((p) => `'${p}'`).join(", ")})`,
  });
  pgm.addConstraint("gate_passes", "gate_passes_departure_odometer_check", {
    check: "departure_odometer IS NULL OR departure_odometer >= 0",
  });
  pgm.addConstraint("gate_passes", "gate_passes_return_odometer_check", {
    check: "return_odometer IS NULL OR return_odometer >= 0",
  });
  pgm.addConstraint("gate_passes", "gate_passes_return_not_before_departure_check", {
    check:
      "return_odometer IS NULL OR departure_odometer IS NULL OR return_odometer >= departure_odometer",
  });

  // Authoritative server-side distance: cannot be set or tampered with by
  // application code, only ever derived from the two odometer readings.
  pgm.sql(`
    ALTER TABLE gate_passes
    ADD COLUMN distance_km INTEGER GENERATED ALWAYS AS (return_odometer - departure_odometer) STORED;
  `);

  pgm.createIndex("gate_passes", "status");
  pgm.createIndex("gate_passes", "vehicle_registration");
  pgm.createIndex("gate_passes", "issuing_department_id");
  pgm.createIndex("gate_passes", "created_by_user_id");
  pgm.createIndex("gate_passes", "created_at");

  pgm.sql(`
    CREATE OR REPLACE FUNCTION set_updated_at()
    RETURNS TRIGGER AS $$
    BEGIN
      NEW.updated_at = CURRENT_TIMESTAMP;
      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE TRIGGER gate_passes_set_updated_at
    BEFORE UPDATE ON gate_passes
    FOR EACH ROW
    EXECUTE FUNCTION set_updated_at();
  `);

  // Gate Passes are an operational/audit record: no ordinary application
  // path deletes one. Enforced again here, in the database, as defense in
  // depth against an application bug ever issuing a DELETE.
  pgm.sql(`
    CREATE OR REPLACE FUNCTION forbid_delete()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION 'Deletion of % rows is not permitted.', TG_TABLE_NAME;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE TRIGGER gate_passes_forbid_delete
    BEFORE DELETE ON gate_passes
    FOR EACH ROW
    EXECUTE FUNCTION forbid_delete();
  `);

  // --- Items (parent/child, not a text blob) ---------------------------

  pgm.createTable("gate_pass_items", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    gate_pass_id: {
      type: "uuid",
      notNull: true,
      references: "gate_passes",
      onDelete: "CASCADE",
    },
    line_no: {
      type: "integer",
      notNull: true,
    },
    description: {
      type: "varchar(300)",
      notNull: true,
    },
    part_number: {
      type: "varchar(100)",
    },
    quantity: {
      type: "numeric(12,2)",
      notNull: true,
    },
    unit: {
      type: "varchar(30)",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
  });

  pgm.addConstraint("gate_pass_items", "gate_pass_items_quantity_check", {
    check: "quantity > 0",
  });
  pgm.createIndex("gate_pass_items", "gate_pass_id");

  // Items are legitimately rewritable while a pass is DRAFT (add/remove
  // rows), so no unconditional DELETE trigger here — the service layer
  // enforces "only while DRAFT" under the same row-locked transaction used
  // for every other state-dependent write. gate_passes itself still
  // forbids DELETE outright, so items can never be orphaned by losing
  // their parent.

  // --- Files (evidence photos, generated PDFs) --------------------------
  // Structured metadata only. Bytes live behind the StorageService
  // abstraction (local disk for this demo; swappable for object storage).

  pgm.createTable("gate_pass_files", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    gate_pass_id: {
      type: "uuid",
      notNull: true,
      references: "gate_passes",
      onDelete: "CASCADE",
    },
    file_type: {
      type: "varchar(30)",
      notNull: true,
    },
    storage_key: {
      type: "text",
      notNull: true,
      unique: true,
    },
    mime_type: {
      type: "varchar(100)",
      notNull: true,
    },
    size_bytes: {
      type: "integer",
      notNull: true,
    },
    checksum_sha256: {
      type: "varchar(64)",
      notNull: true,
    },
    version: {
      type: "integer",
      notNull: true,
      default: 1,
    },
    created_by_user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
  });

  pgm.addConstraint("gate_pass_files", "gate_pass_files_type_check", {
    check:
      "file_type IN ('DEPARTURE_PHOTO', 'RETURN_PHOTO', 'APPROVED_PDF')",
  });
  pgm.addConstraint("gate_pass_files", "gate_pass_files_size_check", {
    check: "size_bytes > 0",
  });
  pgm.createIndex("gate_pass_files", "gate_pass_id");

  pgm.sql(`
    CREATE TRIGGER gate_pass_files_forbid_delete
    BEFORE DELETE ON gate_pass_files
    FOR EACH ROW
    EXECUTE FUNCTION forbid_delete();
  `);

  // Deferred FKs from gate_passes to its evidence photo files — declared
  // after gate_pass_files exists to avoid a circular create-table ordering.
  pgm.addColumn("gate_passes", {
    departure_photo_file_id: {
      type: "uuid",
      references: "gate_pass_files",
      onDelete: "RESTRICT",
    },
    return_photo_file_id: {
      type: "uuid",
      references: "gate_pass_files",
      onDelete: "RESTRICT",
    },
  });

  // --- Audit log (append-only) ------------------------------------------

  pgm.createTable("gate_pass_audit_log", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    gate_pass_id: {
      type: "uuid",
      notNull: true,
      references: "gate_passes",
      onDelete: "CASCADE",
    },
    actor_user_id: {
      type: "uuid",
      notNull: true,
      references: "users",
      onDelete: "RESTRICT",
    },
    action: {
      type: "varchar(20)",
      notNull: true,
    },
    previous_status: {
      type: "varchar(20)",
    },
    new_status: {
      type: "varchar(20)",
    },
    metadata: {
      type: "jsonb",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
  });

  pgm.addConstraint("gate_pass_audit_log", "gate_pass_audit_log_action_check", {
    check: `action IN (${AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
  });
  pgm.createIndex("gate_pass_audit_log", "gate_pass_id");
  pgm.createIndex("gate_pass_audit_log", "created_at");

  pgm.sql(`
    CREATE OR REPLACE FUNCTION forbid_update_delete()
    RETURNS TRIGGER AS $$
    BEGIN
      RAISE EXCEPTION '% rows are append-only.', TG_TABLE_NAME;
    END;
    $$ LANGUAGE plpgsql;
  `);

  pgm.sql(`
    CREATE TRIGGER gate_pass_audit_log_append_only
    BEFORE UPDATE OR DELETE ON gate_pass_audit_log
    FOR EACH ROW
    EXECUTE FUNCTION forbid_update_delete();
  `);

  // --- Notification / delivery outbox ------------------------------------
  // Shared-shape outbox (not Gate-Pass-specific in structure) so future
  // modules can reuse it: Guard in-app notifications and Driver WhatsApp
  // delivery both write here inside the approval transaction; a background
  // worker delivers them afterward so external delivery never gates a
  // state transition.

  pgm.createTable("notification_outbox", {
    id: {
      type: "uuid",
      primaryKey: true,
      default: pgm.func("gen_random_uuid()"),
    },
    channel: {
      type: "varchar(20)",
      notNull: true,
    },
    event_type: {
      type: "varchar(50)",
      notNull: true,
    },
    entity_type: {
      type: "varchar(30)",
      notNull: true,
    },
    entity_id: {
      type: "uuid",
      notNull: true,
    },
    recipient_user_id: {
      type: "uuid",
      references: "users",
      onDelete: "SET NULL",
    },
    recipient_role: {
      type: "varchar(30)",
    },
    recipient_phone: {
      type: "varchar(30)",
    },
    payload: {
      type: "jsonb",
      notNull: true,
    },
    status: {
      type: "varchar(20)",
      notNull: true,
      default: "PENDING",
    },
    attempts: {
      type: "integer",
      notNull: true,
      default: 0,
    },
    last_error: {
      type: "text",
    },
    sent_at: {
      type: "timestamptz",
    },
    created_at: {
      type: "timestamptz",
      notNull: true,
      default: pgm.func("CURRENT_TIMESTAMP"),
    },
  });

  pgm.addConstraint("notification_outbox", "notification_outbox_channel_check", {
    check: "channel IN ('IN_APP', 'WHATSAPP')",
  });
  pgm.addConstraint("notification_outbox", "notification_outbox_status_check", {
    check: "status IN ('PENDING', 'SENT', 'FAILED', 'SIMULATED')",
  });
  pgm.createIndex("notification_outbox", "status");
  pgm.createIndex("notification_outbox", ["entity_type", "entity_id"]);
  pgm.createIndex("notification_outbox", "recipient_user_id");
}

export async function down(pgm) {
  pgm.dropTable("notification_outbox");
  pgm.dropTable("gate_pass_audit_log");
  pgm.sql("DROP FUNCTION IF EXISTS forbid_update_delete();");
  pgm.dropColumns("gate_passes", ["departure_photo_file_id", "return_photo_file_id"]);
  pgm.dropTable("gate_pass_files");
  pgm.dropTable("gate_pass_items");
  pgm.dropTable("gate_passes");
  pgm.sql("DROP FUNCTION IF EXISTS forbid_delete();");
  pgm.sql("DROP FUNCTION IF EXISTS set_updated_at();");
  pgm.dropTable("gate_pass_number_counters");
}
