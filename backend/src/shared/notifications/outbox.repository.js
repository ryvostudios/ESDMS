import pool from "../../config/database.js";

export async function enqueue(client, notifications) {
  for (const notification of notifications) {
    // recipientSiteId is required for every row, not just role-targeted
    // ones — a single authoritative source (the Gate Pass the
    // notification is about) for every future join/filter, and it means
    // a role-targeted row can never accidentally be enqueued without it.
    if (!notification.recipientSiteId) {
      throw new Error(`enqueue: recipientSiteId is required (event ${notification.eventType}).`);
    }

    await client.query(
      `INSERT INTO notification_outbox
         (channel, event_type, entity_type, entity_id, recipient_user_id,
          recipient_role, recipient_site_id, recipient_phone, payload, status, sent_at, idempotency_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [
        notification.channel,
        notification.eventType,
        notification.entityType,
        notification.entityId,
        notification.recipientUserId || null,
        notification.recipientRole || null,
        notification.recipientSiteId,
        notification.recipientPhone || null,
        JSON.stringify(notification.payload),
        // IN_APP has no external delivery step — it becomes visible to its
        // recipient the moment it is written, so it is SENT immediately.
        // WHATSAPP and SYSTEM jobs require a background step, so they start
        // PENDING for a worker to claim.
        notification.channel === "IN_APP" ? "SENT" : "PENDING",
        notification.channel === "IN_APP" ? new Date() : null,
        notification.idempotencyKey || null,
      ],
    );
  }
}

// Atomic claim: FOR UPDATE SKIP LOCKED lets multiple worker processes poll
// the same table concurrently without ever double-claiming a row.
//
// Eligible rows are PENDING/FAILED (always claimable — locked_at is NULL
// for both, they were never mid-claim) OR PROCESSING whose lease has
// expired: a worker that crashed mid-send left the row PROCESSING with a
// locked_at that just keeps aging, and without this branch nothing ever
// looks at status = 'PROCESSING' again — it would be stuck forever.
const LEASE_MINUTES = 5;
const MAX_ATTEMPTS = 5;

export async function claimBatch(channel, limit = 20) {
  const result = await pool.query(
    `WITH claimed AS (
       SELECT id FROM notification_outbox
       WHERE channel = $1
         AND attempts < $2
         AND (
           status IN ('PENDING', 'FAILED')
           OR (status = 'PROCESSING' AND locked_at < now() - interval '${LEASE_MINUTES} minutes')
         )
       ORDER BY created_at ASC
       LIMIT $3
       FOR UPDATE SKIP LOCKED
     )
     UPDATE notification_outbox o
     SET status = 'PROCESSING', locked_at = now()
     FROM claimed
     WHERE o.id = claimed.id
     RETURNING o.*`,
    [channel, MAX_ATTEMPTS, limit],
  );

  return result.rows;
}

// Cancellation's defense-in-depth layer 1: any not-yet-claimed delivery
// work for this entity can never run. (Layer 2 is each worker re-checking
// authoritative Gate Pass state itself — see gate-pass.service.js and
// outbox.processor.js — for the race where a job was already PROCESSING
// when cancellation happened.) History is kept, not deleted: VOID is a
// terminal status like SENT/FAILED, still visible for audit.
export async function voidPending(client, entityType, entityId) {
  await client.query(
    `UPDATE notification_outbox
     SET status = 'VOID', locked_at = NULL
     WHERE entity_type = $1 AND entity_id = $2 AND status IN ('PENDING', 'FAILED')`,
    [entityType, entityId],
  );
}

export async function markDelivered(client, id, status, providerMessageId) {
  await client.query(
    `UPDATE notification_outbox
     SET status = $2, sent_at = CURRENT_TIMESTAMP, last_error = NULL, locked_at = NULL,
         payload = payload || jsonb_build_object('providerMessageId', $3::text)
     WHERE id = $1`,
    [id, status, providerMessageId ?? null],
  );
}

export async function markFailed(client, id, errorMessage) {
  await client.query(
    `UPDATE notification_outbox
     SET status = 'FAILED', attempts = attempts + 1, last_error = $2, locked_at = NULL
     WHERE id = $1`,
    [id, errorMessage],
  );
}

// Addressed to this exact user, OR to this user's role at this user's own
// site — never just the role. recipient_site_id is written authoritatively
// from the source Gate Pass at enqueue time (see gate-pass.service.js), so
// this is a real boundary, not a client-suppliable filter.
export async function listInApp(user) {
  const result = await pool.query(
    `SELECT id, event_type, entity_type, entity_id, payload, created_at
     FROM notification_outbox
     WHERE channel = 'IN_APP'
       AND (recipient_user_id = $1 OR (recipient_role = $2 AND recipient_site_id = $3))
     ORDER BY created_at DESC
     LIMIT 50`,
    [user.id, user.role, user.siteId],
  );

  return result.rows;
}
