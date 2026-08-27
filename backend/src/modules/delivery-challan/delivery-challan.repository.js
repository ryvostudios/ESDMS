import pool from "../../config/database.js";

// A Delivery Challan carries no commercial data at all — no estimated price,
// no actual price, no totals, no Procurement notes. That is a schema fact,
// not a projection choice: there is nothing here to redact, so a DC view or
// its PDF can never leak pricing to a receiver (spec §17, §28, §50).
const DC_COLUMNS = `
  dc.id, dc.dc_number, dc.ipo_id, dc.department_id, dc.site_id, dc.status, dc.note,
  dc.finalized_at, dc.completed_at, dc.cancelled_at, dc.cancellation_reason,
  dc.created_at, dc.updated_at,
  i.ipo_number, i.demand_id, md.demand_number,
  d.name AS department_name, s.name AS site_name,
  cu.full_name AS created_by_name, fu.full_name AS finalized_by_name, xu.full_name AS cancelled_by_name
`;

const DC_FROM = `
  FROM delivery_challans dc
  JOIN ipos i ON i.id = dc.ipo_id
  JOIN material_demands md ON md.id = i.demand_id
  JOIN departments d ON d.id = dc.department_id
  JOIN sites s ON s.id = dc.site_id
  JOIN users cu ON cu.id = dc.created_by_user_id
  LEFT JOIN users fu ON fu.id = dc.finalized_by_user_id
  LEFT JOIN users xu ON xu.id = dc.cancelled_by_user_id
`;

export async function findDcById(clientOrPool, id) {
  const result = await clientOrPool.query(`SELECT ${DC_COLUMNS} ${DC_FROM} WHERE dc.id = $1`, [id]);
  return result.rows[0] || null;
}

export async function lockDcById(client, id) {
  const result = await client.query(
    `SELECT id, dc_number, ipo_id, department_id, site_id, status, completed_at
     FROM delivery_challans WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] || null;
}

export async function insertDc(
  client,
  { dcNumber, ipoId, departmentId, siteId, note, actorId, operationId },
) {
  const result = await client.query(
    `INSERT INTO delivery_challans
       (dc_number, ipo_id, department_id, site_id, note, created_by_user_id, operation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, dc_number, status, ipo_id, department_id, site_id`,
    [dcNumber, ipoId, departmentId, siteId, note || null, actorId, operationId],
  );
  return result.rows[0];
}

// Replay lookup for idempotent creation — see delivery-challan.service.js.
export async function findDcByOperationId(client, operationId) {
  const result = await client.query(
    "SELECT id, ipo_id, department_id, site_id, status FROM delivery_challans WHERE operation_id = $1",
    [operationId],
  );
  return result.rows[0] || null;
}

export async function replaceDcLines(client, dcId, ipoId, lines) {
  await client.query("DELETE FROM delivery_challan_lines WHERE dc_id = $1", [dcId]);

  let lineNo = 1;
  for (const line of lines) {
    await client.query(
      `INSERT INTO delivery_challan_lines
         (dc_id, ipo_id, ipo_line_id, line_no, item_name_snapshot, uom_code_snapshot, uom_name_snapshot, quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        dcId,
        ipoId,
        line.ipoLineId,
        lineNo,
        line.item_name_snapshot,
        line.uom_code_snapshot,
        line.uom_name_snapshot,
        line.quantity,
      ],
    );
    lineNo += 1;
  }
}

export async function updateDcNote(client, id, note) {
  await client.query("UPDATE delivery_challans SET note = $2 WHERE id = $1", [id, note ?? null]);
}

