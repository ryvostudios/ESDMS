import pool from "../../config/database.js";

const CONTRACT_COLUMNS = `
  id, employee_id, contract_number, kind, amends_contract_id, status,
  effective_start_date, effective_end_date, terms_summary, storage_key, mime_type, size_bytes,
  checksum_sha256, finalized_at, finalized_by_user_id, created_by_user_id, created_at, updated_at
`;

export async function listForEmployee(employeeId, { includeDrafts = true } = {}) {
  const result = await pool.query(
    `SELECT ${CONTRACT_COLUMNS} FROM employee_contracts
     WHERE employee_id = $1 ${includeDrafts ? "" : "AND status <> 'DRAFT'"}
     ORDER BY created_at DESC`,
    [employeeId],
  );
  return result.rows;
}

export async function findById(id) {
  const result = await pool.query(`SELECT ${CONTRACT_COLUMNS} FROM employee_contracts WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

export async function nextContractNumber(client, kind) {
  const year = new Date().getFullYear();
  const prefix = kind === "AMENDMENT" ? "AMD" : "EC";
  const result = await client.query(
    `INSERT INTO employee_contract_number_counters (year, kind, last_value)
     VALUES ($1, $2, 1)
     ON CONFLICT (year, kind) DO UPDATE SET last_value = employee_contract_number_counters.last_value + 1
     RETURNING last_value`,
    [year, kind],
  );
  return `${prefix}-${year}-${String(result.rows[0].last_value).padStart(6, "0")}`;
}

export async function insertDraft(client, { employeeId, contractNumber, kind, amendsContractId, effectiveStartDate, termsSummary, createdByUserId }) {
  const result = await client.query(
    `INSERT INTO employee_contracts
       (employee_id, contract_number, kind, amends_contract_id, effective_start_date, terms_summary, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING ${CONTRACT_COLUMNS}`,
    [employeeId, contractNumber, kind, amendsContractId || null, effectiveStartDate || null, termsSummary || null, createdByUserId],
  );
  return result.rows[0];
}

// Only reachable while status = DRAFT — the caller (contracts.service.js)
// checks this first, and the DB trigger enforces it unconditionally as the
// real backstop (see 1787405000000_workforce-schema-foundation.js).
export async function replaceDraftFile(client, id, { storageKey, mimeType, sizeBytes, checksumSha256 }) {
  const result = await client.query(
    `UPDATE employee_contracts
     SET storage_key = $2, mime_type = $3, size_bytes = $4, checksum_sha256 = $5, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING ${CONTRACT_COLUMNS}`,
    [id, storageKey, mimeType, sizeBytes, checksumSha256],
  );
  return result.rows[0] || null;
}

export async function updateDraftMetadata(client, id, { effectiveStartDate, termsSummary }) {
  const result = await client.query(
    `UPDATE employee_contracts
     SET effective_start_date = COALESCE($2, effective_start_date),
         terms_summary = COALESCE($3, terms_summary),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING ${CONTRACT_COLUMNS}`,
    [id, effectiveStartDate || null, termsSummary || null],
  );
  return result.rows[0] || null;
}

export async function finalize(client, id, { finalizedByUserId }) {
  const result = await client.query(
    `UPDATE employee_contracts
     SET status = 'CURRENT', finalized_at = CURRENT_TIMESTAMP, finalized_by_user_id = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'DRAFT'
     RETURNING ${CONTRACT_COLUMNS}`,
    [id, finalizedByUserId],
  );
  return result.rows[0] || null;
}

// Status-only lifecycle transition for an already-finalized contract
// (CURRENT -> SUPERSEDED/EXPIRED/TERMINATED) — the only mutation the DB
// trigger permits post-finalization besides effective_end_date.
export async function transitionStatus(client, id, { status }) {
  const result = await client.query(
    `UPDATE employee_contracts
     SET status = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND status = 'CURRENT'
     RETURNING ${CONTRACT_COLUMNS}`,
    [id, status],
  );
  return result.rows[0] || null;
}

export async function deleteDraft(client, id) {
  const result = await client.query("DELETE FROM employee_contracts WHERE id = $1 AND status = 'DRAFT' RETURNING storage_key", [id]);
  return result.rows[0] || null;
}
