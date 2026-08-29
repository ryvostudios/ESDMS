import pool from "../../config/database.js";

// Management's line-level purchasing disposition against one exact submitted
// Pricing version. A line with NO row here is implicitly
// APPROVED_FOR_PURCHASE — that keeps every pre-existing Demand and every
// Demand nobody excluded anything on behaving exactly as before, with no
// backfill and no migration of historical rows.
export const DEFAULT_DISPOSITION = "APPROVED_FOR_PURCHASE";

export async function findDispositions(clientOrPool, pricingId) {
  const result = await clientOrPool.query(
    `SELECT d.id, d.demand_line_id, d.disposition, d.exclusion_category, d.reason,
            d.requested_quantity_snapshot, d.estimated_unit_price_snapshot,
            d.created_at, d.updated_at, d.actor_user_id, u.full_name AS actor_name
     FROM material_demand_line_dispositions d
     JOIN users u ON u.id = d.actor_user_id
     WHERE d.pricing_id = $1
     ORDER BY d.created_at ASC`,
    [pricingId],
  );
  return result.rows;
}

// The exact set of lines an IPO may be generated from, plus the estimate for
// each — Demand line JOIN priced line, minus anything management excluded.
export async function findPurchasableLines(client, demandId, pricingId) {
  const result = await client.query(
    `SELECT mdl.id AS demand_line_id, mdl.line_no, mdl.requested_quantity,
            mdpl.estimated_unit_price,
            COALESCE(d.disposition, $3) AS disposition
     FROM material_demand_lines mdl
     JOIN material_demand_pricing_lines mdpl
       ON mdpl.demand_line_id = mdl.id AND mdpl.pricing_id = $2
     LEFT JOIN material_demand_line_dispositions d
       ON d.demand_line_id = mdl.id AND d.pricing_id = $2
     WHERE mdl.demand_id = $1
     ORDER BY mdl.line_no`,
    [demandId, pricingId, DEFAULT_DISPOSITION],
  );
  return result.rows;
}

export async function upsertDisposition(
  client,
  {
    demandId,
    revision,
    pricingId,
    demandLineId,
    disposition,
    exclusionCategory,
    reason,
    requestedQuantity,
    estimatedUnitPrice,
    actorUserId,
  },
) {
  await client.query(
    `INSERT INTO material_demand_line_dispositions
       (demand_id, revision, pricing_id, demand_line_id, disposition, exclusion_category, reason,
        requested_quantity_snapshot, estimated_unit_price_snapshot, actor_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (pricing_id, demand_line_id) DO UPDATE SET
       disposition = EXCLUDED.disposition,
       exclusion_category = EXCLUDED.exclusion_category,
       reason = EXCLUDED.reason,
       requested_quantity_snapshot = EXCLUDED.requested_quantity_snapshot,
       estimated_unit_price_snapshot = EXCLUDED.estimated_unit_price_snapshot,
       actor_user_id = EXCLUDED.actor_user_id`,
    [
      demandId,
      revision,
      pricingId,
      demandLineId,
      disposition,
      exclusionCategory || null,
      reason || null,
      requestedQuantity,
      estimatedUnitPrice,
      actorUserId,
    ],
  );
}

// Every line-level disposition recorded for a Demand, across every Pricing
// version, for the history/traceability view.
export async function findDispositionsByDemandId(demandId, executor = pool) {
  const result = await executor.query(
    `SELECT d.id, d.pricing_id, p.version AS pricing_version, d.demand_line_id,
            d.disposition, d.exclusion_category, d.reason,
            d.requested_quantity_snapshot, d.estimated_unit_price_snapshot,
            d.created_at, d.actor_user_id, u.full_name AS actor_name,
            mdl.item_name_snapshot, mdl.uom_name_snapshot
     FROM material_demand_line_dispositions d
     JOIN material_demand_pricing p ON p.id = d.pricing_id
     JOIN material_demand_lines mdl ON mdl.id = d.demand_line_id
     JOIN users u ON u.id = d.actor_user_id
     WHERE d.demand_id = $1
     ORDER BY p.version ASC, mdl.line_no ASC`,
    [demandId],
  );
  return result.rows;
}
