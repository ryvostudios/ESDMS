import { asyncHandler } from "../http/async-handler.js";
import { listInApp } from "./outbox.repository.js";

export const list = asyncHandler(async (req, res) => {
  const rows = await listInApp(req.user);

  res.status(200).json({
    success: true,
    data: rows.map((row) => ({
      id: row.id,
      eventType: row.event_type,
      entityType: row.entity_type,
      entityId: row.entity_id,
      payload: row.payload,
      createdAt: row.created_at,
    })),
  });
});
