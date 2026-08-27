import pool from "../../config/database.js";

const IPO_COLUMNS = `
  i.id, i.ipo_number, i.demand_id, i.demand_revision, i.pricing_id, i.status, i.currency,
  i.site_id, i.department_id, i.generated_at, i.acknowledged_at, i.purchasing_closed_at,
  i.completed_at, i.cancelled_at, i.cancellation_category, i.cancellation_reason,
  i.created_at, i.updated_at,
  s.name AS site_name, d.name AS department_name,
  md.demand_number, md.status AS demand_status,
  gu.full_name AS generated_by_name, au.full_name AS acknowledged_by_name,
  cu.full_name AS cancelled_by_name
`;

const IPO_FROM = `
  FROM ipos i
  JOIN sites s ON s.id = i.site_id
  JOIN departments d ON d.id = i.department_id
  JOIN material_demands md ON md.id = i.demand_id
  JOIN users gu ON gu.id = i.generated_by_user_id
  LEFT JOIN users au ON au.id = i.acknowledged_by_user_id
  LEFT JOIN users cu ON cu.id = i.cancelled_by_user_id
`;

// estimated_total is deliberately NOT in IPO_COLUMNS: it is commercial data
// and is attached only by the service, only for an actor with price
// authority. The projection, not a React filter, is the boundary.
export async function findIpoById(clientOrPool, id) {
  const result = await clientOrPool.query(`SELECT ${IPO_COLUMNS} ${IPO_FROM} WHERE i.id = $1`, [id]);
  return result.rows[0] || null;
}

export async function findIpoCommercials(clientOrPool, id) {
  const result = await clientOrPool.query("SELECT estimated_total FROM ipos WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function lockIpoById(client, id) {
  const result = await client.query(
    `SELECT id, ipo_number, demand_id, demand_revision, status, site_id, department_id,
            purchasing_closed_at, completed_at
     FROM ipos WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] || null;
}

export async function findIpoByDemandRevision(client, demandId, revision) {
  const result = await client.query(
    "SELECT id, ipo_number, status FROM ipos WHERE demand_id = $1 AND demand_revision = $2",
    [demandId, revision],
  );
  return result.rows[0] || null;
}

// The approved snapshot source: exactly the Demand revision's lines joined to
// exactly the approved Pricing version's lines. company_item_id comes from
// the catalog entry the Demand line was pinned to, so later purchasing
// history can be looked up by physical item identity.
export async function findApprovedSnapshotLines(client, demandId, pricingId) {
  const result = await client.query(
    `SELECT mdl.id AS demand_line_id, mdl.line_no, mdl.item_name_snapshot,
            mdl.uom_code_snapshot, mdl.uom_name_snapshot, mdl.requested_quantity,
            mdpl.estimated_unit_price, dmc.company_item_id
     FROM material_demand_lines mdl
     JOIN material_demand_pricing_lines mdpl
       ON mdpl.demand_line_id = mdl.id AND mdpl.pricing_id = $2
     JOIN department_material_catalog dmc ON dmc.id = mdl.catalog_entry_id
     LEFT JOIN material_demand_line_dispositions d
       ON d.demand_line_id = mdl.id AND d.pricing_id = $2
     WHERE mdl.demand_id = $1
       -- A line management excluded (typically "out of budget") never
       -- reaches the IPO. It is not deleted: the Demand line, its quantity,
       -- its price and the exclusion decision all remain as history and as a
       -- carry-forward candidate.
       AND COALESCE(d.disposition, 'APPROVED_FOR_PURCHASE') = 'APPROVED_FOR_PURCHASE'
     ORDER BY mdl.line_no`,
    [demandId, pricingId],
  );
  return result.rows;
}

// The IPO's committed value covers exactly the lines the IPO contains —
// excluded lines are not budgeted for and must not inflate it.
export async function computeApprovedTotal(client, pricingId) {
  const result = await client.query(
    `SELECT COALESCE(SUM(mdl.requested_quantity * mdpl.estimated_unit_price), 0)::numeric(26,2) AS total
     FROM material_demand_pricing_lines mdpl
     JOIN material_demand_lines mdl ON mdl.id = mdpl.demand_line_id
     LEFT JOIN material_demand_line_dispositions d
       ON d.demand_line_id = mdl.id AND d.pricing_id = mdpl.pricing_id
     WHERE mdpl.pricing_id = $1
       AND COALESCE(d.disposition, 'APPROVED_FOR_PURCHASE') = 'APPROVED_FOR_PURCHASE'`,
    [pricingId],
  );
  return result.rows[0].total;
}

export async function insertIpo(
  client,
  {
    ipoNumber,
    demandId,
    demandRevision,
    pricingId,
    dispositionFingerprint,
    siteId,
    departmentId,
    currency,
    estimatedTotal,
    actorId,
  },
) {
  const result = await client.query(
    `INSERT INTO ipos
       (ipo_number, demand_id, demand_revision, pricing_id, disposition_fingerprint, site_id,
        department_id, currency, estimated_total, generated_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, ipo_number, status, demand_id, demand_revision, site_id, department_id`,
    [
      ipoNumber,
      demandId,
      demandRevision,
      pricingId,
      dispositionFingerprint,
      siteId,
      departmentId,
      currency,
      estimatedTotal,
      actorId,
    ],
  );
  return result.rows[0];
}

export async function insertIpoLines(client, ipoId, demandId, lines) {
  for (const line of lines) {
    await client.query(
      `INSERT INTO ipo_lines
         (ipo_id, demand_id, demand_line_id, line_no, company_item_id, item_name_snapshot,
          uom_code_snapshot, uom_name_snapshot, approved_quantity, estimated_unit_price)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        ipoId,
        demandId,
        line.demand_line_id,
        line.line_no,
        line.company_item_id,
        line.item_name_snapshot,
        line.uom_code_snapshot,
        line.uom_name_snapshot,
        line.requested_quantity,
        line.estimated_unit_price,
      ],
    );
  }
}

