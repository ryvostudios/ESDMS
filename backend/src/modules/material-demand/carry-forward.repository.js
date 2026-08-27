import pool from "../../config/database.js";

// Unresolved requirements a department may legitimately carry into a later
// Demand, and the authoritative claim against them.
//
// Three sources, chosen because they are mutually exclusive by construction —
// the same physical unit can only ever be in one of them:
//
//   UNPURCHASED_IPO_QUANTITY  approved and ordered, but purchasing closed
//                             having bought less than approved.
//   OUT_OF_BUDGET             management excluded the line from the set that
//                             became purchasing authority, so it was never
//                             ordered at all.
//   RECEIVING_SHORTAGE        purchased AND delivered, but the department
//                             confirmed a short/damaged/rejected quantity.
//
// "Not purchased" and "purchased but short" can therefore never double-count
// the same units.
export const CARRY_FORWARD_SOURCE = {
  UNPURCHASED_IPO_QUANTITY: "UNPURCHASED_IPO_QUANTITY",
  OUT_OF_BUDGET: "OUT_OF_BUDGET",
  RECEIVING_SHORTAGE: "RECEIVING_SHORTAGE",
};

// Every source resolves to the same shape so availability is one calculation.
// `allocated` counts only ACTIVE claims, so a released claim returns its
// quantity to the pool.
const SOURCES_SQL = `
WITH sources AS (
  -- Approved but never purchased. Authoritative only once Procurement has
  -- formally closed purchasing: before that the shortfall can still change.
  SELECT
    'UNPURCHASED_IPO_QUANTITY'::varchar(30) AS source_type,
    il.id AS source_id,
    il.company_item_id,
    il.item_name_snapshot,
    il.uom_code_snapshot,
    (il.approved_quantity - il.purchased_quantity)::numeric(12,2) AS source_quantity,
    i.department_id, i.site_id,
    i.id AS ipo_id, i.ipo_number, md.id AS demand_id, md.demand_number,
    i.purchasing_closed_at AS resolved_at,
    NULL::varchar(30) AS exclusion_category,
    NULL::varchar(20) AS discrepancy_type
  FROM ipo_lines il
  JOIN ipos i ON i.id = il.ipo_id
  JOIN material_demands md ON md.id = i.demand_id
  WHERE i.status <> 'CANCELLED'
    AND i.purchasing_closed_at IS NOT NULL
    AND il.approved_quantity > il.purchased_quantity

  UNION ALL

  -- Excluded by management. Authoritative ONLY when the exact Pricing version
  -- it belongs to actually became purchasing authority — proven by an IPO
  -- generated from that same Pricing version. A single approved decision on a
  -- gate that was later rejected is NOT an authoritative exclusion.
  SELECT
    'OUT_OF_BUDGET'::varchar(30),
    d.id,
    dmc.company_item_id,
    mdl.item_name_snapshot,
    mdl.uom_code_snapshot,
    d.requested_quantity_snapshot,
    md.department_id, md.site_id,
    i.id, i.ipo_number, md.id, md.demand_number,
    i.generated_at,
    d.exclusion_category,
    NULL::varchar(20)
  FROM material_demand_line_dispositions d
  JOIN material_demand_lines mdl ON mdl.id = d.demand_line_id
  JOIN department_material_catalog dmc ON dmc.id = mdl.catalog_entry_id
  JOIN material_demands md ON md.id = d.demand_id
  JOIN ipos i ON i.demand_id = d.demand_id AND i.demand_revision = d.revision AND i.pricing_id = d.pricing_id
  WHERE d.disposition = 'EXCLUDED'
    AND i.status <> 'CANCELLED'

  UNION ALL

  -- Delivered short. Authoritative once the department has confirmed the
  -- receipt, so a discrepancy still under review cannot be carried forward.
  SELECT
    'RECEIVING_SHORTAGE'::varchar(30),
    mrl.id,
    il.company_item_id,
    mrl.item_name_snapshot,
    mrl.uom_code_snapshot,
    mrl.discrepancy_quantity,
    mr.department_id, mr.site_id,
    i.id, i.ipo_number, md.id, md.demand_number,
    mr.confirmed_at,
    NULL::varchar(30),
    mrl.discrepancy_type
  FROM material_receipt_lines mrl
  JOIN material_receipts mr ON mr.id = mrl.receipt_id
  JOIN delivery_challan_lines dcl ON dcl.id = mrl.dc_line_id
  JOIN ipo_lines il ON il.id = dcl.ipo_line_id
  JOIN ipos i ON i.id = il.ipo_id
  JOIN material_demands md ON md.id = i.demand_id
  WHERE mrl.discrepancy_quantity > 0
    AND mr.status = 'COMPLETED'
)
SELECT s.*,
       COALESCE(a.allocated, 0)::numeric(12,2) AS allocated_quantity,
       (s.source_quantity - COALESCE(a.allocated, 0))::numeric(12,2) AS available_quantity
FROM sources s
LEFT JOIN LATERAL (
  SELECT SUM(allocated_quantity) AS allocated
  FROM carry_forward_allocations c
  WHERE c.status = 'ACTIVE'
    AND c.source_type = s.source_type
    AND COALESCE(c.source_ipo_line_id, c.source_disposition_id, c.source_receipt_line_id) = s.source_id
) a ON true
`;

