import pool from "../../config/database.js";
import { currentYearInAppTimezone } from "../../shared/time/app-timezone.js";

const DETAIL_COLUMNS = `
  gp.id, gp.gate_pass_number, gp.status, gp.site_id, gp.issuing_department_id, d.name AS issuing_department_name,
  gp.requested_by, gp.destination, gp.driver_name, gp.driver_phone, gp.vehicle_registration,
  gp.job_order_id, gp.purpose, gp.expected_return_date, gp.remarks,
  gp.created_by_user_id, cu.full_name AS created_by_name,
  gp.approved_by_user_id, au.full_name AS approved_by_name, gp.approved_at,
  gp.rejected_by_user_id, gp.rejected_at, gp.rejection_reason,
  gp.cancelled_by_user_id, gp.cancelled_at, gp.cancellation_reason,
  gp.departure_odometer, gp.departure_at, gp.departure_by_user_id, du.full_name AS departure_by_name,
  gp.departure_photo_file_id,
  gp.return_odometer, gp.return_at, gp.return_by_user_id, ru.full_name AS return_by_name, gp.return_remarks,
  gp.return_photo_file_id,
  gp.distance_km, gp.created_at, gp.updated_at
`;

const DETAIL_FROM = `
  FROM gate_passes gp
  JOIN departments d ON d.id = gp.issuing_department_id
  JOIN users cu ON cu.id = gp.created_by_user_id
  LEFT JOIN users au ON au.id = gp.approved_by_user_id
  LEFT JOIN users du ON du.id = gp.departure_by_user_id
  LEFT JOIN users ru ON ru.id = gp.return_by_user_id
`;

// Data-minimized: no requested_by, remarks, job_order_id, rejection/
// cancellation reasons, or department name — Guard does not need them.
const GUARD_COLUMNS = `
  gp.id, gp.gate_pass_number, gp.status, gp.destination, gp.driver_name,
  gp.driver_phone, gp.vehicle_registration, gp.purpose, gp.expected_return_date,
  gp.approved_at, gp.departure_at, gp.departure_odometer, gp.return_at
`;

export async function nextGatePassNumber(client) {
  const year = currentYearInAppTimezone();

  const result = await client.query(
    `INSERT INTO gate_pass_number_counters (year, last_value)
     VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last_value = gate_pass_number_counters.last_value + 1
     RETURNING last_value`,
    [year],
  );

  return `ESD-${year}-${String(result.rows[0].last_value).padStart(6, "0")}`;
}

export async function insertDraft(client, gatePassNumber, actorId, siteId, departmentId, input) {
  const result = await client.query(
    `INSERT INTO gate_passes
       (gate_pass_number, issuing_department_id, requested_by, destination,
        driver_name, driver_phone, vehicle_registration, job_order_id, purpose,
        expected_return_date, remarks, created_by_user_id, site_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      gatePassNumber,
      departmentId,
      input.requestedBy,
      input.destination,
      input.driverName,
      input.driverPhone,
      input.vehicleRegistration,
      input.jobOrderId || null,
      input.purpose,
      input.expectedReturnDate || null,
      input.remarks || null,
      actorId,
      siteId,
    ],
  );

  return result.rows[0].id;
}

export async function insertItems(client, gatePassId, items) {
  let lineNo = 1;

  for (const item of items) {
    await client.query(
      `INSERT INTO gate_pass_items (gate_pass_id, line_no, description, part_number, quantity, unit)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [gatePassId, lineNo, item.description, item.partNumber || null, item.quantity, item.unit || null],
    );
    lineNo += 1;
  }
}

export async function replaceItems(client, gatePassId, items) {
  await client.query("DELETE FROM gate_pass_items WHERE gate_pass_id = $1", [gatePassId]);
  await insertItems(client, gatePassId, items);
}

export async function updateDraftFields(client, gatePassId, input) {
  const fields = [
    ["issuing_department_id", input.issuingDepartmentId],
    ["requested_by", input.requestedBy],
    ["destination", input.destination],
    ["driver_name", input.driverName],
    ["driver_phone", input.driverPhone],
    ["vehicle_registration", input.vehicleRegistration],
    ["job_order_id", input.jobOrderId],
    ["purpose", input.purpose],
    ["expected_return_date", input.expectedReturnDate],
    ["remarks", input.remarks],
  ].filter(([, value]) => value !== undefined);

  if (fields.length === 0) {
    return;
  }

  const setClause = fields.map(([column], index) => `${column} = $${index + 2}`).join(", ");
  const values = fields.map(([, value]) => value);

  await client.query(`UPDATE gate_passes SET ${setClause} WHERE id = $1`, [gatePassId, ...values]);
}

export async function lockById(client, id) {
  const result = await client.query(
    `SELECT id, gate_pass_number, status, issuing_department_id, created_by_user_id,
            driver_name, driver_phone, vehicle_registration, destination, purpose,
            departure_odometer, site_id
     FROM gate_passes WHERE id = $1 FOR UPDATE`,
    [id],
  );

  return result.rows[0] || null;
}