// `received/discrepancy` count every recorded receipt; `confirmed` counts only
// receipts a department authority has actually closed. DC completion uses the
// confirmed figure, so an unconfirmed receipt can never close a delivery.
export async function findDcLines(clientOrPool, dcId) {
  const result = await clientOrPool.query(
    `SELECT dcl.id, dcl.line_no, dcl.ipo_line_id, dcl.item_name_snapshot,
            dcl.uom_code_snapshot, dcl.uom_name_snapshot, dcl.quantity,
            COALESCE(r.received, 0)::numeric(12,2) AS received_quantity,
            COALESCE(r.discrepancy, 0)::numeric(12,2) AS discrepancy_quantity,
            COALESCE(c.confirmed, 0)::numeric(12,2) AS confirmed_quantity,
            (dcl.quantity - COALESCE(r.received, 0) - COALESCE(r.discrepancy, 0))::numeric(12,2)
              AS unresolved_quantity
     FROM delivery_challan_lines dcl
     LEFT JOIN LATERAL (
       SELECT SUM(received_quantity) AS received, SUM(discrepancy_quantity) AS discrepancy
       FROM material_receipt_lines WHERE dc_line_id = dcl.id
     ) r ON true
     LEFT JOIN LATERAL (
       SELECT SUM(mrl.received_quantity + mrl.discrepancy_quantity) AS confirmed
       FROM material_receipt_lines mrl
       JOIN material_receipts mr ON mr.id = mrl.receipt_id
       WHERE mrl.dc_line_id = dcl.id AND mr.status = 'COMPLETED'
     ) c ON true
     WHERE dcl.dc_id = $1
     ORDER BY dcl.line_no`,
    [dcId],
  );
  return result.rows;
}

export async function markFinalized(client, id, actorId) {
  await client.query(
    `UPDATE delivery_challans
     SET status = 'FINALIZED', finalized_by_user_id = $2, finalized_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, actorId],
  );
}

export async function updateDcStatus(client, id, status) {
  await client.query("UPDATE delivery_challans SET status = $2 WHERE id = $1", [id, status]);
}

export async function markCompleted(client, id) {
  await client.query(
    "UPDATE delivery_challans SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1",
    [id],
  );
}

export async function markCancelled(client, id, actorId, reason) {
  await client.query(
    `UPDATE delivery_challans
     SET status = 'CANCELLED', cancelled_by_user_id = $2, cancelled_at = CURRENT_TIMESTAMP,
         cancellation_reason = $3
     WHERE id = $1`,
    [id, actorId, reason],
  );
}

export async function hasAnyReceipt(client, dcId) {
  const result = await client.query("SELECT 1 FROM material_receipts WHERE dc_id = $1 LIMIT 1", [dcId]);
  return result.rowCount > 0;
}

// A DC is complete only when every line's confirmed quantity equals its full
// challan quantity — received-and-department-confirmed, or explicitly
// recorded as a discrepancy. Nothing is inferred.
export async function countUnresolvedLines(client, dcId) {
  const result = await client.query(
    `SELECT COUNT(*)::int AS unresolved
     FROM delivery_challan_lines dcl
     LEFT JOIN LATERAL (
       SELECT COALESCE(SUM(mrl.received_quantity + mrl.discrepancy_quantity), 0) AS confirmed
       FROM material_receipt_lines mrl
       JOIN material_receipts mr ON mr.id = mrl.receipt_id
       WHERE mrl.dc_line_id = dcl.id AND mr.status = 'COMPLETED'
     ) c ON true
     WHERE dcl.dc_id = $1 AND c.confirmed < dcl.quantity`,
    [dcId],
  );
  return result.rows[0].unresolved;
}

export async function listDcs({ siteId, departmentId }, { ipoId, status, search, page, pageSize }) {
  const conditions = [];
  const values = [];

  values.push(siteId);
  conditions.push(`($${values.length}::uuid IS NULL OR dc.site_id = $${values.length})`);
  values.push(departmentId);
  conditions.push(`($${values.length}::uuid IS NULL OR dc.department_id = $${values.length})`);

  if (ipoId) {
    values.push(ipoId);
    conditions.push(`dc.ipo_id = $${values.length}`);
  }
  if (status) {
    values.push(status);
    conditions.push(`dc.status = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(dc.dc_number ILIKE $${values.length} OR i.ipo_number ILIKE $${values.length})`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const offset = (page - 1) * pageSize;
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT ${DC_COLUMNS},
              (SELECT COUNT(*)::int FROM delivery_challan_lines WHERE dc_id = dc.id) AS line_count
       ${DC_FROM} ${where}
       ORDER BY dc.created_at DESC, dc.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    ),
    pool.query(`SELECT COUNT(*)::int AS total ${DC_FROM} ${where}`, values.slice(0, -2)),
  ]);

  return { rows: rows.rows, total: count.rows[0].total };
}