// Operational line projection — no price columns at all. `allocated_quantity`
// and `received_quantity` keep Requested/Approved/Purchased/Delivered/
// Received independently visible; none of them is ever collapsed into
// another (spec §30).
const LINE_OPERATIONAL_COLUMNS = `
  il.id, il.line_no, il.demand_line_id, il.company_item_id, il.item_name_snapshot,
  il.uom_code_snapshot, il.uom_name_snapshot, il.approved_quantity,
  il.purchased_quantity, il.purchase_status,
  -- When the line was last bought, derived from its events rather than a
  -- column that a multi-event purchase would have made ambiguous.
  (SELECT max(purchased_at) FROM ipo_purchase_events WHERE ipo_line_id = il.id) AS purchased_at,
  (il.approved_quantity - il.purchased_quantity)::numeric(12,2) AS outstanding_quantity,
  COALESCE(alloc.allocated_quantity, 0)::numeric(12,2) AS allocated_quantity,
  COALESCE(recv.received_quantity, 0)::numeric(12,2) AS received_quantity,
  COALESCE(recv.discrepancy_quantity, 0)::numeric(12,2) AS discrepancy_quantity
`;

const LINE_AGGREGATES = `
  LEFT JOIN LATERAL (
    SELECT SUM(dcl.quantity) AS allocated_quantity
    FROM delivery_challan_lines dcl
    JOIN delivery_challans dc ON dc.id = dcl.dc_id
    WHERE dcl.ipo_line_id = il.id AND dc.status <> 'CANCELLED'
  ) alloc ON true
  LEFT JOIN LATERAL (
    SELECT SUM(mrl.received_quantity) AS received_quantity,
           SUM(mrl.discrepancy_quantity) AS discrepancy_quantity
    FROM material_receipt_lines mrl
    JOIN delivery_challan_lines dcl2 ON dcl2.id = mrl.dc_line_id
    JOIN delivery_challans dc2 ON dc2.id = dcl2.dc_id
    WHERE dcl2.ipo_line_id = il.id AND dc2.status <> 'CANCELLED'
  ) recv ON true
`;

