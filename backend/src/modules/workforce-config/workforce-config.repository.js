import pool from "../../config/database.js";

// --- Profile sections -------------------------------------------------------
export async function listSections({ activeOnly = false } = {}) {
  const result = await pool.query(
    `SELECT id, name, description, sort_order, is_active FROM employee_profile_sections
     ${activeOnly ? "WHERE is_active = true" : ""}
     ORDER BY sort_order, name`,
  );
  return result.rows;
}

export async function findSectionById(id) {
  const result = await pool.query("SELECT id, is_active FROM employee_profile_sections WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function insertSection({ name, description, sortOrder }) {
  const result = await pool.query(
    `INSERT INTO employee_profile_sections (name, description, sort_order)
     VALUES ($1, $2, COALESCE($3, 0)) RETURNING id, name, description, sort_order, is_active`,
    [name, description || null, sortOrder ?? null],
  );
  return result.rows[0];
}

export async function updateSectionFields(id, { name, description, sortOrder, isActive }) {
  const result = await pool.query(
    `UPDATE employee_profile_sections
     SET name = COALESCE($2, name),
         description = CASE WHEN $3::boolean THEN $4 ELSE description END,
         sort_order = COALESCE($5, sort_order),
         is_active = COALESCE($6, is_active),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, name, description, sort_order, is_active`,
    [id, name ?? null, description !== undefined, description ?? null, sortOrder ?? null, isActive ?? null],
  );
  return result.rows[0] || null;
}

// --- Custom fields -----------------------------------------------------------
const FIELD_COLUMNS = `
  id, section_id, label, field_key, field_type, help_text, is_required,
  employee_can_view, employee_can_edit, hr_can_view, hr_can_edit, management_can_view,
  is_searchable, is_filterable, is_reportable, is_sensitive, counts_toward_completion,
  validation, sort_order, is_active
`;

export async function listFields({ activeOnly = false } = {}) {
  const result = await pool.query(
    `SELECT ${FIELD_COLUMNS} FROM employee_custom_fields
     ${activeOnly ? "WHERE is_active = true" : ""}
     ORDER BY sort_order, label`,
  );
  return result.rows;
}

export async function findFieldById(id) {
  const result = await pool.query(`SELECT ${FIELD_COLUMNS}, field_type FROM employee_custom_fields WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

export async function fieldKeyExists(fieldKey) {
  const result = await pool.query("SELECT 1 FROM employee_custom_fields WHERE field_key = $1", [fieldKey]);
  return result.rowCount > 0;
}

export async function fieldHasValues(fieldId) {
  const result = await pool.query("SELECT 1 FROM employee_custom_field_values WHERE field_id = $1 LIMIT 1", [fieldId]);
  return result.rowCount > 0;
}

export async function insertField(input) {
  const result = await pool.query(
    `INSERT INTO employee_custom_fields
       (section_id, label, field_key, field_type, help_text, is_required,
        employee_can_view, employee_can_edit, hr_can_view, hr_can_edit, management_can_view,
        is_searchable, is_filterable, is_reportable, is_sensitive, counts_toward_completion,
        validation, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::jsonb, COALESCE($18, 0))
     RETURNING ${FIELD_COLUMNS}`,
    [
      input.sectionId,
      input.label,
      input.fieldKey,
      input.fieldType,
      input.helpText || null,
      input.isRequired ?? false,
      input.employeeCanView ?? true,
      input.employeeCanEdit ?? true,
      input.hrCanView ?? true,
      input.hrCanEdit ?? true,
      input.managementCanView ?? false,
      input.isSearchable ?? false,
      input.isFilterable ?? false,
      input.isReportable ?? false,
      input.isSensitive ?? false,
      input.countsTowardCompletion ?? false,
      JSON.stringify(input.validation || {}),
      input.sortOrder ?? null,
    ],
  );
  return result.rows[0];
}

const UPDATABLE_FIELD_COLUMNS = [
  ["label", "label"],
  ["section_id", "sectionId"],
  ["help_text", "helpText"],
  ["is_required", "isRequired"],
  ["employee_can_view", "employeeCanView"],
  ["employee_can_edit", "employeeCanEdit"],
  ["hr_can_view", "hrCanView"],
  ["hr_can_edit", "hrCanEdit"],
  ["management_can_view", "managementCanView"],
  ["is_searchable", "isSearchable"],
  ["is_filterable", "isFilterable"],
  ["is_reportable", "isReportable"],
  ["is_sensitive", "isSensitive"],
  ["counts_toward_completion", "countsTowardCompletion"],
  ["sort_order", "sortOrder"],
  ["is_active", "isActive"],
];

export async function updateFieldFields(id, input) {
  const sets = [];
  const params = [id];

  for (const [column, key] of UPDATABLE_FIELD_COLUMNS) {
    if (input[key] !== undefined) {
      params.push(input[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (input.validation !== undefined) {
    params.push(JSON.stringify(input.validation));
    sets.push(`validation = $${params.length}::jsonb`);
  }
  if (sets.length === 0) {
    return findFieldById(id);
  }

  sets.push("updated_at = CURRENT_TIMESTAMP");
  const result = await pool.query(
    `UPDATE employee_custom_fields SET ${sets.join(", ")} WHERE id = $1 RETURNING ${FIELD_COLUMNS}`,
    params,
  );
  return result.rows[0] || null;
}

// --- Document types ------------------------------------------------------
const DOC_TYPE_COLUMNS = `
  id, name, is_required, employee_can_upload, hr_can_upload, employee_can_view, hr_can_view,
  expiry_required, verification_required, allowed_mime_types, sort_order, is_active
`;

export async function listDocumentTypes({ activeOnly = false } = {}) {
  const result = await pool.query(
    `SELECT ${DOC_TYPE_COLUMNS} FROM employee_document_types
     ${activeOnly ? "WHERE is_active = true" : ""}
     ORDER BY sort_order, name`,
  );
  return result.rows;
}

export async function findDocumentTypeById(id) {
  const result = await pool.query(`SELECT ${DOC_TYPE_COLUMNS} FROM employee_document_types WHERE id = $1`, [id]);
  return result.rows[0] || null;
}

export async function documentTypeNameExists(name) {
  const result = await pool.query("SELECT 1 FROM employee_document_types WHERE name = $1", [name]);
  return result.rowCount > 0;
}

export async function insertDocumentType(input) {
  const result = await pool.query(
    `INSERT INTO employee_document_types
       (name, is_required, employee_can_upload, hr_can_upload, employee_can_view, hr_can_view,
        expiry_required, verification_required, allowed_mime_types, sort_order)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, COALESCE($10, 0))
     RETURNING ${DOC_TYPE_COLUMNS}`,
    [
      input.name,
      input.isRequired ?? false,
      input.employeeCanUpload ?? true,
      input.hrCanUpload ?? true,
      input.employeeCanView ?? true,
      input.hrCanView ?? true,
      input.expiryRequired ?? false,
      input.verificationRequired ?? false,
      input.allowedMimeTypes || ["application/pdf", "image/jpeg", "image/png"],
      input.sortOrder ?? null,
    ],
  );
  return result.rows[0];
}

const UPDATABLE_DOC_TYPE_COLUMNS = [
  ["name", "name"],
  ["is_required", "isRequired"],
  ["employee_can_upload", "employeeCanUpload"],
  ["hr_can_upload", "hrCanUpload"],
  ["employee_can_view", "employeeCanView"],
  ["hr_can_view", "hrCanView"],
  ["expiry_required", "expiryRequired"],
  ["verification_required", "verificationRequired"],
  ["allowed_mime_types", "allowedMimeTypes"],
  ["sort_order", "sortOrder"],
  ["is_active", "isActive"],
];

export async function updateDocumentTypeFields(id, input) {
  const sets = [];
  const params = [id];
  for (const [column, key] of UPDATABLE_DOC_TYPE_COLUMNS) {
    if (input[key] !== undefined) {
      params.push(input[key]);
      sets.push(`${column} = $${params.length}`);
    }
  }
  if (sets.length === 0) return findDocumentTypeById(id);

  sets.push("updated_at = CURRENT_TIMESTAMP");
  const result = await pool.query(
    `UPDATE employee_document_types SET ${sets.join(", ")} WHERE id = $1 RETURNING ${DOC_TYPE_COLUMNS}`,
    params,
  );
  return result.rows[0] || null;
}

export async function documentTypeInUse(documentTypeId) {
  const result = await pool.query("SELECT 1 FROM employee_documents WHERE document_type_id = $1 LIMIT 1", [
    documentTypeId,
  ]);
  return result.rowCount > 0;
}
