import pool from "../../config/database.js";

const DEMAND_DETAIL_COLUMNS = `
  md.id, md.demand_number, md.status, md.revision, md.site_id,
  s.name AS site_name, md.department_id, d.name AS department_name
`;

export async function listReadyForPricing({ siteId, search, page, pageSize }) {
  const conditions = ["md.status IN ('READY_FOR_PRICING', 'PRICING_REVISION_REQUIRED')"];
  const values = [];

  if (siteId) {
    values.push(siteId);
    conditions.push(`md.site_id = $${values.length}`);
  }
  if (search) {
    values.push(`%${search}%`);
    conditions.push(`md.demand_number ILIKE $${values.length}`);
  }

  const where = `WHERE ${conditions.join(" AND ")}`;
  const offset = (page - 1) * pageSize;
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT ${DEMAND_DETAIL_COLUMNS}, COUNT(mdl.id)::int AS line_count,
              mdp.id AS pricing_id, mdp.status AS pricing_status,
              mdp.version AS pricing_version
       FROM material_demands md
       JOIN sites s ON s.id = md.site_id
       JOIN departments d ON d.id = md.department_id
       JOIN material_demand_lines mdl ON mdl.demand_id = md.id
       LEFT JOIN LATERAL (
         SELECT p.id, p.status, p.version
         FROM material_demand_pricing p
         WHERE p.demand_id = md.id AND p.demand_revision = md.revision
         ORDER BY p.version DESC
         LIMIT 1
       ) mdp ON true
       ${where}
       GROUP BY md.id, s.name, d.name, mdp.id, mdp.status, mdp.version
       ORDER BY md.created_at ASC, md.id ASC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    ),
    pool.query(
      `SELECT COUNT(*)::int AS total
       FROM material_demands md
       ${where}`,
      values.slice(0, -2),
    ),
  ]);

  return { rows: rows.rows, total: count.rows[0].total };
}

