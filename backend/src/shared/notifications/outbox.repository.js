import pool from "../../config/database.js";

export async function enqueue(client, notifications) {
  for (const notification of notifications) {
    await client.query(
      `INSERT INTO notification_outbox
         (channel, event_type, entity_type, entity_id, recipient_user_id,
          recipient_role, recipient_phone, payload, status, sent_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        notification.channel,
        notification.eventType,
        notification.entityType,
        notification.entityId,
        notification.recipientUserId || null,
        notification.recipientRole || null,
        notification.recipientPhone || null,
        JSON.stringify(notification.payload),
        // IN_APP has no external delivery step — it becomes visible to its
        // recipient the moment it is written, so it is SENT immediately.
        // WHATSAPP requires an external call, so it starts PENDING for the
        // background processor to pick up.
        notification.channel === "IN_APP" ? "SENT" : "PENDING",
        notification.channel === "IN_APP" ? new Date() : null,
      ],
    );
  }
}

export async function findPendingWhatsApp(limit = 20) {
  const result = await pool.query(
    `SELECT * FROM notification_outbox
     WHERE channel = 'WHATSAPP' AND status IN ('PENDING', 'FAILED') AND attempts < 5
     ORDER BY created_at ASC
     LIMIT $1`,
    [limit],
  );

  return result.rows;
}

export async function markDelivered(id, status, providerMessageId) {
  await pool.query(
    `UPDATE notification_outbox
     SET status = $2, sent_at = CURRENT_TIMESTAMP, last_error = NULL,
         payload = payload || jsonb_build_object('providerMessageId', $3::text)
     WHERE id = $1`,
    [id, status, providerMessageId],
  );
}

export async function markFailed(id, errorMessage) {
  await pool.query(
    `UPDATE notification_outbox
     SET status = 'FAILED', attempts = attempts + 1, last_error = $2
     WHERE id = $1`,
    [id, errorMessage],
  );
}

export async function listInApp(user) {
  const result = await pool.query(
    `SELECT id, event_type, entity_type, entity_id, payload, created_at
     FROM notification_outbox
     WHERE channel = 'IN_APP'
       AND (recipient_user_id = $1 OR recipient_role = $2)
     ORDER BY created_at DESC
     LIMIT 50`,
    [user.id, user.role],
  );

  return result.rows;
}