export async function findIpoLines(clientOrPool, ipoId, { includeCommercial }) {
  // Actual money is derived from the purchase EVENTS, never from a single
  // cumulative price column — a line bought 60 @ 100 then 20 @ 110 has a real
  // total of 8,200, which no "latest price × total quantity" shortcut can
  // produce. `latest_actual_unit_price` is the most recent event's price and
  // is what Previous Purchase Price uses.
  const commercial = includeCommercial
    ? `, il.estimated_unit_price, il.procurement_note,
       (il.approved_quantity * il.estimated_unit_price)::numeric(26,2) AS estimated_line_total,
       ev.latest_actual_unit_price AS actual_unit_price,
       ev.actual_line_total,
       ev.purchase_event_count`
    : "";
  const commercialJoin = includeCommercial
    ? `LEFT JOIN LATERAL (
         SELECT SUM(e.quantity * e.actual_unit_price)::numeric(26,2) AS actual_line_total,
                COUNT(*)::int AS purchase_event_count,
                (SELECT p.actual_unit_price FROM ipo_purchase_events p
                  WHERE p.ipo_line_id = il.id
                    AND p.reverses_purchase_event_id IS NULL
                    AND p.quantity > COALESCE((
                          SELECT SUM(-r.quantity) FROM ipo_purchase_events r
                          WHERE r.reverses_purchase_event_id = p.id
                        ), 0)
                  ORDER BY p.purchased_at DESC, p.id DESC LIMIT 1)
                  AS latest_actual_unit_price
         FROM ipo_purchase_events e WHERE e.ipo_line_id = il.id
       ) ev ON true`
    : "";

  const result = await clientOrPool.query(
    `SELECT ${LINE_OPERATIONAL_COLUMNS}${commercial}
     FROM ipo_lines il
     ${LINE_AGGREGATES}
     ${commercialJoin}
     WHERE il.ipo_id = $1
     ORDER BY il.line_no`,
    [ipoId],
  );
  return result.rows;
}

export async function findPurchaseEvents(clientOrPool, ipoId) {
  const result = await clientOrPool.query(
    `SELECT e.id, e.ipo_line_id, e.quantity, e.actual_unit_price,
            (e.quantity * e.actual_unit_price)::numeric(26,2) AS event_total,
            e.reverses_purchase_event_id, e.procurement_note, e.purchased_at,
            u.full_name AS purchased_by_name,
            CASE WHEN e.quantity > 0 THEN
              (e.quantity - COALESCE((
                SELECT SUM(-r.quantity) FROM ipo_purchase_events r
                WHERE r.reverses_purchase_event_id = e.id
              ), 0))::numeric(12,2)
            END AS remaining_quantity
     FROM ipo_purchase_events e
     JOIN users u ON u.id = e.purchased_by_user_id
     WHERE e.ipo_id = $1
     ORDER BY e.purchased_at ASC, e.id ASC`,
    [ipoId],
  );
  return result.rows;
}

// A purchase operation id owns a SET of events — one per line of the request,
// which is why uniqueness is (operation_id, ipo_line_id) rather than global.
// Replay detection therefore has to read the whole set, and enough of each row
// to tell a genuine retry from a different request wearing the same id.
export async function findPurchaseEventsByOperationId(client, operationId) {
  const result = await client.query(
    `SELECT ipo_id, ipo_line_id, quantity, actual_unit_price, reverses_purchase_event_id
     FROM ipo_purchase_events
     WHERE operation_id = $1`,
    [operationId],
  );
  return result.rows;
}

// Classifier for per-operation advisory locks. Arbitrary but constant, and
// used for nothing else, so the (key, hash) pair cannot collide with an
// unrelated advisory lock.
const PURCHASE_OPERATION_LOCK_KEY = 517340982;

// Two requests carrying the same operation id may target different IPOs, so
// no row lock they take can serialize them. Without this, both would read an
// empty event set and both would insert — leaving one id owning two unrelated
// purchases. Transaction-scoped: released on COMMIT/ROLLBACK.
//
// Acquired BEFORE any row lock, so it is always the outermost lock in the
// transaction and can never be waited on by a holder of an IPO row lock.
export async function acquirePurchaseOperationLock(client, operationId) {
  await client.query("SELECT pg_advisory_xact_lock($1, hashtext($2))", [
    PURCHASE_OPERATION_LOCK_KEY,
    operationId,
  ]);
}

