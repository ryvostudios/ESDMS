// Append-only audit for the whole purchasing chain (IPO -> Delivery Challan
// -> Receiving). One stream keyed by ipo_id, because that is the unit the
// history/traceability view actually reads; entity_type/entity_id name the
// specific record each event happened to. The table forbids UPDATE/DELETE at
// the database level (forbid_update_delete()), exactly like
// gate_pass_audit_log and governance_audit_log.
//
// Never pass confidential commercial values (unit prices, totals, internal
// Procurement notes) into `metadata` — audit rows are readable by anyone
// authorized to view the record's history, which is a wider audience than
// the price-view capability (docs/SECURITY.md, spec §52). Quantities and
// identifiers are operational and are fine.
export async function recordProcurementAudit(
  client,
  { ipoId, entityType, entityId, actorUserId, action, previousStatus = null, newStatus = null, metadata = null },
) {
  await client.query(
    `INSERT INTO procurement_audit_log
       (ipo_id, entity_type, entity_id, actor_user_id, action, previous_status, new_status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)`,
    [
      ipoId,
      entityType,
      entityId,
      actorUserId,
      action,
      previousStatus,
      newStatus,
      metadata ? JSON.stringify(metadata) : null,
    ],
  );
}

export async function findAuditByIpoId(clientOrPool, ipoId) {
  const result = await clientOrPool.query(
    `SELECT a.id, a.entity_type, a.entity_id, a.action, a.previous_status, a.new_status,
            a.metadata, a.created_at, a.actor_user_id, u.full_name AS actor_name
     FROM procurement_audit_log a
     JOIN users u ON u.id = a.actor_user_id
     WHERE a.ipo_id = $1
     ORDER BY a.created_at ASC, a.id ASC`,
    [ipoId],
  );
  return result.rows;
}
