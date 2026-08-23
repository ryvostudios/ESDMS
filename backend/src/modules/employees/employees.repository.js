import pool from "../../config/database.js";

// Backs the Add Employee site-first selector: null scope (all-site actor)
// returns every active site, a specific scope returns just that one.
export async function listActiveSites(siteId) {
  const result = await pool.query(
    "SELECT id, name FROM sites WHERE is_active = true AND ($1::uuid IS NULL OR id = $1) ORDER BY name",
    [siteId],
  );
  return result.rows;
}

// Reused everywhere "the employee's current permanent assignment" is
// needed: the latest employment_assignments row whose effective_date has
// arrived. A LATERAL subquery, not a database VIEW — a view would run with
// its owner's privileges by default and could silently bypass the
// per-table RLS policy a caller's role is actually subject to; a plain
// SQL fragment carries no such risk. See docs/SECURITY.md.
const CURRENT_ASSIGNMENT_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT ea.*
    FROM employment_assignments ea
    WHERE ea.employee_id = e.id AND ea.effective_date <= CURRENT_DATE
    ORDER BY ea.effective_date DESC, ea.created_at DESC
    LIMIT 1
  ) cur ON true
`;

const EMPLOYEE_LIST_COLUMNS = `
  e.id, e.employee_code, e.full_legal_name, e.primary_site_id, e.status, e.joining_date, e.user_id,
  cur.department_id, cur.position_id, cur.employment_type_id, cur.reporting_manager_employee_id,
  cur.rotation_policy_id,
  d.name AS department_name, p.name AS position_name, et.name AS employment_type_name
`;

function employeeListQuery(whereClause) {
  return `
    SELECT ${EMPLOYEE_LIST_COLUMNS}
    FROM employees e
    ${CURRENT_ASSIGNMENT_LATERAL}
    LEFT JOIN departments d ON d.id = cur.department_id
    LEFT JOIN positions p ON p.id = cur.position_id
    LEFT JOIN employment_types et ON et.id = cur.employment_type_id
    ${whereClause}
    ORDER BY e.full_legal_name
  `;
}

export async function listEmployees({ siteId, status, departmentId, positionId, search, limit, offset }) {
  const conditions = [];
  const params = [];

  if (siteId) {
    params.push(siteId);
    conditions.push(`e.primary_site_id = $${params.length}`);
  }
  if (status) {
    params.push(status);
    conditions.push(`e.status = $${params.length}`);
  }
  if (departmentId) {
    params.push(departmentId);
    conditions.push(`cur.department_id = $${params.length}`);
  }
  if (positionId) {
    params.push(positionId);
    conditions.push(`cur.position_id = $${params.length}`);
  }
  if (search) {
    params.push(`%${search}%`);
    conditions.push(`(e.full_legal_name ILIKE $${params.length} OR e.employee_code ILIKE $${params.length})`);
  }

  const where = conditions.length ? `WHERE ${conditions.join(" AND ")}` : "";
  params.push(limit);
  params.push(offset);

  const result = await pool.query(
    `${employeeListQuery(where)} LIMIT $${params.length - 1} OFFSET $${params.length}`,
    params,
  );

  const countResult = await pool.query(
    `SELECT count(*) AS total FROM employees e ${CURRENT_ASSIGNMENT_LATERAL} ${where}`,
    params.slice(0, params.length - 2),
  );

  return { rows: result.rows, total: Number(countResult.rows[0].total) };
}

export async function findEmployeeById(id) {
  const result = await pool.query(`${employeeListQuery("WHERE e.id = $1")}`, [id]);
  return result.rows[0] || null;
}

export async function findEmployeeByUserId(userId) {
  const result = await pool.query(`${employeeListQuery("WHERE e.user_id = $1")}`, [userId]);
  return result.rows[0] || null;
}

export async function employeeCodeExists(code) {
  const result = await pool.query("SELECT 1 FROM employees WHERE employee_code = $1", [code]);
  return result.rowCount > 0;
}

// Duplicate-warning support: exact CNIC match (via personal_details, which
// may not exist yet for every employee), or same full legal name at the
// same site. Non-blocking by design — the caller decides whether to
// proceed with an explicit override (docs/DECISIONS.md).
export async function findPotentialDuplicates({ fullLegalName, primarySiteId, cnic, mobile, personalEmail }) {
  const result = await pool.query(
    `SELECT e.id, e.employee_code, e.full_legal_name, e.status, e.primary_site_id,
            (LOWER(e.full_legal_name) = LOWER($1) AND e.primary_site_id = $2) AS name_site_match,
            (pd.cnic IS NOT NULL AND pd.cnic = ANY($3::text[])) AS cnic_match,
            (pd.mobile IS NOT NULL AND pd.mobile = ANY($4::text[])) AS mobile_match,
            (pd.personal_email IS NOT NULL AND LOWER(pd.personal_email) = ANY($5::text[])) AS email_match
     FROM employees e
     LEFT JOIN employee_personal_details pd ON pd.employee_id = e.id
     WHERE (LOWER(e.full_legal_name) = LOWER($1) AND e.primary_site_id = $2)
        OR (pd.cnic IS NOT NULL AND pd.cnic = ANY($3::text[]))
        OR (pd.mobile IS NOT NULL AND pd.mobile = ANY($4::text[]))
        OR (pd.personal_email IS NOT NULL AND LOWER(pd.personal_email) = ANY($5::text[]))`,
    [
      fullLegalName,
      primarySiteId,
      cnic ? [cnic] : [],
      mobile ? [mobile] : [],
      personalEmail ? [personalEmail.toLowerCase()] : [],
    ],
  );

  return result.rows;
}

export async function insertEmployee(client, { employeeCode, fullLegalName, primarySiteId, joiningDate, createdByUserId }) {
  const result = await client.query(
    `INSERT INTO employees (employee_code, full_legal_name, primary_site_id, joining_date, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, employee_code, full_legal_name, primary_site_id, status, joining_date, user_id`,
    [employeeCode, fullLegalName, primarySiteId, joiningDate, createdByUserId],
  );
  return result.rows[0];
}

// Locks the Employee row for the duration of the caller's transaction so a
// status/link/site decision is made against authoritative current state,
// not a value read before the transaction began (ESDMS-004/033/006).
export async function lockEmployeeById(client, id) {
  const result = await client.query(
    `SELECT id, employee_code, full_legal_name, primary_site_id, status, user_id
     FROM employees WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] || null;
}

