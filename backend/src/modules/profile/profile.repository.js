import pool from "../../config/database.js";

export async function getPersonalDetails(employeeId) {
  const result = await pool.query(
    `SELECT employee_id, cnic, mobile, address, personal_email, current_photo_id, updated_at
     FROM employee_personal_details WHERE employee_id = $1`,
    [employeeId],
  );
  return result.rows[0] || null;
}

export async function upsertPersonalDetails(employeeId, { cnic, mobile, address, personalEmail }) {
  const result = await pool.query(
    `INSERT INTO employee_personal_details (employee_id, cnic, mobile, address, personal_email)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (employee_id) DO UPDATE SET
       cnic = COALESCE($2, employee_personal_details.cnic),
       mobile = COALESCE($3, employee_personal_details.mobile),
       address = COALESCE($4, employee_personal_details.address),
       personal_email = COALESCE($5, employee_personal_details.personal_email),
       updated_at = CURRENT_TIMESTAMP
     RETURNING employee_id, cnic, mobile, address, personal_email, current_photo_id`,
    [employeeId, cnic ?? null, mobile ?? null, address ?? null, personalEmail ?? null],
  );
  return result.rows[0];
}

export async function listEmergencyContacts(employeeId) {
  const result = await pool.query(
    `SELECT id, name, relationship, phone, alternate_phone, sort_order
     FROM employee_emergency_contacts WHERE employee_id = $1 ORDER BY sort_order, name`,
    [employeeId],
  );
  return result.rows;
}

export async function insertEmergencyContact(employeeId, { name, relationship, phone, alternatePhone, sortOrder }) {
  const result = await pool.query(
    `INSERT INTO employee_emergency_contacts (employee_id, name, relationship, phone, alternate_phone, sort_order)
     VALUES ($1, $2, $3, $4, $5, COALESCE($6, 0))
     RETURNING id, name, relationship, phone, alternate_phone, sort_order`,
    [employeeId, name, relationship || null, phone, alternatePhone || null, sortOrder ?? null],
  );
  return result.rows[0];
}

export async function findEmergencyContact(id) {
  const result = await pool.query("SELECT id, employee_id FROM employee_emergency_contacts WHERE id = $1", [id]);
  return result.rows[0] || null;
}

export async function updateEmergencyContact(id, { name, relationship, phone, alternatePhone, sortOrder }) {
  const result = await pool.query(
    `UPDATE employee_emergency_contacts
     SET name = COALESCE($2, name), relationship = COALESCE($3, relationship),
         phone = COALESCE($4, phone), alternate_phone = COALESCE($5, alternate_phone),
         sort_order = COALESCE($6, sort_order), updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, name, relationship, phone, alternate_phone, sort_order`,
    [id, name ?? null, relationship ?? null, phone ?? null, alternatePhone ?? null, sortOrder ?? null],
  );
  return result.rows[0] || null;
}

export async function deleteEmergencyContact(id) {
  await pool.query("DELETE FROM employee_emergency_contacts WHERE id = $1", [id]);
}

export async function getCustomFieldValues(employeeId) {
  const result = await pool.query(
    `SELECT v.field_id, v.value, v.updated_at,
            f.label, f.field_key, f.field_type, f.section_id, f.is_required,
            f.employee_can_view, f.employee_can_edit, f.hr_can_view, f.hr_can_edit,
            f.management_can_view, f.is_sensitive, f.counts_toward_completion, f.validation, f.is_active
     FROM employee_custom_field_values v
     JOIN employee_custom_fields f ON f.id = v.field_id
     WHERE v.employee_id = $1`,
    [employeeId],
  );
  return result.rows;
}

export async function insertProfilePhoto(client, { employeeId, storageKey, mimeType, sizeBytes, checksumSha256, uploadedByUserId }) {
  const result = await client.query(
    `INSERT INTO employee_profile_photos (employee_id, storage_key, mime_type, size_bytes, checksum_sha256, version, uploaded_by_user_id)
     VALUES ($1, $2, $3, $4, $5,
       COALESCE((SELECT max(version) FROM employee_profile_photos WHERE employee_id = $1), 0) + 1,
       $6)
     RETURNING id, storage_key, version`,
    [employeeId, storageKey, mimeType, sizeBytes, checksumSha256, uploadedByUserId],
  );
  return result.rows[0];
}

export async function setCurrentPhoto(client, employeeId, photoId) {
  await client.query(
    `INSERT INTO employee_personal_details (employee_id, current_photo_id)
     VALUES ($1, $2)
     ON CONFLICT (employee_id) DO UPDATE SET current_photo_id = $2, updated_at = CURRENT_TIMESTAMP`,
    [employeeId, photoId],
  );
}

export async function findCurrentPhoto(employeeId) {
  const result = await pool.query(
    `SELECT p.id, p.storage_key, p.mime_type, p.checksum_sha256
     FROM employee_personal_details pd
     JOIN employee_profile_photos p ON p.id = pd.current_photo_id
     WHERE pd.employee_id = $1`,
    [employeeId],
  );
  return result.rows[0] || null;
}

export async function upsertCustomFieldValue(employeeId, fieldId, value, actorUserId) {
  const result = await pool.query(
    `INSERT INTO employee_custom_field_values (employee_id, field_id, value, updated_by_user_id)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (employee_id, field_id) DO UPDATE SET
       value = $3::jsonb, updated_by_user_id = $4, updated_at = CURRENT_TIMESTAMP
     RETURNING field_id, value`,
    [employeeId, fieldId, JSON.stringify(value), actorUserId],
  );
  return result.rows[0];
}
