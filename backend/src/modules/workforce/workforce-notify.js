import { enqueue } from "../../shared/notifications/outbox.repository.js";

// Reuses the existing Gate Pass notification/outbox infrastructure
// unchanged (notification_outbox has no entity_type/event_type CHECK
// constraint restricting it to Gate Pass values, and the existing
// GET /api/v1/notifications listing is already generic) — see
// docs/DECISIONS.md. In-app only for this pass; WHATSAPP/SYSTEM delivery
// for Workforce events is future work. Only enqueued when the employee has
// a linked login (recipientUserId) — no login, no notification. Never
// includes a salary amount in payload — see docs/SECURITY.md.
export async function notifyEmployee(client, { employeeUserId, siteId, eventType, entityType, entityId, payload }) {
  if (!employeeUserId) return;

  await enqueue(client, [
    {
      channel: "IN_APP",
      eventType,
      entityType,
      entityId,
      recipientUserId: employeeUserId,
      recipientSiteId: siteId,
      payload,
    },
  ]);
}