// Fresh, current-assignment carry-forward fields for a transfer — callable
// with either `pool` or a transaction `client`. Kept as a plain (unlocked)
// read of employment_assignments: a transfer only INSERTs a new row here,
// it never locks/updates an existing one, so there is nothing to lock —
// reading it AFTER the Employee row lock is held is sufficient to see any
// transfer that already committed.
export async function findCurrentAssignmentFields(client, employeeId) {
  const result = await client.query(
    `SELECT department_id, position_id, employment_type_id, rotation_policy_id, reporting_manager_employee_id
     FROM employment_assignments
     WHERE employee_id = $1 AND effective_date <= CURRENT_DATE
     ORDER BY effective_date DESC, created_at DESC
     LIMIT 1`,
    [employeeId],
  );
  return result.rows[0] || {};
}

export async function linkUserAccount(client, employeeId, userId) {
  const result = await client.query(
    `UPDATE employees
     SET user_id = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND user_id IS NULL
     RETURNING user_id`,
    [employeeId, userId],
  );

  return result.rows[0] || null;
}

export async function updateEmployeeStatus(client, employeeId, { status, statusReason }) {
  const result = await client.query(
    `UPDATE employees SET status = $2, status_reason = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 RETURNING id, status`,
    [employeeId, status, statusReason || null],
  );
  return result.rows[0];
}

export async function updateEmployeeCoreFields(client, employeeId, { fullLegalName, employeeCode }) {
  const result = await client.query(
    `UPDATE employees
     SET full_legal_name = COALESCE($2, full_legal_name),
         employee_code = COALESCE($3, employee_code),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, employee_code, full_legal_name`,
    [employeeId, fullLegalName ?? null, employeeCode ?? null],
  );
  return result.rows[0];
}

// --- Employment assignments (effective-dated history) ---------------------