export async function findAvailableSources(companyItemIds, { siteId, departmentId }) {
  if (companyItemIds.length === 0) return [];

  const result = await pool.query(
    `${SOURCES_SQL}
     WHERE s.company_item_id = ANY($1::uuid[])
       AND s.department_id = $2
       AND ($3::uuid IS NULL OR s.site_id = $3)
       AND (s.source_quantity - COALESCE(a.allocated, 0)) > 0
     ORDER BY s.resolved_at DESC NULLS LAST`,
    [companyItemIds, departmentId, siteId],
  );
  return result.rows;
}

// Single-source lookup used when a submitted Demand line claims a quantity.
// Takes the row for update through the guard trigger on insert; this read
// establishes the source's identity, department and remaining availability.
export async function findSourceById(client, sourceType, sourceId) {
  const result = await client.query(
    `${SOURCES_SQL} WHERE s.source_type = $1 AND s.source_id = $2`,
    [sourceType, sourceId],
  );
  return result.rows[0] || null;
}

export async function insertAllocation(
  client,
  {
    sourceType,
    sourceId,
    departmentId,
    siteId,
    sourceQuantity,
    allocatedQuantity,
    targetDemandId,
    targetDemandLineId,
    actorId,
  },
) {
  const column = {
    UNPURCHASED_IPO_QUANTITY: "source_ipo_line_id",
    OUT_OF_BUDGET: "source_disposition_id",
    RECEIVING_SHORTAGE: "source_receipt_line_id",
  }[sourceType];

  const result = await client.query(
    `INSERT INTO carry_forward_allocations
       (source_type, ${column}, department_id, site_id, source_quantity, allocated_quantity,
        target_demand_id, target_demand_line_id, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      sourceType,
      sourceId,
      departmentId,
      siteId,
      sourceQuantity,
      allocatedQuantity,
      targetDemandId,
      targetDemandLineId,
      actorId,
    ],
  );
  return result.rows[0];
}

// A Demand that dies (rejected outright, or whose IPO was cancelled) returns
// its claimed quantity to the pool. Released rows are kept, not deleted, so
// the history of who claimed what and when remains readable.
export async function releaseAllocationsForDemand(client, demandId) {
  const result = await client.query(
    `UPDATE carry_forward_allocations
     SET status = 'RELEASED', released_at = CURRENT_TIMESTAMP
     WHERE target_demand_id = $1 AND status = 'ACTIVE'
     RETURNING id`,
    [demandId],
  );
  return result.rowCount;
}

export async function findAllocationsForDemand(clientOrPool, demandId) {
  const result = await clientOrPool.query(
    `SELECT c.id, c.source_type, c.allocated_quantity, c.source_quantity, c.status,
            c.target_demand_line_id, c.created_at, c.released_at,
            COALESCE(c.source_ipo_line_id, c.source_disposition_id, c.source_receipt_line_id) AS source_id
     FROM carry_forward_allocations c
     WHERE c.target_demand_id = $1
     ORDER BY c.created_at ASC`,
    [demandId],
  );
  return result.rows;
}

// Ordered by the SOURCE, deliberately, not by line_no.
//
// Inserting each allocation makes the guard trigger lock that allocation's
// source row FOR UPDATE, so this order IS the lock-acquisition order. Two
// Demands claiming the same two sources in opposite line order would then
// take those locks in opposite order and deadlock — a 500 on a legitimate
// submit. Sorting on a key that is global to the sources rather than local to
// one Demand means every transaction in the system walks the same sources in
// the same direction, so a cycle cannot form. line_no only breaks ties.
export async function findDemandLinesWithCarryForward(client, demandId) {
  const result = await client.query(
    `SELECT id, requested_quantity, carry_forward_source_type, carry_forward_source_id,
            carry_forward_quantity
     FROM material_demand_lines
     WHERE demand_id = $1 AND carry_forward_source_type IS NOT NULL
     ORDER BY carry_forward_source_type, carry_forward_source_id, line_no`,
    [demandId],
  );
  return result.rows;
}
