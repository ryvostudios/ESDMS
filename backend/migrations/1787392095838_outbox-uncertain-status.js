export const shorthands = undefined;

// A provider can accept a message and then the worker can crash before
// recording the outcome — at that point "did it actually send?" is
// genuinely unknown, not a retryable failure and not a confirmed success.
// Blindly retrying risks a real duplicate message; blindly marking it
// FAILED (and thus retryable) risks the same. UNCERTAIN is a distinct
// terminal-for-automatic-purposes status: not retried by claimBatch (it
// isn't PENDING/FAILED/stale-PROCESSING), left for manual reconciliation
// against the provider's own delivery records.
export async function up(pgm) {
  pgm.dropConstraint("notification_outbox", "notification_outbox_status_check");
  pgm.addConstraint("notification_outbox", "notification_outbox_status_check", {
    check: "status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SIMULATED', 'VOID', 'UNCERTAIN')",
  });
}

export async function down(pgm) {
  pgm.dropConstraint("notification_outbox", "notification_outbox_status_check");
  pgm.addConstraint("notification_outbox", "notification_outbox_status_check", {
    check: "status IN ('PENDING', 'PROCESSING', 'SENT', 'FAILED', 'SIMULATED', 'VOID')",
  });
}