export async function insertPurchaseEvent(
  client,
  {
    ipoId,
    ipoLineId,
    quantity,
    actualUnitPrice,
    procurementNote,
    actorId,
    operationId,
    reversesPurchaseEventId = null,
  },
) {
  await client.query(
    `INSERT INTO ipo_purchase_events
       (ipo_id, ipo_line_id, quantity, actual_unit_price, procurement_note, purchased_by_user_id,
        operation_id, reverses_purchase_event_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      ipoId,
      ipoLineId,
      quantity,
      actualUnitPrice,
      procurementNote || null,
      actorId,
      operationId,
      reversesPurchaseEventId,
    ],
  );
}

// The purchase a correction is about to reverse, with how much of it is still
// reversible. Locked FOR UPDATE so two concurrent corrections of the same
// purchase serialize rather than both reading the same remaining balance; the
// database trigger re-checks the identical arithmetic as the final guarantee.
export async function lockPurchaseEventForReversal(client, eventId) {
  const result = await client.query(
    `SELECT e.id, e.ipo_id, e.ipo_line_id, e.quantity, e.actual_unit_price,
            e.reverses_purchase_event_id,
            COALESCE((
              SELECT SUM(-r.quantity) FROM ipo_purchase_events r
              WHERE r.reverses_purchase_event_id = e.id
            ), 0)::numeric(12,2) AS already_reversed
     FROM ipo_purchase_events e
     WHERE e.id = $1
     FOR UPDATE`,
    [eventId],
  );
  return result.rows[0] || null;
}

// Recomputes the line aggregate from its authoritative events, in SQL, so the
// stored total is always exactly the sum of what was actually recorded. The
// deferred constraint trigger on ipo_lines re-verifies this at commit.
export async function refreshPurchasedQuantity(client, ipoLineId) {
  const result = await client.query(
    `UPDATE ipo_lines il
     SET purchased_quantity = agg.total,
         purchase_status = CASE
           WHEN agg.total = 0 THEN 'NOT_PURCHASED'
           WHEN agg.total < il.approved_quantity THEN 'PARTIALLY_PURCHASED'
           ELSE 'PURCHASED'
         END
     FROM (
       SELECT COALESCE(SUM(quantity), 0)::numeric(12,2) AS total
       FROM ipo_purchase_events WHERE ipo_line_id = $1
     ) agg
     WHERE il.id = $1
     RETURNING il.purchased_quantity, il.purchase_status`,
    [ipoLineId],
  );
  return result.rows[0];
}

export async function lockIpoLines(client, ipoId) {
  const result = await client.query(
    `SELECT id, approved_quantity, purchased_quantity, purchase_status
     FROM ipo_lines WHERE ipo_id = $1 ORDER BY line_no FOR UPDATE`,
    [ipoId],
  );
  return result.rows;
}

export async function allocatedQuantityByLine(client, ipoId) {
  const result = await client.query(
    `SELECT dcl.ipo_line_id, COALESCE(SUM(dcl.quantity), 0)::numeric(12,2) AS allocated
     FROM delivery_challan_lines dcl
     JOIN delivery_challans dc ON dc.id = dcl.dc_id
     WHERE dcl.ipo_id = $1 AND dc.status <> 'CANCELLED'
     GROUP BY dcl.ipo_line_id`,
    [ipoId],
  );
  return new Map(result.rows.map((row) => [row.ipo_line_id, row.allocated]));
}

export async function updateIpoStatus(client, id, status) {
  await client.query("UPDATE ipos SET status = $2 WHERE id = $1", [id, status]);
}

export async function markAcknowledged(client, id, actorId) {
  await client.query(
    `UPDATE ipos SET status = 'ACKNOWLEDGED', acknowledged_by_user_id = $2, acknowledged_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, actorId],
  );
}

export async function markPurchasingClosed(client, id, actorId) {
  await client.query(
    `UPDATE ipos SET purchasing_closed_by_user_id = $2, purchasing_closed_at = CURRENT_TIMESTAMP WHERE id = $1`,
    [id, actorId],
  );
}

export async function markCompleted(client, id) {
  await client.query(
    "UPDATE ipos SET status = 'COMPLETED', completed_at = CURRENT_TIMESTAMP WHERE id = $1",
    [id],
  );
}

