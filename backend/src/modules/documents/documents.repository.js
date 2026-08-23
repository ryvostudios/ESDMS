import pool from "../../config/database.js";

const DOC_COLUMNS = `
  d.id, d.employee_id, d.document_type_id, d.version, d.storage_key, d.mime_type, d.size_bytes,
  d.checksum_sha256, d.original_filename, d.uploaded_by_user_id, d.uploaded_at, d.expiry_date,
  d.verification_status, d.verified_by_user_id, d.verified_at, d.verification_remark,
  dt.name AS document_type_name, dt.employee_can_view, dt.hr_can_view
`;

// "Latest" per (employee, document_type) — same DISTINCT ON pattern used
// elsewhere for "current" rows, avoiding a mutable is_current flag (see
// docs/DECISIONS.md; mirrors gate_pass_files's own latest-by-version query
// convention).
export async function listLatestDocuments(employeeId) {
  const result = await pool.query(
    `SELECT DISTINCT ON (d.document_type_id) ${DOC_COLUMNS}
     FROM employee_documents d
     JOIN employee_document_types dt ON dt.id = d.document_type_id
     WHERE d.employee_id = $1
     ORDER BY d.document_type_id, d.version DESC`,
    [employeeId],
  );
  return result.rows;
}

export async function listDocumentVersions(employeeId, documentTypeId) {
  const result = await pool.query(
    `SELECT ${DOC_COLUMNS}
     FROM employee_documents d
     JOIN employee_document_types dt ON dt.id = d.document_type_id
     WHERE d.employee_id = $1 AND d.document_type_id = $2
     ORDER BY d.version DESC`,
    [employeeId, documentTypeId],
  );
  return result.rows;
}

export async function findDocumentById(id) {
  const result = await pool.query(`SELECT ${DOC_COLUMNS} FROM employee_documents d JOIN employee_document_types dt ON dt.id = d.document_type_id WHERE d.id = $1`, [id]);
  return result.rows[0] || null;
}

export async function insertDocument(client, { employeeId, documentTypeId, storageKey, mimeType, sizeBytes, checksumSha256, originalFilename, expiryDate, uploadedByUserId }) {
  const result = await client.query(
    `INSERT INTO employee_documents
       (employee_id, document_type_id, version, storage_key, mime_type, size_bytes, checksum_sha256,
        original_filename, expiry_date, uploaded_by_user_id)
     VALUES ($1, $2,
       COALESCE((SELECT max(version) FROM employee_documents WHERE employee_id = $1 AND document_type_id = $2), 0) + 1,
       $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, version`,
    [employeeId, documentTypeId, storageKey, mimeType, sizeBytes, checksumSha256, originalFilename, expiryDate || null, uploadedByUserId],
  );
  return result.rows[0];
}

export async function setVerificationStatus(client, documentId, { status, verifiedByUserId, remark }) {
  const result = await client.query(
    `UPDATE employee_documents
     SET verification_status = $2, verified_by_user_id = $3, verified_at = CURRENT_TIMESTAMP, verification_remark = $4
     WHERE id = $1
     RETURNING id, verification_status`,
    [documentId, status, verifiedByUserId, remark || null],
  );
  return result.rows[0];
}

export async function listExpiring(siteId, withinDays) {
  const result = await pool.query(
    `SELECT DISTINCT ON (d.employee_id, d.document_type_id) ${DOC_COLUMNS}, e.employee_code, e.full_legal_name
     FROM employee_documents d
     JOIN employee_document_types dt ON dt.id = d.document_type_id
     JOIN employees e ON e.id = d.employee_id
     WHERE d.expiry_date IS NOT NULL
       AND d.expiry_date <= CURRENT_DATE + $2::int
       AND ($1::uuid IS NULL OR e.primary_site_id = $1)
     ORDER BY d.employee_id, d.document_type_id, d.version DESC`,
    [siteId, withinDays],
  );
  return result.rows;
}

// --- Document requests -----------------------------------------------------

export async function insertRequest(employeeId, documentTypeId, requestedByUserId, note) {
  const result = await pool.query(
    `INSERT INTO employee_document_requests (employee_id, document_type_id, requested_by_user_id, note)
     VALUES ($1, $2, $3, $4) RETURNING id, status, created_at`,
    [employeeId, documentTypeId, requestedByUserId, note || null],
  );
  return result.rows[0];
}

export async function listPendingRequests(employeeId) {
  const result = await pool.query(
    `SELECT r.id, r.document_type_id, r.note, r.status, r.created_at, dt.name AS document_type_name
     FROM employee_document_requests r
     JOIN employee_document_types dt ON dt.id = r.document_type_id
     WHERE r.employee_id = $1 AND r.status = 'PENDING'
     ORDER BY r.created_at DESC`,
    [employeeId],
  );
  return result.rows;
}

export async function fulfillMatchingRequests(client, employeeId, documentTypeId, documentId) {
  await client.query(
    `UPDATE employee_document_requests
     SET status = 'FULFILLED', fulfilled_document_id = $3, resolved_at = CURRENT_TIMESTAMP
     WHERE employee_id = $1 AND document_type_id = $2 AND status = 'PENDING'`,
    [employeeId, documentTypeId, documentId],
  );
}

export async function cancelRequest(client, requestId) {
  const result = await client.query(
    "UPDATE employee_document_requests SET status = 'CANCELLED', resolved_at = CURRENT_TIMESTAMP WHERE id = $1 AND status = 'PENDING'",
    [requestId],
  );
  return result.rowCount > 0;
}

export async function findRequestById(id) {
  const result = await pool.query(
    "SELECT id, employee_id, document_type_id, status FROM employee_document_requests WHERE id = $1",
    [id],
  );
  return result.rows[0] || null;
}