// Same shape as findById, but row-locked within the caller's transaction —
// used by PDF finalization so the entire generate/upload/commit sequence
// holds the lock, closing the TOCTOU window against a concurrent
// cancellation (which also locks this row via lockById above). FOR UPDATE
// OF gp: only the gate_passes row itself needs locking, not the LEFT
// JOINed department/user rows this view pulls in for display names.
export async function lockDetailById(client, id) {
  const result = await client.query(`SELECT ${DETAIL_COLUMNS} ${DETAIL_FROM} WHERE gp.id = $1 FOR UPDATE OF gp`, [
    id,
  ]);
  return result.rows[0] || null;
}

export async function findById(id) {
  const result = await pool.query(`SELECT ${DETAIL_COLUMNS} ${DETAIL_FROM} WHERE gp.id = $1`, [id]);
  return result.rows[0] || null;
}

export async function findItemsByGatePassId(gatePassId) {
  const result = await pool.query(
    `SELECT id, line_no, description, part_number, quantity, unit
     FROM gate_pass_items WHERE gate_pass_id = $1 ORDER BY line_no`,
    [gatePassId],
  );

  return result.rows;
}

export async function findAuditLogByGatePassId(gatePassId) {
  const result = await pool.query(
    `SELECT al.id, al.action, al.previous_status, al.new_status, al.metadata, al.created_at,
            al.actor_user_id, u.full_name AS actor_name
     FROM gate_pass_audit_log al
     JOIN users u ON u.id = al.actor_user_id
     WHERE al.gate_pass_id = $1
     ORDER BY al.created_at ASC`,
    [gatePassId],
  );

  return result.rows;
}

