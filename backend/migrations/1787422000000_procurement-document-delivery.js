export const shorthands = undefined;

// Stored business documents + official WhatsApp delivery for IPO and
// Delivery Challan (owner requirement §26-§30 of the build prompt).
//
// Architecture reuses what already exists rather than adding a parallel
// mechanism: the existing notification_outbox IS the delivery record (it
// already carries channel, recipient_phone, status, attempts, last_error,
// idempotency_key, provider message id in payload, and timestamps), and the
// existing SYSTEM-job + WHATSAPP-job chain Gate Pass approval already uses
// is the exact "business record commits first, delivery happens after" shape
// this requirement needs:
//
//     IPO/DC transaction COMMITS
//           -> SYSTEM job (durable, same transaction)
//           -> render PDF, store bytes, record procurement_documents row
//           -> WHATSAPP job (idempotency-keyed)
//           -> official provider attempt, outcome recorded
//
// A WhatsApp failure therefore can never roll back, delete or block an IPO
// or a Delivery Challan; the document stays downloadable either way.
//
// procurement_documents also gives finalized documents historical stability
// (spec §42): the rendered bytes are kept, so a later template change or
// master-data rename cannot restate a document that was already issued and
// shared.

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
  "DOCUMENT_GENERATED",
  "DOCUMENT_DELIVERY_QUEUED",
  "DOCUMENT_DELIVERY_SKIPPED",
];

export async function up(pgm) {
  pgm.dropConstraint("procurement_audit_log", "procurement_audit_log_action_check");
  pgm.addConstraint("procurement_audit_log", "procurement_audit_log_action_check", {
    check: `action IN (${AUDIT_ACTIONS.map((a) => `'${a}'`).join(", ")})`,
  });

  // A delivery attempt that was never made because WhatsApp is switched off
  // or unconfigured is neither a success nor a retryable failure — it is a
  // deliberate non-delivery, and the history must say so plainly rather than
  // sitting in PENDING forever or masquerading as FAILED.
  pgm.dropConstraint("notification_outbox", "notification_outbox_status_check");
  pgm.addConstraint("notification_outbox", "notification_outbox_status_check", {
    check:
      "status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SIMULATED', 'VOID', 'UNCERTAIN', 'DISABLED')",
  });

  // Per-department WhatsApp destination for Delivery Challan sharing. A
  // Delivery Challan belongs to exactly one department, and each department
  // already has its own real group, so the destination belongs on the
  // department rather than in a single global environment value. Nullable:
  // when unset, the configured default destination is used, and when there
  // is no default either, delivery is recorded as NOT_CONFIGURED.
  pgm.addColumn("departments", {
    whatsapp_destination: { type: "varchar(40)" },
  });
  pgm.addConstraint("departments", "departments_whatsapp_destination_check", {
    // E.164-ish or a provider group identifier; never free text.
    check: "whatsapp_destination IS NULL OR whatsapp_destination ~ '^[A-Za-z0-9+@._-]{5,40}$'",
  });

  pgm.createTable("procurement_documents", {
    id: { type: "uuid", primaryKey: true, default: pgm.func("gen_random_uuid()") },
    ipo_id: { type: "uuid", notNull: true, references: "ipos", onDelete: "RESTRICT" },
    entity_type: { type: "varchar(20)", notNull: true },
    entity_id: { type: "uuid", notNull: true },
    document_number: { type: "varchar(40)", notNull: true },
    storage_key: { type: "text", notNull: true },
    mime_type: { type: "varchar(100)", notNull: true, default: "application/pdf" },
    size_bytes: { type: "integer", notNull: true },
    checksum_sha256: { type: "varchar(64)", notNull: true },
    generated_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
    created_at: { type: "timestamptz", notNull: true, default: pgm.func("CURRENT_TIMESTAMP") },
  });

  pgm.addConstraint("procurement_documents", "procurement_documents_entity_type_check", {
    check: "entity_type IN ('IPO', 'DELIVERY_CHALLAN')",
  });
  // Exactly one stored authoritative rendering per business document — this
  // is also what makes the generation job safely idempotent on retry.
  pgm.addConstraint("procurement_documents", "procurement_documents_entity_key", {
    unique: ["entity_type", "entity_id"],
  });
  pgm.addConstraint("procurement_documents", "procurement_documents_size_check", {
    check: "size_bytes > 0",
  });
  pgm.createIndex("procurement_documents", "ipo_id");
  pgm.createIndex("procurement_documents", ["entity_type", "entity_id"]);

  // Issued document bytes are history: never rewritten, never deleted.
  pgm.sql(`
    CREATE TRIGGER procurement_documents_append_only
    BEFORE UPDATE OR DELETE ON procurement_documents
    FOR EACH ROW EXECUTE FUNCTION forbid_update_delete();
  `);

  pgm.sql("ALTER TABLE public.procurement_documents ENABLE ROW LEVEL SECURITY;");
}

export async function down(pgm) {
  pgm.dropTable("procurement_documents");
  pgm.dropConstraint("departments", "departments_whatsapp_destination_check");
  pgm.dropColumn("departments", "whatsapp_destination");

  pgm.sql("UPDATE notification_outbox SET status = 'VOID' WHERE status = 'DISABLED';");
  pgm.dropConstraint("notification_outbox", "notification_outbox_status_check");
  pgm.addConstraint("notification_outbox", "notification_outbox_status_check", {
    check: "status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SIMULATED', 'VOID', 'UNCERTAIN')",
  });

  pgm.dropConstraint("procurement_audit_log", "procurement_audit_log_action_check");
  pgm.addConstraint("procurement_audit_log", "procurement_audit_log_action_check", {
    check: `action IN (${AUDIT_ACTIONS.slice(0, 16)
      .map((a) => `'${a}'`)
      .join(", ")})`,
  });
}
