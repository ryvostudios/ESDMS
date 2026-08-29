import pool from "../../config/database.js";

const DRIVER_COLUMNS = `d.id, d.site_id, s.name AS site_name, d.name, d.phone, d.cnic,
       d.licence_number, d.licence_expiry, d.company, d.driver_type,
       d.employee_id, d.is_active, d.notes, d.created_at, d.updated_at`;

const VEHICLE_COLUMNS = `v.id, v.site_id, s.name AS site_name, v.registration_number, v.vehicle_type,
       v.make, v.model, v.color, v.owner_company, v.is_active, v.notes,
       v.created_at, v.updated_at`;

// siteId null means a company-wide actor (CEO / all-sites grant): every
// site's rows, not an empty result — the same convention positions and
// departments already use.
export async function listDrivers({ siteId, search, includeInactive }) {
  const result = await pool.query(
    `SELECT ${DRIVER_COLUMNS}, e.employee_code
     FROM drivers d
     JOIN sites s ON s.id = d.site_id
     LEFT JOIN employees e ON e.id = d.employee_id
     WHERE ($1::uuid IS NULL OR d.site_id = $1)
       AND ($2::text IS NULL OR d.name ILIKE $2 OR d.phone ILIKE $2 OR d.cnic ILIKE $2
            OR d.licence_number ILIKE $2 OR d.company ILIKE $2)
       AND (d.is_active = true OR $3 = true)
     ORDER BY d.is_active DESC, d.name`,
    [siteId, search ? `%${search}%` : null, includeInactive === true],
  );
  return result.rows;
}