export async function insertAuditLog(client, { gatePassId, actorUserId, action, previousStatus, newStatus, metadata }) {
  await client.query(
    `INSERT INTO gate_pass_audit_log (gate_pass_id, actor_user_id, action, previous_status, new_status, metadata)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [gatePassId, actorUserId, action, previousStatus || null, newStatus || null, metadata ? JSON.stringify(metadata) : null],
  );
}

export async function updateStatus(client, id, status) {
  await client.query("UPDATE gate_passes SET status = $2 WHERE id = $1", [id, status]);
}

export async function markApproved(client, id, { approvedByUserId, tokenHash, status }) {
  await client.query(
    `UPDATE gate_passes
     SET status = $2, approved_by_user_id = $3, approved_at = CURRENT_TIMESTAMP, verification_token_hash = $4
     WHERE id = $1`,
    [id, status, approvedByUserId, tokenHash],
  );
}

export async function markRejected(client, id, { rejectedByUserId, reason, status }) {
  await client.query(
    `UPDATE gate_passes
     SET status = $2, rejected_by_user_id = $3, rejected_at = CURRENT_TIMESTAMP, rejection_reason = $4
     WHERE id = $1`,
    [id, status, rejectedByUserId, reason],
  );
}

export async function markCancelled(client, id, { cancelledByUserId, reason, status }) {
  await client.query(
    `UPDATE gate_passes
     SET status = $2, cancelled_by_user_id = $3, cancelled_at = CURRENT_TIMESTAMP, cancellation_reason = $4
     WHERE id = $1`,
    [id, status, cancelledByUserId, reason],
  );
}

export async function markExited(client, id, { odometer, byUserId, photoFileId }) {
  await client.query(
    `UPDATE gate_passes
     SET status = 'VEHICLE_OUTSIDE', departure_odometer = $2, departure_at = CURRENT_TIMESTAMP,
         departure_by_user_id = $3, departure_photo_file_id = $4
     WHERE id = $1`,
    [id, odometer, byUserId, photoFileId],
  );
}

export async function markReturned(client, id, { odometer, byUserId, photoFileId, remarks }) {
  await client.query(
    `UPDATE gate_passes
     SET status = 'COMPLETED', return_odometer = $2, return_at = CURRENT_TIMESTAMP,
         return_by_user_id = $3, return_photo_file_id = $4, return_remarks = $5
     WHERE id = $1`,
    [id, odometer, byUserId, photoFileId, remarks || null],
  );
}

export async function insertFile(client, { gatePassId, fileType, storageKey, mimeType, sizeBytes, checksumSha256, version, createdByUserId }) {
  const result = await client.query(
    `INSERT INTO gate_pass_files
       (gate_pass_id, file_type, storage_key, mime_type, size_bytes, checksum_sha256, version, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [gatePassId, fileType, storageKey, mimeType, sizeBytes, checksumSha256, version, createdByUserId],
  );

  return result.rows[0].id;
}

export async function findFileById(fileId) {
  const result = await pool.query(
    `SELECT id, gate_pass_id, file_type, storage_key, mime_type, size_bytes
     FROM gate_pass_files WHERE id = $1`,
    [fileId],
  );

  return result.rows[0] || null;
}

export async function findLatestPdfFile(gatePassId, client = pool) {
  const result = await client.query(
    `SELECT id, storage_key, mime_type, version
     FROM gate_pass_files
     WHERE gate_pass_id = $1 AND file_type = 'APPROVED_PDF'
     ORDER BY version DESC LIMIT 1`,
    [gatePassId],
  );

  return result.rows[0] || null;
}

export async function nextPdfVersion(gatePassId) {
  const result = await pool.query(
    `SELECT COALESCE(MAX(version), 0) + 1 AS next_version
     FROM gate_pass_files WHERE gate_pass_id = $1 AND file_type = 'APPROVED_PDF'`,
    [gatePassId],
  );

  return result.rows[0].next_version;
}

export async function findByVerificationTokenHash(tokenHash, siteId) {
  const result = await pool.query(
    `SELECT ${GUARD_COLUMNS} ${DETAIL_FROM} WHERE gp.verification_token_hash = $1 AND gp.site_id = $2`,
    [tokenHash, siteId],
  );

  return result.rows[0] || null;
}

// Same operational-state boundary as searchForGuard: a Guard's direct/
// refetch lookup by id must never disclose a Gate Pass outside APPROVED /
// VEHICLE_OUTSIDE just because the caller happens to know its UUID — a
// DRAFT, PENDING_APPROVAL, REJECTED, or CANCELLED record is invisible to
// Guard here exactly as it already is from search.
export async function findByIdForGuard(id, siteId) {
  const result = await pool.query(
    `SELECT ${GUARD_COLUMNS} ${DETAIL_FROM}
     WHERE gp.id = $1 AND gp.site_id = $2 AND gp.status IN ('APPROVED', 'VEHICLE_OUTSIDE')`,
    [id, siteId],
  );

  return result.rows[0] || null;
}

export async function searchForGuard(query, siteId) {
  const result = await pool.query(
    `SELECT ${GUARD_COLUMNS} ${DETAIL_FROM}
     WHERE gp.site_id = $2
       AND gp.status IN ('APPROVED', 'VEHICLE_OUTSIDE')
       AND (
         gp.gate_pass_number ILIKE $1 OR
         gp.vehicle_registration ILIKE $1 OR
         gp.driver_name ILIKE $1
       )
     ORDER BY gp.approved_at DESC
     LIMIT 20`,
    [`%${query}%`, siteId],
  );

  return result.rows;
}

export async function guardDashboard(guardUserId, siteId) {
  const [newlyApproved, vehiclesOutside, recentActivity] = await Promise.all([
    pool.query(
      `SELECT ${GUARD_COLUMNS} ${DETAIL_FROM} WHERE gp.site_id = $1 AND gp.status = 'APPROVED' ORDER BY gp.approved_at DESC LIMIT 20`,
      [siteId],
    ),
    pool.query(
      `SELECT ${GUARD_COLUMNS} ${DETAIL_FROM} WHERE gp.site_id = $1 AND gp.status = 'VEHICLE_OUTSIDE' ORDER BY gp.departure_at DESC LIMIT 20`,
      [siteId],
    ),
    pool.query(
      `SELECT ${GUARD_COLUMNS} ${DETAIL_FROM}
       WHERE gp.site_id = $1 AND (gp.departure_by_user_id = $2 OR gp.return_by_user_id = $2)
       ORDER BY GREATEST(COALESCE(gp.return_at, gp.departure_at), gp.departure_at) DESC
       LIMIT 20`,
      [siteId, guardUserId],
    ),
  ]);

  return {
    newlyApproved: newlyApproved.rows,
    vehiclesOutside: vehiclesOutside.rows,
    recentActivity: recentActivity.rows,
  };
}

export async function listForScope(user, { status, search, page, pageSize }) {
  const conditions = [];
  const values = [];

  values.push(user.siteId);
  conditions.push(`gp.site_id = $${values.length}`);

  if (!user.permissions.has("gate_pass.view_site")) {
    values.push(user.departmentId);
    conditions.push(`gp.issuing_department_id = $${values.length}`);
  }

  if (status) {
    values.push(status);
    conditions.push(`gp.status = $${values.length}`);
  }

  if (search) {
    values.push(`%${search}%`);
    conditions.push(
      `(gp.gate_pass_number ILIKE $${values.length} OR gp.vehicle_registration ILIKE $${values.length} OR gp.driver_name ILIKE $${values.length})`,
    );
  }

  const whereClause = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  const offset = (page - 1) * pageSize;

  values.push(pageSize, offset);

  const [rows, count] = await Promise.all([
    pool.query(
      `SELECT ${DETAIL_COLUMNS} ${DETAIL_FROM} ${whereClause}
       ORDER BY gp.created_at DESC
       LIMIT $${values.length - 1} OFFSET $${values.length}`,
      values,
    ),
    pool.query(`SELECT COUNT(*)::int AS total FROM gate_passes gp ${whereClause}`, values.slice(0, -2)),
  ]);

  return { rows: rows.rows, total: count.rows[0].total };
}
