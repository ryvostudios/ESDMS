export const shorthands = undefined;

// A role-targeted notification (recipient_role = 'GATE_GUARD') was
// effectively global — every Guard at every site would see it. Adding an
// authoritative recipient_site_id, always set from the entity's own site at
// enqueue time (never trusted from a filter param), closes that: listing
// only ever returns rows addressed to the caller directly, or to the
// caller's own role AND own site.
//
// VOID is added to the status enum for Fix #6 (cancellation must void
// pending delivery) — a job whose Gate Pass was cancelled before it ran is
// marked VOID rather than deleted, preserving audit history while making
// it permanently unclaimable.
export async function up(pgm) {
  pgm.addColumn("notification_outbox", {
    recipient_site_id: { type: "uuid", references: "sites", onDelete: "RESTRICT" },
  });

  // Backfill from the Gate Pass each existing row is about — the only
  // entity_type this table has ever held.
  pgm.sql(`
    UPDATE notification_outbox o
    SET recipient_site_id = gp.site_id
    FROM gate_passes gp
    WHERE o.entity_type = 'GATE_PASS' AND o.entity_id = gp.id AND o.recipient_site_id IS NULL;
  `);

  pgm.alterColumn("notification_outbox", "recipient_site_id", { notNull: true });
  pgm.createIndex("notification_outbox", ["recipient_role", "recipient_site_id"]);

  pgm.dropConstraint("notification_outbox", "notification_outbox_status_check");
  pgm.addConstraint("notification_outbox", "notification_outbox_status_check", {
    check: "status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SIMULATED', 'VOID')",
  });
}

export async function down(pgm) {
  pgm.dropConstraint("notification_outbox", "notification_outbox_status_check");
  pgm.addConstraint("notification_outbox", "notification_outbox_status_check", {
    check: "status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SIMULATED')",
  });

  pgm.dropColumns("notification_outbox", ["recipient_site_id"]);
}
