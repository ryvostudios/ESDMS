import pool from "../../config/database.js";

// Receiving carries no commercial data at all: a receiver confirms physical
// arrival, which never requires a price (spec §28, §50). There is nothing to
// redact in these projections because nothing priced is joined.
const RECEIPT_COLUMNS = `
  mr.id, mr.dc_id, mr.ipo_id, mr.department_id, mr.site_id, mr.receipt_type, mr.status,
  mr.received_by_user_id, mr.handover_to_user_id,
  mr.received_at, mr.handover_at, mr.confirmed_at, mr.has_discrepancy, mr.note,
  mr.created_at, mr.updated_at,
  dc.dc_number, i.ipo_number, md.demand_number,
  d.name AS department_name, s.name AS site_name,
  ru.full_name AS received_by_name,
  e.full_legal_name AS physical_receiver_name,
  hu.full_name AS handover_to_name,
  cu.full_name AS confirmed_by_name
`;

const RECEIPT_FROM = `
  FROM material_receipts mr
  JOIN delivery_challans dc ON dc.id = mr.dc_id
  JOIN ipos i ON i.id = mr.ipo_id
  JOIN material_demands md ON md.id = i.demand_id
  JOIN departments d ON d.id = mr.department_id
  JOIN sites s ON s.id = mr.site_id
  JOIN users ru ON ru.id = mr.received_by_user_id
  LEFT JOIN employees e ON e.id = mr.physical_receiver_employee_id
  LEFT JOIN users hu ON hu.id = mr.handover_to_user_id
  LEFT JOIN users cu ON cu.id = mr.confirmed_by_user_id
`;

export async function findReceiptById(clientOrPool, id) {
  const result = await clientOrPool.query(`SELECT ${RECEIPT_COLUMNS} ${RECEIPT_FROM} WHERE mr.id = $1`, [id]);
  return result.rows[0] || null;
}

export async function lockReceiptById(client, id) {
  const result = await client.query(
    `SELECT id, dc_id, ipo_id, department_id, site_id, receipt_type, status, received_by_user_id
     FROM material_receipts WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] || null;
}

export async function findReceiptLines(clientOrPool, receiptId) {
  const result = await clientOrPool.query(
    `SELECT id, line_no, dc_line_id, item_name_snapshot, uom_code_snapshot, uom_name_snapshot,
            dc_quantity, received_quantity, discrepancy_quantity, discrepancy_type, discrepancy_note
     FROM material_receipt_lines WHERE receipt_id = $1 ORDER BY line_no`,
    [receiptId],
  );
  return result.rows;
}

export async function insertReceipt(
  client,
  {
    dcId,
    ipoId,
    departmentId,
    siteId,
    receiptType,
    status,
    actorId,
    physicalReceiverEmployeeId,
    note,
    operationId,
  },
) {
  const result = await client.query(
    `INSERT INTO material_receipts
       (dc_id, ipo_id, department_id, site_id, receipt_type, status,
        received_by_user_id, physical_receiver_employee_id, note, operation_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, dc_id, ipo_id, department_id, site_id, receipt_type, status`,
    [
      dcId,
      ipoId,
      departmentId,
      siteId,
      receiptType,
      status,
      actorId,
      physicalReceiverEmployeeId || null,
      note || null,
      operationId,
    ],
  );
  return result.rows[0];
}

// Replay lookup for idempotent receiving — see receiving.service.js.
// The complete operation an operation id already owns — header plus its whole
// line set — so a retry can be told apart from a different request wearing the
// same id. Loaded inside the caller's transaction, under the Delivery Challan
// row lock it already holds.
export async function findReceiptOperationByOperationId(client, operationId) {
  const result = await client.query(
    `SELECT id, dc_id, receipt_type, physical_receiver_employee_id
     FROM material_receipts WHERE operation_id = $1`,
    [operationId],
  );
  const receipt = result.rows[0];
  if (!receipt) return null;

  const lines = await client.query(
    `SELECT dc_line_id, received_quantity, discrepancy_quantity, discrepancy_type
     FROM material_receipt_lines WHERE receipt_id = $1`,
    [receipt.id],
  );
  return { ...receipt, lines: lines.rows };
}

export async function insertReceiptLines(client, receiptId, dcId, lines) {
  let lineNo = 1;
  for (const line of lines) {
    await client.query(
      `INSERT INTO material_receipt_lines
         (receipt_id, dc_id, dc_line_id, line_no, item_name_snapshot, uom_code_snapshot, uom_name_snapshot,
          dc_quantity, received_quantity, discrepancy_quantity, discrepancy_type, discrepancy_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        receiptId,
        dcId,
        line.dcLineId,
        lineNo,
        line.item_name_snapshot,
        line.uom_code_snapshot,
        line.uom_name_snapshot,
        line.dc_quantity,
        line.receivedQuantity,
        line.discrepancyQuantity,
        line.discrepancyType || null,
        line.discrepancyNote || null,
      ],
    );
    lineNo += 1;
  }
}