// ON CONFLICT (employee_id, effective_date) updates in place rather than
// erroring: two assignment rows on the EXACT same date aren't two distinct
// historical periods (only one can ever describe "as of that date"), so a
// same-day correction — e.g. assigning a rotation policy the same day an
// employee is created, or fixing today's transfer before end of day —
// amends that one row instead of colliding on the unique constraint. Any
// other date always inserts a genuinely new historical row, preserving the
// "never overwrite past assignments" invariant for actual history.
export async function insertAssignment(client, assignment) {
  const result = await client.query(
    `INSERT INTO employment_assignments
       (employee_id, site_id, department_id, position_id, employment_type_id, rotation_policy_id,
        reporting_manager_employee_id, effective_date, reason, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (employee_id, effective_date) DO UPDATE SET
       site_id = EXCLUDED.site_id,
       department_id = EXCLUDED.department_id,
       position_id = EXCLUDED.position_id,
       employment_type_id = EXCLUDED.employment_type_id,
       rotation_policy_id = EXCLUDED.rotation_policy_id,
       reporting_manager_employee_id = EXCLUDED.reporting_manager_employee_id,
       reason = EXCLUDED.reason,
       created_by_user_id = EXCLUDED.created_by_user_id
     RETURNING id, effective_date`,
    [
      assignment.employeeId,
      assignment.siteId,
      assignment.departmentId || null,
      assignment.positionId || null,
      assignment.employmentTypeId || null,
      assignment.rotationPolicyId || null,
      assignment.reportingManagerEmployeeId || null,
      assignment.effectiveDate,
      assignment.reason || null,
      assignment.createdByUserId,
    ],
  );
  return result.rows[0];
}

export async function listAssignmentHistory(employeeId) {
  const result = await pool.query(
    `SELECT ea.id, ea.site_id, ea.department_id, ea.position_id, ea.employment_type_id,
            ea.rotation_policy_id, ea.reporting_manager_employee_id, ea.effective_date, ea.reason,
            ea.created_by_user_id, ea.created_at,
            d.name AS department_name, p.name AS position_name, et.name AS employment_type_name,
            rm.full_legal_name AS reporting_manager_name
     FROM employment_assignments ea
     LEFT JOIN departments d ON d.id = ea.department_id
     LEFT JOIN positions p ON p.id = ea.position_id
     LEFT JOIN employment_types et ON et.id = ea.employment_type_id
     LEFT JOIN employees rm ON rm.id = ea.reporting_manager_employee_id
     WHERE ea.employee_id = $1
     ORDER BY ea.effective_date DESC, ea.created_at DESC`,
    [employeeId],
  );
  return result.rows;
}

// Dedicated, fixed advisory-lock key for ALL reporting-hierarchy
// mutations (any write that sets employment_assignments.reporting_manager_
// employee_id). Arbitrary but constant — chosen once here and never reused
// for anything else in this codebase, so it can never collide with an
// unrelated advisory lock. Must be acquired with pg_advisory_xact_lock
// (transaction-scoped: released automatically on COMMIT/ROLLBACK, never
// needs an explicit unlock) from WITHIN the same transaction that then runs
// the cycle check and the assignment write, so cycle validation and the
// mutation it guards are serialized against every other concurrent
// reporting-manager assignment — see acquireReportingHierarchyLock.
export const REPORTING_HIERARCHY_LOCK_KEY = 861203501;

export async function acquireReportingHierarchyLock(client) {
  await client.query("SELECT pg_advisory_xact_lock($1)", [REPORTING_HIERARCHY_LOCK_KEY]);
}

// Recursive-CTE cycle check: walks the FULL current reporting chain from
// proposedManagerId upward (via each employee's latest effective
// assignment), not a hop-capped loop — a hierarchy deeper than any fixed
// cap can no longer bypass detection (ESDMS-040). The `visited` array guard
// inside the recursion also protects against a pre-existing data cycle
// (defensive: this function is what's supposed to prevent one existing at
// all) causing infinite recursion. Takes a client (pool or transaction
// client) rather than always using the module pool, so a caller holding the
// reporting-hierarchy advisory lock runs this check inside that same
// transaction/connection.
export async function wouldCreateReportingCycle(client, employeeId, proposedManagerId) {
  if (employeeId === proposedManagerId) return true;

  const result = await client.query(
    `WITH RECURSIVE current_manager AS (
       SELECT DISTINCT ON (ea.employee_id)
              ea.employee_id, ea.reporting_manager_employee_id AS manager_id
       FROM employment_assignments ea
       WHERE ea.effective_date <= CURRENT_DATE
       ORDER BY ea.employee_id, ea.effective_date DESC, ea.created_at DESC
     ),
     chain AS (
       SELECT $2::uuid AS current_id, ARRAY[$2::uuid]::uuid[] AS visited
       UNION ALL
       SELECT cm.manager_id, chain.visited || cm.manager_id
       FROM chain
       JOIN current_manager cm ON cm.employee_id = chain.current_id
       WHERE cm.manager_id IS NOT NULL
         AND NOT (cm.manager_id = ANY(chain.visited))
     )
     SELECT EXISTS (SELECT 1 FROM chain WHERE current_id = $1) AS cycle`,
    [employeeId, proposedManagerId],
  );

  return result.rows[0].cycle;
}
