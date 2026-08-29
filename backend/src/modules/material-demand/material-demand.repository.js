import pool from "../../config/database.js";
import { currentYearInAppTimezone } from "../../shared/time/app-timezone.js";

const DETAIL_COLUMNS = `
  md.id, md.demand_number, md.status, md.revision, md.note,
  md.site_id, s.name AS site_name,
  md.department_id, d.name AS department_name,
  md.created_by_user_id, cu.full_name AS created_by_name,
  md.submitted_at, md.created_at, md.updated_at,
  md.draft_delete_eligible
`;

const DETAIL_FROM = `
  FROM material_demands md
  JOIN sites s ON s.id = md.site_id
  JOIN departments d ON d.id = md.department_id
  JOIN users cu ON cu.id = md.created_by_user_id
`;

export async function nextDemandNumber(client) {
  const year = currentYearInAppTimezone();

  const result = await client.query(
    `INSERT INTO material_demand_number_counters (year, last_value)
     VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last_value = material_demand_number_counters.last_value + 1
     RETURNING last_value`,
    [year],
  );

  return `DL-${year}-${String(result.rows[0].last_value).padStart(6, "0")}`;
}

// Only ACTIVE entries belonging to exactly this department are ever
// returned — a nonexistent id, an archived entry, or one belonging to
// another department are all indistinguishable "invalid" results to the
// caller, which is the correct behavior (see material-demand.service.js).
export async function findCatalogEntriesForLines(departmentId, catalogEntryIds) {
  if (catalogEntryIds.length === 0) {
    return [];
  }

  const result = await pool.query(
    `SELECT dmc.id AS catalog_entry_id, ci.name AS item_name, uom.code AS uom_code, uom.name AS uom_name
     FROM department_material_catalog dmc
     JOIN company_items ci ON ci.id = dmc.company_item_id
     JOIN units_of_measure uom ON uom.id = dmc.default_uom_id
     WHERE dmc.department_id = $1 AND dmc.is_active = true AND ci.is_active = true AND dmc.id = ANY($2::uuid[])`,
    [departmentId, catalogEntryIds],
  );

  return result.rows;
}

export async function insertDraft(client, { demandNumber, siteId, departmentId, actorId, note }) {
  const result = await client.query(
    `INSERT INTO material_demands (demand_number, site_id, department_id, created_by_user_id, note)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [demandNumber, siteId, departmentId, actorId, note || null],
  );

  return result.rows[0].id;
}

// `entries` is the resolved catalog-entry snapshot data (item_name/uom_code/
// uom_name), keyed by catalog_entry_id — the caller has already validated
// every requested line resolves to one of these before calling this.
export async function insertLines(client, demandId, departmentId, lines, entriesByCatalogEntryId) {
  let lineNo = 1;

  for (const line of lines) {
    const entry = entriesByCatalogEntryId.get(line.catalogEntryId);

    await client.query(
      `INSERT INTO material_demand_lines
         (demand_id, line_no, department_id, catalog_entry_id, item_name_snapshot,
          uom_code_snapshot, uom_name_snapshot, requested_quantity, note,
          carry_forward_source_type, carry_forward_source_id, carry_forward_quantity)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        demandId,
        lineNo,
        departmentId,
        line.catalogEntryId,
        entry.item_name,
        entry.uom_code,
        entry.uom_name,
        line.quantity,
        line.note || null,
        line.carryForward?.sourceType || null,
        line.carryForward?.sourceId || null,
        line.carryForward?.quantity ?? null,
      ],
    );
    lineNo += 1;
  }
}

export async function replaceLines(client, demandId, departmentId, lines, entriesByCatalogEntryId) {
  await client.query("DELETE FROM material_demand_lines WHERE demand_id = $1", [demandId]);
  await insertLines(client, demandId, departmentId, lines, entriesByCatalogEntryId);
}

export async function updateNote(client, demandId, note) {
  await client.query("UPDATE material_demands SET note = $2 WHERE id = $1", [demandId, note ?? null]);
}