export async function markHandoverComplete(client, id, recipientUserId) {
  await client.query(
    `UPDATE material_receipts
     SET status = 'PENDING_CONFIRMATION', handover_to_user_id = $2, handover_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, recipientUserId],
  );
}

export async function markConfirmed(client, id, actorId) {
  await client.query(
    `UPDATE material_receipts
     SET status = 'COMPLETED', confirmed_by_user_id = $2, confirmed_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, actorId],
  );
}

export async function findActiveEmployee(executor, employeeId, siteId) {
  const result = await executor.query(
    `SELECT id, full_legal_name FROM employees
     WHERE id = $1 AND status = 'ACTIVE' AND primary_site_id = $2`,
    [employeeId, siteId],
  );
  return result.rows[0] || null;
}

// Deliveries a receiver can still act on: finalized (or partly received) and
// not yet fully resolved.
export async function listOpenDeliveries({ siteId, departmentId }, { search, page, pageSize }) {
  const conditions = ["dc.status IN ('FINALIZED', 'RECEIVING')"];
  const values = [];

  values.push(siteId);
  conditions.push(`($${values.length}::uuid IS NULL OR dc.site_id = $${values.length})`);
  values.push(departmentId);
  conditions.push(`($${values.length}::uuid IS NULL OR dc.department_id = $${values.length})`);

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(dc.dc_number ILIKE $${values.length} OR i.ipo_number ILIKE $${values.length})`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const offset = (page - 1) * pageSize;
  values.push(pageSize, offset);

  const from = `
    FROM delivery_challans dc
    JOIN ipos i ON i.id = dc.ipo_id
    JOIN material_demands md ON md.id = i.demand_id
    JOIN departments d ON d.id = dc.department_id
    JOIN sites s ON s.id = dc.site_id
  `;

  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT dc.id, dc.dc_number, dc.status, dc.department_id, dc.site_id, dc.finalized_at,
              i.ipo_number, md.demand_number, d.name AS department_name, s.name AS site_name,
              (SELECT COUNT(*)::int FROM delivery_challan_lines WHERE dc_id = dc.id) AS line_count
       ${from} ${where}
       ORDER BY dc.finalized_at ASC NULLS LAST, dc.id ASC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    ),
    pool.query(`SELECT COUNT(*)::int AS total ${from} ${where}`, values.slice(0, -2)),
  ]);

  return { rows: rows.rows, total: count.rows[0].total };
}

export async function listReceipts(
  { siteId, departmentId, personalActorUserId = null },
  { status, search, page, pageSize },
) {
  const conditions = [];
  const values = [];

  values.push(siteId);
  conditions.push(`($${values.length}::uuid IS NULL OR mr.site_id = $${values.length})`);

  // Two independent reasons a receipt may be visible, ORed rather than ANDed:
  // the actor's ordinary organizational scope, and — for a fallback custodian
  // — the specific receipts they personally handled.
  //
  // `personalActorUserId` is set only on the fallback path. It ADDS those
  // receipts; it never widens the department clause, so fallback authority
  // still cannot become a view of another department's history.
  //
  // The final disjunct is the site-wide/ALL case, where neither restriction
  // applies. An OWN-tier actor with no department and no fallback authority
  // never reaches this query at all — the service returns nothing first.
  values.push(departmentId);
  const departmentParam = values.length;
  values.push(personalActorUserId);
  const personalParam = values.length;
  conditions.push(`(
    ($${departmentParam}::uuid IS NOT NULL AND mr.department_id = $${departmentParam})
    OR ($${personalParam}::uuid IS NOT NULL
        AND (mr.received_by_user_id = $${personalParam} OR mr.handover_to_user_id = $${personalParam}))
    OR ($${departmentParam}::uuid IS NULL AND $${personalParam}::uuid IS NULL)
  )`);

  if (status) {
    values.push(status);
    conditions.push(`mr.status = $${values.length}`);
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
      `SELECT ${RECEIPT_COLUMNS} ${RECEIPT_FROM} ${where}
       ORDER BY mr.received_at DESC, mr.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    ),
    pool.query(`SELECT COUNT(*)::int AS total ${RECEIPT_FROM} ${where}`, values.slice(0, -2)),
  ]);

  return { rows: rows.rows, total: count.rows[0].total };
}

export async function findReceiptsForDc(clientOrPool, dcId) {
  const result = await clientOrPool.query(
    `SELECT ${RECEIPT_COLUMNS} ${RECEIPT_FROM} WHERE mr.dc_id = $1 ORDER BY mr.received_at ASC`,
    [dcId],
  );
  return result.rows;
}