export async function markCancelled(client, id, actorId, category, reason) {
  await client.query(
    `UPDATE ipos
     SET status = 'CANCELLED', cancelled_by_user_id = $2, cancelled_at = CURRENT_TIMESTAMP,
         cancellation_category = $3, cancellation_reason = $4
     WHERE id = $1`,
    [id, actorId, category, reason],
  );
}

export async function hasRecordedPurchases(client, ipoId) {
  const result = await client.query(
    "SELECT 1 FROM ipo_lines WHERE ipo_id = $1 AND purchased_quantity > 0 LIMIT 1",
    [ipoId],
  );
  return result.rowCount > 0;
}

export async function countOpenDeliveryChallans(client, ipoId) {
  const result = await client.query(
    "SELECT COUNT(*)::int AS total FROM delivery_challans WHERE ipo_id = $1 AND status <> 'CANCELLED'",
    [ipoId],
  );
  return result.rows[0].total;
}

// Completion evidence, computed in SQL so no partially-resolved chain can be
// closed by an optimistic in-process count:
//   unallocated  — purchased material never put on any live Delivery Challan
//   openChallans — any DC not yet COMPLETED (and not CANCELLED)
export async function findCompletionBlockers(client, ipoId) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*)::int
        FROM ipo_lines il
        LEFT JOIN LATERAL (
          SELECT COALESCE(SUM(dcl.quantity), 0) AS allocated
          FROM delivery_challan_lines dcl
          JOIN delivery_challans dc ON dc.id = dcl.dc_id
          WHERE dcl.ipo_line_id = il.id AND dc.status <> 'CANCELLED'
        ) a ON true
        WHERE il.ipo_id = $1 AND il.purchased_quantity > a.allocated) AS unallocated,
       (SELECT COUNT(*)::int FROM delivery_challans
        WHERE ipo_id = $1 AND status NOT IN ('COMPLETED', 'CANCELLED')) AS open_challans`,
    [ipoId],
  );
  return result.rows[0];
}

export async function listIpos({ siteId, departmentId }, { status, search, page, pageSize }) {
  const conditions = [];
  const values = [];

  values.push(siteId);
  conditions.push(`($${values.length}::uuid IS NULL OR i.site_id = $${values.length})`);
  values.push(departmentId);
  conditions.push(`($${values.length}::uuid IS NULL OR i.department_id = $${values.length})`);

  if (status) {
    values.push(status);
    conditions.push(`i.status = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`(i.ipo_number ILIKE $${values.length} OR md.demand_number ILIKE $${values.length})`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const offset = (page - 1) * pageSize;
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT ${IPO_COLUMNS},
              (SELECT COUNT(*)::int FROM ipo_lines WHERE ipo_id = i.id) AS line_count,
              (SELECT COUNT(*)::int FROM ipo_lines
               WHERE ipo_id = i.id AND purchase_status = 'PURCHASED') AS purchased_line_count
       ${IPO_FROM} ${where}
       ORDER BY i.generated_at DESC, i.id DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    ),
    pool.query(`SELECT COUNT(*)::int AS total ${IPO_FROM} ${where}`, values.slice(0, -2)),
  ]);

  return { rows: rows.rows, total: count.rows[0].total };
}