export async function lockById(client, id) {
  const result = await client.query(
    `SELECT id, demand_number, status, revision, site_id, department_id, created_by_user_id,
            draft_delete_eligible,
            (SELECT name FROM departments WHERE id = material_demands.department_id) AS department_name
     FROM material_demands WHERE id = $1 FOR UPDATE`,
    [id],
  );

  return result.rows[0] || null;
}

// Counts everything downstream that must make a Demand undeletable. The
// two foreign keys (material_demand_pricing, ipos) are ON DELETE RESTRICT,
// so the database refuses the delete regardless — this exists so the API
// can answer with a clear 409 instead of surfacing a raw FK violation.
export async function countDownstreamReferences(client, demandId) {
  const result = await client.query(
    `SELECT
       (SELECT COUNT(*) FROM material_demand_pricing WHERE demand_id = $1) AS pricing,
       (SELECT COUNT(*) FROM ipos WHERE demand_id = $1) AS ipos,
       (SELECT COUNT(*) FROM material_demand_approvals WHERE demand_id = $1) AS approvals`,
    [demandId],
  );
  const row = result.rows[0];
  return { pricing: Number(row.pricing), ipos: Number(row.ipos), approvals: Number(row.approvals) };
}

export async function countLines(client, demandId) {
  const result = await client.query("SELECT COUNT(*) AS count FROM material_demand_lines WHERE demand_id = $1", [demandId]);
  return Number(result.rows[0].count);
}

// Deletes only while the row is still DRAFT. The status predicate is part
// of the statement rather than a prior read so a concurrent SUBMIT cannot
// slip in between the check and the delete — the caller already holds the
// row lock, and this makes the guarantee independent of that too.
// material_demand_lines / _audit_log / _approvals cascade; pricing and ipos
// RESTRICT and would raise instead.
export async function deleteDraft(client, id) {
  const result = await client.query(
    "DELETE FROM material_demands WHERE id = $1 AND status = 'DRAFT' AND draft_delete_eligible RETURNING id",
    [id],
  );
  return result.rows[0] || null;
}

export async function findById(id) {
  const result = await pool.query(`SELECT ${DETAIL_COLUMNS} ${DETAIL_FROM} WHERE md.id = $1`, [id]);
  return result.rows[0] || null;
}

export async function findLinesByDemandId(demandId) {
  const result = await pool.query(
    `SELECT id, line_no, catalog_entry_id, item_name_snapshot, uom_code_snapshot, uom_name_snapshot,
            requested_quantity, note,
            carry_forward_source_type, carry_forward_source_id, carry_forward_quantity
     FROM material_demand_lines WHERE demand_id = $1 ORDER BY line_no`,
    [demandId],
  );

  return result.rows;
}

export async function findAuditLogByDemandId(demandId) {
  const result = await pool.query(
    `SELECT al.id, al.action, al.previous_status, al.new_status, al.metadata, al.created_at,
            al.actor_user_id, u.full_name AS actor_name
     FROM material_demand_audit_log al
     JOIN users u ON u.id = al.actor_user_id
     WHERE al.demand_id = $1
     ORDER BY al.created_at ASC`,
    [demandId],
  );

  return result.rows;
}