export async function findDriverById(id, executor = pool) {
  const result = await executor.query(
    `SELECT ${DRIVER_COLUMNS}, e.employee_code
     FROM drivers d
     JOIN sites s ON s.id = d.site_id
     LEFT JOIN employees e ON e.id = d.employee_id
     WHERE d.id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

export async function insertDriver({
  siteId, name, phone, cnic, licenceNumber, licenceExpiry, company, driverType, employeeId, notes, createdByUserId,
}) {
  const result = await pool.query(
    `INSERT INTO drivers (site_id, name, phone, cnic, licence_number, licence_expiry,
                          company, driver_type, employee_id, notes, created_by_user_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, COALESCE($8, 'COMPANY'), $9, $10, $11)
     RETURNING id`,
    [siteId, name, phone, cnic ?? null, licenceNumber ?? null, licenceExpiry ?? null,
      company ?? null, driverType ?? null, employeeId ?? null, notes ?? null, createdByUserId],
  );
  return findDriverById(result.rows[0].id);
}

// COALESCE for "leave unchanged when absent"; the CASE pairs let an explicit
// null actually clear a nullable field, which COALESCE alone cannot express.
export async function updateDriverFields(id, input) {
  const result = await pool.query(
    `UPDATE drivers SET
       name = COALESCE($2, name),
       phone = COALESCE($3, phone),
       cnic = CASE WHEN $4::boolean THEN $5 ELSE cnic END,
       licence_number = CASE WHEN $6::boolean THEN $7 ELSE licence_number END,
       licence_expiry = CASE WHEN $8::boolean THEN $9::date ELSE licence_expiry END,
       company = CASE WHEN $10::boolean THEN $11 ELSE company END,
       driver_type = COALESCE($12, driver_type),
       employee_id = CASE WHEN $13::boolean THEN $14::uuid ELSE employee_id END,
       notes = CASE WHEN $15::boolean THEN $16 ELSE notes END,
       is_active = COALESCE($17, is_active)
     WHERE id = $1`,
    [
      id,
      input.name ?? null,
      input.phone ?? null,
      input.cnic !== undefined, input.cnic ?? null,
      input.licenceNumber !== undefined, input.licenceNumber ?? null,
      input.licenceExpiry !== undefined, input.licenceExpiry ?? null,
      input.company !== undefined, input.company ?? null,
      input.driverType ?? null,
      input.employeeId !== undefined, input.employeeId ?? null,
      input.notes !== undefined, input.notes ?? null,
      input.isActive ?? null,
    ],
  );
  return result.rowCount > 0 ? findDriverById(id) : null;
}

export async function listVehicles({ siteId, search, includeInactive }) {
  const result = await pool.query(
    `SELECT ${VEHICLE_COLUMNS}
     FROM vehicles v
     JOIN sites s ON s.id = v.site_id
     WHERE ($1::uuid IS NULL OR v.site_id = $1)
       AND ($2::text IS NULL OR v.registration_number ILIKE $2 OR v.make ILIKE $2
            OR v.model ILIKE $2 OR v.owner_company ILIKE $2)
       AND (v.is_active = true OR $3 = true)
     ORDER BY v.is_active DESC, v.registration_number`,
    [siteId, search ? `%${search}%` : null, includeInactive === true],
  );
  return result.rows;
}

export async function findVehicleById(id, executor = pool) {
  const result = await executor.query(
    `SELECT ${VEHICLE_COLUMNS} FROM vehicles v JOIN sites s ON s.id = v.site_id WHERE v.id = $1`,
    [id],
  );
  return result.rows[0] || null;
}

export async function insertVehicle({
  siteId, registrationNumber, vehicleType, make, model, color, ownerCompany, notes, createdByUserId,
}) {
  const result = await pool.query(
    `INSERT INTO vehicles (site_id, registration_number, vehicle_type, make, model, color,
                           owner_company, notes, created_by_user_id)
     VALUES ($1, $2, COALESCE($3, 'OTHER'), $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [siteId, registrationNumber, vehicleType ?? null, make ?? null, model ?? null,
      color ?? null, ownerCompany ?? null, notes ?? null, createdByUserId],
  );
  return findVehicleById(result.rows[0].id);
}

export async function updateVehicleFields(id, input) {
  const result = await pool.query(
    `UPDATE vehicles SET
       registration_number = COALESCE($2, registration_number),
       vehicle_type = COALESCE($3, vehicle_type),
       make = CASE WHEN $4::boolean THEN $5 ELSE make END,
       model = CASE WHEN $6::boolean THEN $7 ELSE model END,
       color = CASE WHEN $8::boolean THEN $9 ELSE color END,
       owner_company = CASE WHEN $10::boolean THEN $11 ELSE owner_company END,
       notes = CASE WHEN $12::boolean THEN $13 ELSE notes END,
       is_active = COALESCE($14, is_active)
     WHERE id = $1`,
    [
      id,
      input.registrationNumber ?? null,
      input.vehicleType ?? null,
      input.make !== undefined, input.make ?? null,
      input.model !== undefined, input.model ?? null,
      input.color !== undefined, input.color ?? null,
      input.ownerCompany !== undefined, input.ownerCompany ?? null,
      input.notes !== undefined, input.notes ?? null,
      input.isActive ?? null,
    ],
  );
  return result.rowCount > 0 ? findVehicleById(id) : null;
}

// Gate Pass history for a master row. Deliberately selects only operational
// columns: a Driver/Vehicle page must never become a side channel to
// commercial data, and Gate Passes carry none anyway.
export async function listGatePassHistory({ driverId, vehicleId, limit = 50 }) {
  const result = await pool.query(
    `SELECT gp.id, gp.gate_pass_number, gp.status, gp.purpose, gp.destination,
            gp.created_at, gp.departure_at, gp.return_at,
            d.name AS issuing_department_name
     FROM gate_passes gp
     JOIN departments d ON d.id = gp.issuing_department_id
     WHERE ($1::uuid IS NULL OR gp.driver_id = $1)
       AND ($2::uuid IS NULL OR gp.vehicle_id = $2)
     ORDER BY gp.created_at DESC
     LIMIT $3`,
    [driverId ?? null, vehicleId ?? null, limit],
  );
  return result.rows;
}

export async function findEmployeeSite(employeeId) {
  const result = await pool.query("SELECT id, primary_site_id FROM employees WHERE id = $1", [employeeId]);
  return result.rows[0] || null;
}
