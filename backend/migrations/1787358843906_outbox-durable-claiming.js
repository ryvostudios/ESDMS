export const shorthands = undefined;

// Supports atomic claiming (FOR UPDATE SKIP LOCKED) and crash recovery: a
// worker that dies mid-send leaves a row PROCESSING with a stale locked_at,
// which becomes reclaimable once its lease age passes. idempotency_key lets
// a retried enqueue (e.g. the PDF-generation job re-deriving its WhatsApp
// follow-up job) be a safe no-op instead of a duplicate send.
export async function up(pgm) {
  pgm.addColumn("notification_outbox", {
    idempotency_key: { type: "varchar(200)", unique: true },
    locked_at: { type: "timestamptz" },
  });

  pgm.dropConstraint("notification_outbox", "notification_outbox_channel_check");
  pgm.addConstraint("notification_outbox", "notification_outbox_channel_check", {
    check: "channel IN ('IN_APP', 'WHATSAPP', 'SYSTEM')",
  });

  pgm.dropConstraint("notification_outbox", "notification_outbox_status_check");
  pgm.addConstraint("notification_outbox", "notification_outbox_status_check", {
    check: "status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SIMULATED')",
  });
}

export async function down(pgm) {
  pgm.dropConstraint("notification_outbox", "notification_outbox_status_check");
  pgm.addConstraint("notification_outbox", "notification_outbox_status_check", {
    check: "status IN ('PENDING', 'SENT', 'FAILED', 'SIMULATED')",
  });

  pgm.dropConstraint("notification_outbox", "notification_outbox_channel_check");
  pgm.addConstraint("notification_outbox", "notification_outbox_channel_check", {
    check: "channel IN ('IN_APP', 'WHATSAPP')",
  });

  pgm.dropColumns("notification_outbox", ["idempotency_key", "locked_at"]);
}
