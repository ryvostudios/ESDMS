import crypto from "node:crypto";
import ExcelJS from "exceljs";
import pool from "../../config/database.js";
import { config } from "../../config/env.js";
import { withTransaction } from "../../shared/db/with-transaction.js";
import { ForbiddenError, ValidationError } from "../../shared/errors/app-error.js";
import { recordGovernanceAudit } from "../../shared/audit/governance-audit.repository.js";
import { sanitizeCell, safeExportFilename } from "../../shared/reports/excel-safety.js";
import { employeeSiteFilter } from "../workforce/workforce.authorization.js";

const MAX_ROWS = 1000;
const MAX_UNCOMPRESSED_BYTES = 24 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 250;
const PREVIEW_TTL_MS = 15 * 60 * 1000;
const HEADERS = [
  "Employee ID",
  "Full Legal Name",
  "Joining Date",
  "Site Code",
  "Department",
  "Position",
  "Employment Type",
  "CNIC",
  "Mobile",
  "Personal Email",
];

function assertImportPermission(actor) {
  if (!actor.permissions.has("employees.bulk_import")) throw new ForbiddenError();
}

// XLSX is ZIP-based. Bound declared expansion before ExcelJS inflates it;
// this rejects ordinary ZIP bombs while the upload middleware separately
// bounds compressed bytes. The parser still enforces row and sheet limits.
function assertBoundedZip(buffer) {
  let eocd = -1;
  for (let offset = buffer.length - 22; offset >= Math.max(0, buffer.length - 65_557); offset -= 1) {
    if (buffer.readUInt32LE(offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new ValidationError("The workbook ZIP directory is invalid.");
  const entries = buffer.readUInt16LE(eocd + 10);
  const directorySize = buffer.readUInt32LE(eocd + 12);
  const directoryOffset = buffer.readUInt32LE(eocd + 16);
  if (entries === 0 || entries === 0xffff || entries > MAX_ZIP_ENTRIES || directoryOffset + directorySize > buffer.length) {
    throw new ValidationError("The workbook ZIP directory exceeds the safe import limit.");
  }
  let uncompressed = 0;
  let offset = directoryOffset;
  for (let index = 0; index < entries; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new ValidationError("The workbook ZIP directory is invalid.");
    }
    const flags = buffer.readUInt16LE(offset + 8);
    if (flags & 0x1) throw new ValidationError("Encrypted workbooks are not supported.");
    uncompressed += buffer.readUInt32LE(offset + 24);
    if (uncompressed > MAX_UNCOMPRESSED_BYTES) throw new ValidationError("The workbook expands beyond the safe import limit.");
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    offset += 46 + nameLength + extraLength + commentLength;
  }
}

function plainCell(cell, rowNumber, header) {
  if (cell.formula || cell.model?.formula || (cell.value && typeof cell.value === "object" && "formula" in cell.value)) {
    throw new ValidationError(`Row ${rowNumber}, ${header}: formulas are not permitted in imports.`);
  }
  if (cell.value === null || cell.value === undefined) return "";
  if (cell.value instanceof Date) return cell.value;
  if (typeof cell.value === "object") {
    if (Array.isArray(cell.value.richText)) return cell.value.richText.map((part) => part.text).join("").trim();
    if (cell.value.text) return String(cell.value.text).trim();
    throw new ValidationError(`Row ${rowNumber}, ${header}: unsupported cell value.`);
  }
  return typeof cell.value === "string" ? cell.value.trim() : cell.value;
}

function isoDate(value) {
  if (value instanceof Date && !Number.isNaN(value.valueOf())) return value.toISOString().slice(0, 10);
  const text = String(value || "").trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const parsed = new Date(`${text}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === text ? text : null;
}

function optionalText(value, max) {
  const text = String(value || "").trim();
  return text ? text.slice(0, max + 1) : null;
}

async function parseWorkbook(buffer) {
  assertBoundedZip(buffer);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer, { ignoreNodes: ["dataValidations"] });
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    throw new ValidationError("The workbook could not be parsed as .xlsx.");
  }
  const sheet = workbook.getWorksheet("Employees") || workbook.worksheets[0];
  if (!sheet) throw new ValidationError("The workbook has no Employees worksheet.");
  if (sheet.actualRowCount - 1 > MAX_ROWS) throw new ValidationError(`Imports are limited to ${MAX_ROWS} employee rows.`);
  if (sheet.actualColumnCount !== HEADERS.length) {
    throw new ValidationError("The workbook columns do not match the ESDMS Employee import template.", {
      expectedHeaders: HEADERS,
    });
  }

  const actualHeaders = HEADERS.map((_header, index) => String(sheet.getRow(1).getCell(index + 1).text || "").trim());
  if (actualHeaders.some((header, index) => header !== HEADERS[index])) {
    throw new ValidationError("The workbook headers do not match the ESDMS Employee import template.", {
      expectedHeaders: HEADERS,
    });
  }

  const rows = [];
  for (let rowNumber = 2; rowNumber <= sheet.actualRowCount; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const values = HEADERS.map((header, index) => plainCell(row.getCell(index + 1), rowNumber, header));
    if (values.every((value) => value === "")) continue;
    rows.push({
      rowNumber,
      employeeCode: String(values[0] || "").trim(),
      fullLegalName: String(values[1] || "").trim(),
      joiningDate: isoDate(values[2]),
      siteCode: String(values[3] || "").trim(),
      department: optionalText(values[4], 150),
      position: optionalText(values[5], 150),
      employmentType: optionalText(values[6], 100),
      cnic: optionalText(values[7], 20),
      mobile: optionalText(values[8], 30),
      personalEmail: optionalText(values[9], 255)?.toLowerCase() || null,
    });
  }
  if (rows.length === 0) throw new ValidationError("The workbook contains no employee rows.");
  return rows;
}

async function referenceMaps() {
  const [sites, departments, positions, types] = await Promise.all([
    pool.query("SELECT id, code, name FROM sites WHERE is_active = true"),
    pool.query("SELECT id, site_id, name FROM departments WHERE is_active = true"),
    pool.query("SELECT id, site_id, department_id, code, name FROM positions WHERE is_active = true"),
    pool.query("SELECT id, code, name FROM employment_types WHERE is_active = true"),
  ]);
  return {
    sites: new Map(sites.rows.map((row) => [row.code.toLowerCase(), row])),
    departments: new Map(departments.rows.map((row) => [`${row.site_id}:${row.name.toLowerCase()}`, row])),
    positions: new Map(positions.rows.flatMap((row) => [
      [`${row.site_id}:${row.name.toLowerCase()}`, row],
      [`${row.site_id}:${row.code.toLowerCase()}`, row],
    ])),
    types: new Map(types.rows.flatMap((row) => [[row.name.toLowerCase(), row], [row.code.toLowerCase(), row]])),
  };
}

async function validateRows(actor, parsedRows) {
  const refs = await referenceMaps();
  const actorSiteScope = employeeSiteFilter(actor);
  const errors = [];
  const warnings = [];
  const seenCodes = new Set();
  const seenPeople = new Set();
  const seenCnics = new Set();
  const seenMobiles = new Set();
  const seenEmails = new Set();
  const normalized = [];

  for (const row of parsedRows) {
    const rowErrors = [];
    if (!/^[A-Za-z0-9_-]{2,30}$/.test(row.employeeCode)) rowErrors.push("Invalid Employee ID.");
    if (!row.fullLegalName || row.fullLegalName.length > 150) rowErrors.push("Full Legal Name is required (maximum 150 characters).");
    if (!row.joiningDate) rowErrors.push("Joining Date must be a valid YYYY-MM-DD date.");
    if (!row.siteCode) rowErrors.push("Site Code is required.");
    if (row.cnic && row.cnic.length > 20) rowErrors.push("CNIC exceeds 20 characters.");
    if (row.mobile && row.mobile.length > 30) rowErrors.push("Mobile exceeds 30 characters.");
    if (row.personalEmail && row.personalEmail.length > 255) rowErrors.push("Personal Email exceeds 255 characters.");
    if (row.personalEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(row.personalEmail)) rowErrors.push("Personal Email is invalid.");

    const codeKey = row.employeeCode.toLowerCase();
    if (seenCodes.has(codeKey)) rowErrors.push("Duplicate Employee ID within workbook.");
    seenCodes.add(codeKey);

    const site = refs.sites.get(row.siteCode.toLowerCase());
    if (!site) rowErrors.push("Site Code does not identify an active site.");
    if (site && actorSiteScope !== null && site.id !== actorSiteScope) rowErrors.push("Site is outside your Workforce scope.");

    const department = row.department && site ? refs.departments.get(`${site.id}:${row.department.toLowerCase()}`) : null;
    if (row.department && !department) rowErrors.push("Department is invalid for the selected site.");
    const position = row.position && site ? refs.positions.get(`${site.id}:${row.position.toLowerCase()}`) : null;
    if (row.position && !position) rowErrors.push("Position is invalid for the selected site.");
    if (position?.department_id && department && position.department_id !== department.id) {
      rowErrors.push("Position does not belong to the selected department.");
    }
    const employmentType = row.employmentType ? refs.types.get(row.employmentType.toLowerCase()) : null;
    if (row.employmentType && !employmentType) rowErrors.push("Employment Type is invalid.");

    const personKey = `${row.fullLegalName.toLowerCase()}:${site?.id || row.siteCode.toLowerCase()}`;
    if (seenPeople.has(personKey)) warnings.push({ rowNumber: row.rowNumber, message: "Possible duplicate name and site within workbook." });
    seenPeople.add(personKey);
    for (const [value, seen, label] of [
      [row.cnic, seenCnics, "CNIC"],
      [row.mobile, seenMobiles, "mobile number"],
      [row.personalEmail, seenEmails, "personal email"],
    ]) {
      if (!value) continue;
      const duplicateKey = value.toLowerCase();
      if (seen.has(duplicateKey)) warnings.push({ rowNumber: row.rowNumber, message: `Possible duplicate ${label} within workbook.` });
      seen.add(duplicateKey);
    }

    if (rowErrors.length) errors.push({ rowNumber: row.rowNumber, employeeCode: row.employeeCode, errors: rowErrors });
    normalized.push({ ...row, siteId: site?.id, departmentId: department?.id || null, positionId: position?.id || null, employmentTypeId: employmentType?.id || null });
  }

  const codes = normalized.map((row) => row.employeeCode).filter(Boolean);
  const names = normalized.map((row) => row.fullLegalName.toLowerCase()).filter(Boolean);
  const cnics = normalized.map((row) => row.cnic).filter(Boolean);
  const mobiles = normalized.map((row) => row.mobile).filter(Boolean);
  const emails = normalized.map((row) => row.personalEmail).filter(Boolean);
  const existing = await pool.query(
    `SELECT e.employee_code, e.full_legal_name, e.primary_site_id, pd.cnic, pd.mobile, pd.personal_email
     FROM employees e LEFT JOIN employee_personal_details pd ON pd.employee_id = e.id
     WHERE LOWER(e.employee_code) = ANY($1::text[])
        OR LOWER(e.full_legal_name) = ANY($2::text[])
        OR (cardinality($3::text[]) > 0 AND pd.cnic = ANY($3::text[]))
        OR (cardinality($4::text[]) > 0 AND pd.mobile = ANY($4::text[]))
        OR (cardinality($5::text[]) > 0 AND LOWER(pd.personal_email) = ANY($5::text[]))`,
    [codes.map((v) => v.toLowerCase()), names, cnics, mobiles, emails],
  );

  for (const row of normalized) {
    const codeMatch = existing.rows.find((record) => record.employee_code.toLowerCase() === row.employeeCode.toLowerCase());
    if (codeMatch) errors.push({ rowNumber: row.rowNumber, employeeCode: row.employeeCode, errors: ["Employee ID already exists."] });
    const possible = existing.rows.some((record) =>
      (record.full_legal_name.toLowerCase() === row.fullLegalName.toLowerCase() && record.primary_site_id === row.siteId)
      || (row.cnic && record.cnic === row.cnic)
      || (row.mobile && record.mobile === row.mobile)
      || (row.personalEmail && record.personal_email?.toLowerCase() === row.personalEmail));
    if (possible && !codeMatch) warnings.push({ rowNumber: row.rowNumber, message: "Possible duplicate employee found in ESDMS." });
  }
  const combinedErrors = new Map();
  for (const item of errors) {
    const existing = combinedErrors.get(item.rowNumber) || { rowNumber: item.rowNumber, employeeCode: item.employeeCode, errors: [] };
    existing.errors.push(...item.errors);
    combinedErrors.set(item.rowNumber, existing);
  }
  return { rows: normalized, errors: [...combinedErrors.values()], warnings };
}

function workbookHash(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function previewToken(actor, buffer) {
  const payload = Buffer.from(JSON.stringify({ actorId: actor.id, hash: workbookHash(buffer), expiresAt: Date.now() + PREVIEW_TTL_MS })).toString("base64url");
  const signature = crypto.createHmac("sha256", config.jwtSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function assertPreviewToken(actor, buffer, token) {
  const [payload, signature] = String(token || "").split(".");
  if (!payload || !signature) throw new ValidationError("Preview confirmation token is required.");
  const expected = crypto.createHmac("sha256", config.jwtSecret).update(payload).digest();
  let supplied;
  try { supplied = Buffer.from(signature, "base64url"); } catch { supplied = Buffer.alloc(0); }
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(supplied, expected)) throw new ValidationError("Preview confirmation token is invalid.");
  let data;
  try { data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")); } catch { throw new ValidationError("Preview confirmation token is invalid."); }
  if (data.actorId !== actor.id || data.hash !== workbookHash(buffer) || !Number.isFinite(data.expiresAt) || data.expiresAt < Date.now()) {
    throw new ValidationError("Preview confirmation token is invalid or expired.");
  }
}

export async function generateImportTemplate(actor) {
  assertImportPermission(actor);
  const scope = employeeSiteFilter(actor);
  const [sites, departments, positions, types] = await Promise.all([
    pool.query("SELECT code, name FROM sites WHERE is_active = true AND ($1::uuid IS NULL OR id = $1) ORDER BY name", [scope]),
    pool.query("SELECT d.name, s.code AS site_code FROM departments d JOIN sites s ON s.id = d.site_id WHERE d.is_active = true AND ($1::uuid IS NULL OR d.site_id = $1) ORDER BY s.code, d.name", [scope]),
    pool.query("SELECT p.code, p.name, s.code AS site_code FROM positions p JOIN sites s ON s.id = p.site_id WHERE p.is_active = true AND ($1::uuid IS NULL OR p.site_id = $1) ORDER BY s.code, p.name", [scope]),
    pool.query("SELECT code, name FROM employment_types WHERE is_active = true ORDER BY name"),
  ]);
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Employees");
  sheet.columns = HEADERS.map((header) => ({ header, width: header === "Full Legal Name" ? 30 : 20 }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  const reference = workbook.addWorksheet("Reference Data");
  reference.columns = [
    { header: "Sites", key: "sites", width: 35 },
    { header: "Departments", key: "departments", width: 35 },
    { header: "Positions", key: "positions", width: 40 },
    { header: "Employment Types", key: "types", width: 30 },
  ];
  const max = Math.max(sites.rowCount, departments.rowCount, positions.rowCount, types.rowCount);
  for (let i = 0; i < max; i += 1) reference.addRow({
    sites: sites.rows[i] ? `${sites.rows[i].code} — ${sites.rows[i].name}` : "",
    departments: departments.rows[i] ? `${departments.rows[i].site_code} — ${departments.rows[i].name}` : "",
    positions: positions.rows[i] ? `${positions.rows[i].site_code} — ${positions.rows[i].code} — ${positions.rows[i].name}` : "",
    types: types.rows[i] ? `${types.rows[i].code} — ${types.rows[i].name}` : "",
  });
  return { buffer: await workbook.xlsx.writeBuffer(), filename: safeExportFilename("Employee_Import_Template", "xlsx") };
}

export async function previewEmployeeImport(actor, buffer) {
  assertImportPermission(actor);
  const validation = await validateRows(actor, await parseWorkbook(buffer));
  return {
    rowCount: validation.rows.length,
    validCount: validation.rows.length - validation.errors.length,
    errors: validation.errors,
    warnings: validation.warnings,
    preview: validation.rows.map((row) => ({
      rowNumber: row.rowNumber,
      employeeCode: sanitizeCell(row.employeeCode),
      fullLegalName: sanitizeCell(row.fullLegalName),
      joiningDate: row.joiningDate,
      siteCode: row.siteCode,
      department: row.department,
      position: row.position,
      employmentType: row.employmentType,
    })),
    confirmationToken: validation.errors.length === 0 ? previewToken(actor, buffer) : null,
  };
}

export async function confirmEmployeeImport(actor, buffer, confirmationToken, confirmWarnings) {
  assertImportPermission(actor);
  assertPreviewToken(actor, buffer, confirmationToken);
  const validation = await validateRows(actor, await parseWorkbook(buffer));
  if (validation.errors.length) throw new ValidationError("The workbook contains errors and was not imported.", { errors: validation.errors });
  if (validation.warnings.length && confirmWarnings !== "true") {
    throw new ValidationError("Possible duplicates require explicit warning confirmation.", { warnings: validation.warnings });
  }

  const imported = await withTransaction(async (client) => {
    const created = [];
    for (const row of validation.rows) {
      const employee = await client.query(
        `INSERT INTO employees (employee_code, full_legal_name, primary_site_id, joining_date, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5) RETURNING id, employee_code`,
        [row.employeeCode, row.fullLegalName, row.siteId, row.joiningDate, actor.id],
      );
      const employeeId = employee.rows[0].id;
      if (row.cnic || row.mobile || row.personalEmail) {
        await client.query(
          `INSERT INTO employee_personal_details (employee_id, cnic, mobile, personal_email) VALUES ($1, $2, $3, $4)`,
          [employeeId, row.cnic, row.mobile, row.personalEmail],
        );
      }
      await client.query(
        `INSERT INTO employment_assignments
           (employee_id, site_id, department_id, position_id, employment_type_id, effective_date, reason, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6, 'Bulk employee import', $7)`,
        [employeeId, row.siteId, row.departmentId, row.positionId, row.employmentTypeId, row.joiningDate, actor.id],
      );
      await client.query(
        `INSERT INTO employee_business_history (employee_id, event_type, summary, actor_user_id)
         VALUES ($1, 'EMPLOYEE_CREATED', $2::jsonb, $3)`,
        [employeeId, JSON.stringify({ employeeCode: row.employeeCode, siteId: row.siteId, source: "XLSX_IMPORT" }), actor.id],
      );
      created.push({ rowNumber: row.rowNumber, employeeId, employeeCode: row.employeeCode });
    }
    await recordGovernanceAudit(client, {
      actorUserId: actor.id,
      action: "WORKFORCE_BULK_IMPORT_COMPLETED",
      metadata: { employeeCount: created.length, siteIds: [...new Set(validation.rows.map((row) => row.siteId))] },
    });
    return created;
  });
  return { importedCount: imported.length, imported, warningsAccepted: validation.warnings.length };
}
