import pool from "../../config/database.js";

export async function listTypes({ activeOnly = false } = {}) {
  const result = await pool.query(
    `SELECT id, name, requires_document, tracks_balance, description, is_active FROM leave_types
     ${activeOnly ? "WHERE is_active = true" : ""} ORDER BY name`,
  );
  return result.rows;
}

export async function findTypeById(id) {
  const result = await pool.query("SELECT id, requires_document, is_active FROM leave_types WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function insertType({ name, requiresDocument, tracksBalance, description }) {
  const result = await pool.query(
    `INSERT INTO leave_types (name, requires_document, tracks_balance, description)
     VALUES ($1, $2, $3, $4) RETURNING id, name, requires_document, tracks_balance, description, is_active`,
    [name, requiresDocument ?? false, tracksBalance ?? false, description || null],
  );
  return result.rows[0];
}

export async function updateTypeFields(id, { name, isActive, description }) {
  const result = await pool.query(
    `UPDATE leave_types
     SET name = COALESCE($2, name), is_active = COALESCE($3, is_active),
         description = CASE WHEN $4::boolean THEN $5 ELSE description END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, name, requires_document, tracks_balance, description, is_active`,
    [id, name ?? null, isActive ?? null, description !== undefined, description ?? null],
  );
  return result.rows[0] || null;
}

export async function insertRequest(employeeId, { leaveTypeId, startDate, endDate, requestedDays, reason }) {
  const result = await pool.query(
    `INSERT INTO leave_requests (employee_id, leave_type_id, start_date, end_date, requested_days, reason)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, employee_id, leave_type_id, start_date, end_date, requested_days, reason, status, created_at`,
    [employeeId, leaveTypeId, startDate, endDate, requestedDays, reason || null],
  );
  return result.rows[0];
}

export async function findRequestById(id) {
  const result = await pool.query(
    `SELECT id, employee_id, leave_type_id, start_date, end_date, requested_days, reason, status,
            decided_by_user_id, decided_at, decision_remark, created_at
     FROM leave_requests WHERE id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

export async function listForEmployee(employeeId) {
  const result = await pool.query(
    `SELECT lr.id, lr.leave_type_id, lt.name AS leave_type_name, lr.start_date, lr.end_date, lr.requested_days,
            lr.reason, lr.status, lr.decided_by_user_id, lr.decided_at, lr.decision_remark, lr.created_at
     FROM leave_requests lr JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE lr.employee_id = $1 ORDER BY lr.created_at DESC`,
    [employeeId],
  );
  return result.rows;
}

export async function listPendingForSite(siteId) {
  const result = await pool.query(
    `SELECT lr.id, lr.employee_id, e.employee_code, e.full_legal_name, lt.name AS leave_type_name,
            lr.start_date, lr.end_date, lr.requested_days, lr.reason, lr.created_at
     FROM leave_requests lr
     JOIN employees e ON e.id = lr.employee_id
     JOIN leave_types lt ON lt.id = lr.leave_type_id
     WHERE lr.status = 'SUBMITTED' AND ($1::uuid IS NULL OR e.primary_site_id = $1)
     ORDER BY lr.created_at`,
    [siteId],
  );
  return result.rows;
}

export async function decide(id, { status, decidedByUserId, remark }) {
  const result = await pool.query(
    `UPDATE leave_requests
     SET status = $2, decided_by_user_id = $3, decided_at = CURRENT_TIMESTAMP, decision_remark = $4, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'SUBMITTED'
     RETURNING id, status`,
    [id, status, decidedByUserId, remark || null],
  );
  return result.rows[0] || null;
}

export async function cancel(id, employeeId) {
  const result = await pool.query(
    `UPDATE leave_requests SET status = 'CANCELLED', updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND employee_id = $2 AND status = 'SUBMITTED'
     RETURNING id, status`,
    [id, employeeId],
  );
  return result.rows[0] || null;
}