// Previous Purchase Price — from ACTUAL finalized purchasing history only,
// never from an old estimate. Cancelled IPOs are excluded; scope is applied
// by the caller passing siteId (null for company-wide actors).
// Previous Actual Price comes ONLY from purchasing that is genuinely
// finalized: the IPO is not cancelled AND Procurement has formally closed
// purchasing on it. An in-progress purchase, or one on an IPO that was later
// cancelled, is not an authoritative "what we last paid" — it is a figure that
// can still move.
//
// A purchase that was later REVERSED is likewise not what we last paid for
// anything. Only the unreversed remainder counts, so a fully reversed purchase
// drops out entirely and the lookup falls back to the newest purchase that
// still stands. A partially reversed one remains eligible: units really were
// bought at that price and were kept.
export async function findLatestActualPurchases(companyItemIds, siteId) {
  if (companyItemIds.length === 0) return new Map();

  const result = await pool.query(
    `SELECT DISTINCT ON (il.company_item_id)
            il.company_item_id, e.actual_unit_price, e.purchased_at,
            il.uom_code_snapshot, i.ipo_number
     FROM ipo_purchase_events e
     JOIN ipo_lines il ON il.id = e.ipo_line_id
     JOIN ipos i ON i.id = il.ipo_id
     WHERE il.company_item_id = ANY($1::uuid[])
       AND e.reverses_purchase_event_id IS NULL
       AND i.status <> 'CANCELLED'
       AND i.purchasing_closed_at IS NOT NULL
       AND ($2::uuid IS NULL OR i.site_id = $2)
       AND e.quantity > COALESCE((
             SELECT SUM(-r.quantity) FROM ipo_purchase_events r
             WHERE r.reverses_purchase_event_id = e.id
           ), 0)
     ORDER BY il.company_item_id, e.purchased_at DESC, e.id DESC`,
    [companyItemIds, siteId],
  );

  return new Map(result.rows.map((row) => [row.company_item_id, row]));
}

// Approval signoff shown on the IPO document: the exact FINAL decisions bound
// to the exact approved Pricing version this IPO was generated from.
// The signoffs that actually authorized THIS IPO.
//
// Takes the IPO id rather than a pricing id, and joins through the IPO's own
// stored fingerprint, so it is structurally impossible to ask for the signoffs
// of one authorization context and be handed another's. Filtering on
// pricing_id alone would sweep in a decision made on a DIFFERENT purchasing
// set: a Site Manager who approved the full set, before the CEO ruled a line
// out of budget, would appear to have signed an IPO that never contained that
// line.
//
// The superseded decision is untouched and remains visible in the Demand's own
// approval history — it simply is not a signature on this document.
export async function findIpoSignoffs(clientOrPool, ipoId) {
  const result = await clientOrPool.query(
    `SELECT a.approval_type, a.decision, a.created_at, u.full_name AS actor_name
     FROM ipos i
     JOIN material_demand_approvals a
       ON a.pricing_id = i.pricing_id
      AND a.disposition_fingerprint = i.disposition_fingerprint
     JOIN users u ON u.id = a.actor_user_id
     WHERE i.id = $1
       AND a.approval_stage = 'FINAL'
       AND a.decision = 'APPROVED'
     ORDER BY a.created_at ASC`,
    [ipoId],
  );
  return result.rows;
}

// The downstream chain for one IPO — Delivery Challans and every receipt
// recorded against them. Operational only: no price column is selected here,
// so this projection is safe for any authorized viewer of the IPO.
export async function findChainForIpo(clientOrPool, ipoId) {
  const [challans, receipts] = await Promise.all([
    clientOrPool.query(
      `SELECT dc.id, dc.dc_number, dc.status, dc.created_at, dc.finalized_at, dc.completed_at,
              dc.cancelled_at, dc.cancellation_reason,
              (SELECT COUNT(*)::int FROM delivery_challan_lines WHERE dc_id = dc.id) AS line_count
       FROM delivery_challans dc
       WHERE dc.ipo_id = $1
       ORDER BY dc.created_at ASC`,
      [ipoId],
    ),
    clientOrPool.query(
      `SELECT mr.id, mr.dc_id, dc.dc_number, mr.receipt_type, mr.status, mr.has_discrepancy,
              mr.received_at, mr.handover_at, mr.confirmed_at,
              ru.full_name AS received_by_name, hu.full_name AS handover_to_name,
              cu.full_name AS confirmed_by_name, e.full_legal_name AS physical_receiver_name
       FROM material_receipts mr
       JOIN delivery_challans dc ON dc.id = mr.dc_id
       JOIN users ru ON ru.id = mr.received_by_user_id
       LEFT JOIN users hu ON hu.id = mr.handover_to_user_id
       LEFT JOIN users cu ON cu.id = mr.confirmed_by_user_id
       LEFT JOIN employees e ON e.id = mr.physical_receiver_employee_id
       WHERE mr.ipo_id = $1
       ORDER BY mr.received_at ASC`,
      [ipoId],
    ),
  ]);

  return { deliveryChallans: challans.rows, receipts: receipts.rows };
}