export async function insertAuditLog(client, { demandId, actorUserId, action, previousStatus, newStatus, metadata }) {
  await client.query(
    `INSERT INTO material_demand_audit_log (demand_id, actor_user_id, action, previous_status, new_status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [demandId, actorUserId, action, previousStatus || null, newStatus || null, metadata ? JSON.stringify(metadata) : null],
  );
}

export async function markSubmitted(client, id, status) {
  await client.query(
    "UPDATE material_demands SET status = $2, submitted_at = CURRENT_TIMESTAMP WHERE id = $1",
    [id, status],
  );
}

export async function updateStatus(client, id, status) {
  await client.query("UPDATE material_demands SET status = $2 WHERE id = $1", [id, status]);
}

// INITIAL slots are unique per Demand revision and type. FINAL slots are
// additionally bound to one exact Pricing id/version. Partial unique indexes
// make those identities the DB-level source of truth, not just this lookup.
export async function findApproval(
  client,
  demandId,
  revision,
  approvalType,
  { approvalStage = "INITIAL", pricingId = null, dispositionFingerprint = null } = {},
) {
  // A FINAL decision is identified by its purchasing-set fingerprint as well
  // as its Pricing version: once the set changes, an earlier decision is
  // preserved but no longer occupies the slot for the new set.
  const result = await client.query(
    `SELECT id, demand_id, revision, approval_stage, approval_type, pricing_id,
            disposition_fingerprint, decision, actor_user_id, reason, created_at
     FROM material_demand_approvals
     WHERE demand_id = $1 AND revision = $2 AND approval_type = $3
       AND approval_stage = $4
       AND ($5::uuid IS NULL OR pricing_id = $5)
       AND ($6::text IS NULL OR disposition_fingerprint = $6)`,
    [demandId, revision, approvalType, approvalStage, pricingId, dispositionFingerprint],
  );
  return result.rows[0] || null;
}

export async function findApprovalsByDemandId(demandId) {
  const result = await pool.query(
    `SELECT a.id, a.revision, a.approval_stage, a.approval_type, a.pricing_id,
            a.disposition_fingerprint, a.decision, a.reason, a.created_at,
            a.actor_user_id, u.full_name AS actor_name
     FROM material_demand_approvals a
     JOIN users u ON u.id = a.actor_user_id
     WHERE a.demand_id = $1
     ORDER BY a.created_at ASC`,
    [demandId],
  );
  return result.rows;
}

export async function insertApproval(
  client,
  {
    demandId,
    revision,
    approvalStage = "INITIAL",
    approvalType,
    pricingId = null,
    dispositionFingerprint = null,
    decision,
    actorUserId,
    reason,
  },
) {
  const result = await client.query(
    `INSERT INTO material_demand_approvals
       (demand_id, revision, approval_stage, approval_type, pricing_id,
        disposition_fingerprint, decision, actor_user_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, demand_id, revision, approval_stage, approval_type,
               pricing_id, disposition_fingerprint, decision, actor_user_id, reason, created_at`,
    [
      demandId,
      revision,
      approvalStage,
      approvalType,
      pricingId,
      dispositionFingerprint,
      decision,
      actorUserId,
      reason || null,
    ],
  );
  return result.rows[0];
}

export async function listForScope({ siteId, departmentId }, { status, search, page, pageSize }) {
  const conditions = [];
  const values = [];

  values.push(siteId);
  conditions.push(`($${values.length}::uuid IS NULL OR md.site_id = $${values.length})`);
  values.push(departmentId);
  conditions.push(`($${values.length}::uuid IS NULL OR md.department_id = $${values.length})`);

  if (status) {
    values.push(status);
    conditions.push(`md.status = $${values.length}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(`md.demand_number ILIKE $${values.length}`);
  }

  const whereClause = `WHERE ${conditions.join(" AND ")}`;
  const offset = (page - 1) * pageSize;
  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT ${DETAIL_COLUMNS} ${DETAIL_FROM} ${whereClause}
       ORDER BY md.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    ),
    pool.query(`SELECT COUNT(*)::int AS total ${DETAIL_FROM} ${whereClause}`, values.slice(0, -2)),
  ]);

  return { rows: rows.rows, total: count.rows[0].total };
}

// The IPO generated from this Demand, if any. Operational identity only —
// never the approved value, which stays behind the price gate.
export async function findIpoSummaryByDemandId(demandId) {
  const result = await pool.query(
    `SELECT id, ipo_number, status, generated_at, completed_at, cancelled_at
     FROM ipos WHERE demand_id = $1
     ORDER BY demand_revision DESC LIMIT 1`,
    [demandId],
  );
  return result.rows[0] || null;
}
