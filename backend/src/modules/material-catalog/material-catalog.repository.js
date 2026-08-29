import pool from "../../config/database.js";

export async function listActiveUnitsOfMeasure() {
  const result = await pool.query("SELECT id, code, name FROM units_of_measure WHERE is_active = true ORDER BY name");
  return result.rows;
}

export async function findCompanyItemById(id, executor = pool) {
  const result = await executor.query(
    "SELECT id, name, description, is_active FROM company_items WHERE id = $1",
    [id],
  );
  return result.rows[0] || null;
}

export async function hasActiveCatalogEntries(companyItemId, executor = pool) {
  const result = await executor.query(
    "SELECT 1 FROM department_material_catalog WHERE company_item_id = $1 AND is_active = true LIMIT 1",
    [companyItemId],
  );
  return result.rowCount > 0;
}

export async function updateCompanyItemFields(client, id, { name, description, isActive }) {
  const result = await client.query(
    `UPDATE company_items
     SET name = COALESCE($2, name),
         description = CASE WHEN $3::boolean THEN $4 ELSE description END,
         is_active = COALESCE($5, is_active),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, name, description, is_active`,
    [id, name ?? null, description !== undefined, description ?? null, isActive ?? null],
  );
  return result.rows[0] || null;
}

// Used both as the "add material" duplicate-prevention search and to check
// whether a brand-new item's name resembles something already in the
// global catalog — warns, never hard-blocks, matching the existing
// Employee duplicate-detection convention.
export async function searchCompanyItems(term, departmentId) {
  const result = await pool.query(
    `SELECT ci.id, ci.name, ci.description,
            EXISTS (
              SELECT 1 FROM department_material_catalog dmc
              WHERE dmc.company_item_id = ci.id AND dmc.department_id = $2
            ) AS in_department_catalog
     FROM company_items ci
     WHERE ci.is_active = true AND ci.name ILIKE '%' || $1 || '%'
     ORDER BY ci.name
     LIMIT 20`,
    [term, departmentId || null],
  );
  return result.rows;
}

// Used only for the create-time "does this look like something that
// already exists?" warning — deliberately bidirectional (unlike
// searchCompanyItems' type-ahead one-directional match), since a new
// item's full candidate name ("Cement Grade A") and an existing shorter
// item's name ("Cement") need to flag each other regardless of which one
// contains the other. Still a plain ILIKE, not a fuzzy/trigram engine —
// warns, never blocks (see material-catalog.service.js).
export async function findSimilarCompanyItems(name, departmentId) {
  const result = await pool.query(
    `SELECT ci.id, ci.name, ci.description,
            EXISTS (
              SELECT 1 FROM department_material_catalog dmc
              WHERE dmc.company_item_id = ci.id AND dmc.department_id = $2
            ) AS in_department_catalog
     FROM company_items ci
     WHERE ci.is_active = true
       AND (ci.name ILIKE '%' || $1 || '%' OR $1 ILIKE '%' || ci.name || '%')
     ORDER BY ci.name
     LIMIT 20`,
    [name, departmentId || null],
  );
  return result.rows;
}

export async function insertCompanyItem(client, { name, description, createdByUserId }) {
  const result = await client.query(
    `INSERT INTO company_items (name, description, created_by_user_id)
     VALUES ($1, $2, $3)
     RETURNING id, name, description, is_active`,
    [name, description ?? null, createdByUserId],
  );
  return result.rows[0];
}

export async function catalogEntryExists(departmentId, companyItemId) {
  const result = await pool.query(
    "SELECT 1 FROM department_material_catalog WHERE department_id = $1 AND company_item_id = $2",
    [departmentId, companyItemId],
  );
  return result.rowCount > 0;
}

export async function insertCatalogEntry(client, { departmentId, companyItemId, defaultUomId, createdByUserId }) {
  const result = await client.query(
    `INSERT INTO department_material_catalog (department_id, company_item_id, default_uom_id, created_by_user_id)
     VALUES ($1, $2, $3, $4)
     RETURNING id, department_id, company_item_id, default_uom_id, is_active`,
    [departmentId, companyItemId, defaultUomId, createdByUserId],
  );
  return result.rows[0];
}

export async function findCatalogEntryById(id) {
  const result = await pool.query(
    "SELECT id, department_id, company_item_id, default_uom_id, is_active FROM department_material_catalog WHERE id = $1",
    [id],
  );
  return result.rows[0] || null;
}

export async function updateCatalogEntryFields(id, { defaultUomId, isActive }) {
  const result = await pool.query(
    `UPDATE department_material_catalog
     SET default_uom_id = COALESCE($2, default_uom_id),
         is_active = COALESCE($3, is_active),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING id, department_id, company_item_id, default_uom_id, is_active`,
    [id, defaultUomId ?? null, isActive ?? null],
  );
  return result.rows[0] || null;
}

// departmentId === null means every department (company-wide actor,
// unfiltered) — matches departments.repository.js's listDepartmentsForSite
// null-means-unfiltered idiom.
export async function listCatalogForDepartment(departmentId, { search, includeInactive, page, pageSize }) {
  const params = [departmentId, search ? `%${search}%` : null, includeInactive];

  const rows = await pool.query(
    `SELECT dmc.id, dmc.department_id, d.name AS department_name, dmc.is_active,
            ci.id AS company_item_id, ci.name AS item_name, ci.description AS item_description,
            ci.is_active AS company_item_is_active,
            uom.id AS default_uom_id, uom.code AS default_uom_code, uom.name AS default_uom_name
     FROM department_material_catalog dmc
     JOIN company_items ci ON ci.id = dmc.company_item_id
     JOIN units_of_measure uom ON uom.id = dmc.default_uom_id
     JOIN departments d ON d.id = dmc.department_id
     WHERE ($1::uuid IS NULL OR dmc.department_id = $1)
       AND ($2::text IS NULL OR ci.name ILIKE $2)
       AND ((dmc.is_active = true AND ci.is_active = true) OR $3 = true)
     ORDER BY d.name, ci.name
     LIMIT $4 OFFSET $5`,
    [...params, pageSize, (page - 1) * pageSize],
  );

  const count = await pool.query(
    `SELECT count(*)::int AS total
     FROM department_material_catalog dmc
     JOIN company_items ci ON ci.id = dmc.company_item_id
     WHERE ($1::uuid IS NULL OR dmc.department_id = $1)
       AND ($2::text IS NULL OR ci.name ILIKE $2)
       AND ((dmc.is_active = true AND ci.is_active = true) OR $3 = true)`,
    params,
  );

  return { rows: rows.rows, total: count.rows[0].total };
}