export async function findDemandById(id) {
  const result = await pool.query(
    `SELECT ${DEMAND_DETAIL_COLUMNS}
     FROM material_demands md
     JOIN sites s ON s.id = md.site_id
     JOIN departments d ON d.id = md.department_id
     WHERE md.id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

export async function findDemandLines(client, demandId) {
  const result = await client.query(
    `SELECT id, line_no, item_name_snapshot, uom_code_snapshot,
            uom_name_snapshot, requested_quantity
     FROM material_demand_lines
     WHERE demand_id = $1
     ORDER BY line_no`,
    [demandId],
  );
  return result.rows;
}

export async function findPricing(client, demandId, revision, { version = null, forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT id, demand_id, demand_revision, version, status, currency,
            created_by_user_id, submitted_by_user_id, submitted_at,
            created_at, updated_at
     FROM material_demand_pricing
     WHERE demand_id = $1 AND demand_revision = $2
       AND ($3::integer IS NULL OR version = $3)
     ORDER BY version DESC
     LIMIT 1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [demandId, revision, version],
  );
  return result.rows[0] || null;
}

export async function findPricingById(client, pricingId, { forUpdate = false } = {}) {
  const result = await client.query(
    `SELECT id, demand_id, demand_revision, version, status, currency,
            created_by_user_id, submitted_by_user_id, submitted_at,
            created_at, updated_at
     FROM material_demand_pricing
     WHERE id = $1
     ${forUpdate ? "FOR UPDATE" : ""}`,
    [pricingId],
  );
  return result.rows[0] || null;
}

export async function createPricing(client, { demandId, revision, version = 1, currency, actorId }) {
  const result = await client.query(
    `INSERT INTO material_demand_pricing
       (demand_id, demand_revision, version, currency, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, demand_id, demand_revision, version, status, currency,
               created_by_user_id, submitted_by_user_id, submitted_at,
               created_at, updated_at`,
    [demandId, revision, version, currency, actorId],
  );
  return result.rows[0];
}

export async function copyPricingLines(client, sourcePricingId, targetPricingId, demandId) {
  await client.query(
    `INSERT INTO material_demand_pricing_lines
       (pricing_id, demand_id, demand_line_id, estimated_unit_price, procurement_note)
     SELECT $2, $3, demand_line_id, estimated_unit_price, procurement_note
     FROM material_demand_pricing_lines
     WHERE pricing_id = $1`,
    [sourcePricingId, targetPricingId, demandId],
  );
}

export async function findPricingVersions(client, demandId, revision) {
  const result = await client.query(
    `SELECT id, version, status, currency, created_by_user_id,
            submitted_by_user_id, submitted_at, created_at, updated_at
     FROM material_demand_pricing
     WHERE demand_id = $1 AND demand_revision = $2
     ORDER BY version DESC`,
    [demandId, revision],
  );
  return result.rows;
}

export async function findPricingLines(client, pricingId) {
  const result = await client.query(
    `SELECT id, pricing_id, demand_id, demand_line_id,
            estimated_unit_price, procurement_note, created_at, updated_at
     FROM material_demand_pricing_lines
     WHERE pricing_id = $1
     ORDER BY demand_line_id`,
    [pricingId],
  );
  return result.rows;
}

export async function replacePricingLines(client, pricingId, demandId, lines) {
  await client.query("DELETE FROM material_demand_pricing_lines WHERE pricing_id = $1", [pricingId]);

  for (const line of lines) {
    await client.query(
      `INSERT INTO material_demand_pricing_lines
         (pricing_id, demand_id, demand_line_id, estimated_unit_price, procurement_note)
       VALUES ($1, $2, $3, $4, $5)`,
      [pricingId, demandId, line.demandLineId, line.estimatedUnitPrice, line.procurementNote || null],
    );
  }
}

export async function markSubmitted(client, pricingId, actorId) {
  await client.query(
    `UPDATE material_demand_pricing
     SET status = 'SUBMITTED', submitted_by_user_id = $2, submitted_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [pricingId, actorId],
  );
}

export async function getPricingDetail(demandId, revision, { version = null } = {}) {
  const client = await pool.connect();
  try {
    const demand = await findDemandById(demandId);
    if (!demand) return null;

    const pricing = await findPricing(client, demandId, revision, { version });
    const versions = await findPricingVersions(client, demandId, revision);
    const result = await client.query(
      `SELECT mdl.id AS demand_line_id, mdl.line_no, mdl.item_name_snapshot,
              mdl.uom_code_snapshot, mdl.uom_name_snapshot, mdl.requested_quantity,
              mdpl.estimated_unit_price, mdpl.procurement_note,
              CASE WHEN mdpl.estimated_unit_price IS NULL THEN NULL
                   ELSE (mdl.requested_quantity * mdpl.estimated_unit_price)::numeric(26,2)
              END AS line_total
       FROM material_demand_lines mdl
       LEFT JOIN material_demand_pricing_lines mdpl
         ON mdpl.demand_line_id = mdl.id
        AND mdpl.pricing_id = $2::uuid
       WHERE mdl.demand_id = $1
       ORDER BY mdl.line_no`,
      [demandId, pricing?.id || null],
    );

    const totalResult = pricing
      ? await client.query(
          `SELECT COALESCE(SUM(mdl.requested_quantity * mdpl.estimated_unit_price), 0)::numeric(26,2)
                    AS estimated_total
           FROM material_demand_pricing_lines mdpl
           JOIN material_demand_lines mdl ON mdl.id = mdpl.demand_line_id
           WHERE mdpl.pricing_id = $1`,
          [pricing.id],
        )
      : { rows: [{ estimated_total: "0.00" }] };

    const approvals = pricing
      ? await client.query(
          `SELECT a.id, a.approval_stage, a.approval_type, a.decision, a.reason, a.created_at,
                  a.actor_user_id, u.full_name AS actor_name
           FROM material_demand_approvals a
           JOIN users u ON u.id = a.actor_user_id
           WHERE a.approval_stage = 'FINAL' AND a.pricing_id = $1
           ORDER BY a.created_at ASC`,
          [pricing.id],
        )
      : { rows: [] };

    return {
      demand,
      pricing,
      versions,
      lines: result.rows,
      estimatedTotal: totalResult.rows[0].estimated_total,
      finalApprovals: approvals.rows,
    };
  } finally {
    client.release();
  }
}
