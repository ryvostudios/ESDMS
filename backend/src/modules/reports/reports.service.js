import ExcelJS from "exceljs";
import { ZipArchive } from "archiver";
import pool from "../../config/database.js";
import { ForbiddenError, NotFoundError, ServiceUnavailableError, ValidationError } from "../../shared/errors/app-error.js";
import { recordGovernanceAudit } from "../../shared/audit/governance-audit.repository.js";
import { employeeSiteFilter } from "../workforce/workforce.authorization.js";
import { sanitizeCell, safeExportFilename } from "../../shared/reports/excel-safety.js";
import { storageService } from "../../shared/storage/storage-service.js";

const REPORTS = [
  ["employee-master", "Employee Master"],
  ["active-employees", "Active Employees"],
  ["former-employees", "Inactive / Former Employees"],
  ["by-site", "Employees by Site"],
  ["by-department", "Employees by Department"],
  ["by-position", "Employees by Position"],
  ["by-employment-type", "Employees by Employment Type"],
  ["joining-date", "Joining Date"],
  ["assignment-history", "Employment Assignment History"],
  ["profile-completion", "Profile Completion"],
  ["missing-required-data", "Missing Required Data"],
  ["missing-required-documents", "Missing Required Documents", "employee_documents.view"],
  ["expiring-documents", "Expiring Documents", "employee_documents.view"],
  ["rotation-balance", "Rotation Balance", "rotation.view"],
  ["rotation-ledger", "Rotation Ledger / History", "rotation.view"],
  ["leave-history", "Leave Requests / History", "leave.approve"],
  ["compensation", "Compensation Report", "compensation.export"],
  ["contract-metadata", "Contract Metadata Report", "contract.view"],
  ["custom-fields", "Reportable Custom Fields"],
];

function assertReportExport(actor) {
  if (!actor.permissions.has("employees.view") || !actor.permissions.has("workforce.reports.view") || !actor.permissions.has("workforce.export")) {
    throw new ForbiddenError();
  }
}

function resolveReportSite(actor, requestedSiteId) {
  const scope = employeeSiteFilter(actor);
  if (scope !== null && requestedSiteId && requestedSiteId !== scope) throw new ForbiddenError();
  return scope === null ? requestedSiteId || null : scope;
}

export function reportCatalog(actor) {
  return REPORTS.filter(([, , permission]) => !permission || actor.permissions.has(permission)).map(([key, name]) => ({ key, name }));
}

async function fetchEmployeeMasterRows(siteId) {
  const result = await pool.query(
    `SELECT e.employee_code, e.full_legal_name, e.status, e.joining_date,
            s.name AS site_name, d.name AS department_name, p.name AS position_name, et.name AS employment_type_name,
            e.id AS employee_id
     FROM employees e
     JOIN sites s ON s.id = e.primary_site_id
     LEFT JOIN LATERAL (
       SELECT * FROM employment_assignments ea
       WHERE ea.employee_id = e.id AND ea.effective_date <= CURRENT_DATE
       ORDER BY ea.effective_date DESC, ea.created_at DESC LIMIT 1
     ) cur ON true
     LEFT JOIN departments d ON d.id = cur.department_id
     LEFT JOIN positions p ON p.id = cur.position_id
     LEFT JOIN employment_types et ON et.id = cur.employment_type_id
     WHERE ($1::uuid IS NULL OR e.primary_site_id = $1)
     ORDER BY e.full_legal_name`,
    [siteId],
  );
  return result.rows;
}

async function fetchCurrentCompensationByEmployee(employeeIds) {
  if (employeeIds.length === 0) return new Map();
  const result = await pool.query(
    `SELECT DISTINCT ON (employee_id) employee_id, amount, currency
     FROM employee_compensation_records
     WHERE employee_id = ANY($1::uuid[]) AND effective_date <= CURRENT_DATE
     ORDER BY employee_id, effective_date DESC, created_at DESC`,
    [employeeIds],
  );
  return new Map(result.rows.map((row) => [row.employee_id, row]));
}

// Every structured Workforce dataset should be exportable to Excel — this
// is the first, most load-bearing one (Employee Master); others reuse the
// same sanitizeCell/safeExportFilename primitives rather than each
// reinventing formula-injection handling. See docs/DECISIONS.md for what
// is deliberately NOT built yet (a full report-builder UI, most of the
// report catalog listed in the original spec).
export async function generateEmployeeMasterReport(actor) {
  assertReportExport(actor);

  const includeCompensation = actor.permissions.has("compensation.export");
  const siteId = employeeSiteFilter(actor);
  const rows = await fetchEmployeeMasterRows(siteId);

  const compensationByEmployee = includeCompensation
    ? await fetchCurrentCompensationByEmployee(rows.map((r) => r.employee_id))
    : new Map();

  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Employee Master");

  const columns = [
    { header: "Employee ID", key: "employeeCode", width: 16 },
    { header: "Full Legal Name", key: "fullLegalName", width: 30 },
    { header: "Status", key: "status", width: 14 },
    { header: "Site", key: "site", width: 20 },
    { header: "Department", key: "department", width: 20 },
    { header: "Position", key: "position", width: 20 },
    { header: "Employment Type", key: "employmentType", width: 18 },
    { header: "Joining Date", key: "joiningDate", width: 14 },
  ];
  if (includeCompensation) {
    columns.push({ header: "Current Compensation", key: "compensation", width: 20 });
    columns.push({ header: "Currency", key: "currency", width: 10 });
  }
  sheet.columns = columns;
  sheet.getRow(1).font = { bold: true };

  for (const row of rows) {
    const compensation = compensationByEmployee.get(row.employee_id);
    sheet.addRow({
      employeeCode: sanitizeCell(row.employee_code),
      fullLegalName: sanitizeCell(row.full_legal_name),
      status: row.status,
      site: sanitizeCell(row.site_name),
      department: sanitizeCell(row.department_name || ""),
      position: sanitizeCell(row.position_name || ""),
      employmentType: sanitizeCell(row.employment_type_name || ""),
      joiningDate: row.joining_date,
      ...(includeCompensation ? { compensation: compensation ? Number(compensation.amount) : "", currency: compensation?.currency || "" } : {}),
    });
  }

  const buffer = await workbook.xlsx.writeBuffer();

  await recordGovernanceAudit(pool, {
    actorUserId: actor.id,
    action: "WORKFORCE_EXPORT_GENERATED",
    metadata: { reportType: "EMPLOYEE_MASTER", recordCount: rows.length, includedCompensation: includeCompensation },
  });

  return { buffer, filename: safeExportFilename("Employee_Master", "xlsx") };
}

async function employeeRows(siteId, statusClause = "") {
  const result = await pool.query(
    `SELECT e.employee_code AS "Employee ID", e.full_legal_name AS "Full Legal Name", e.status AS "Status",
            e.joining_date AS "Joining Date", s.name AS "Site", d.name AS "Department", p.name AS "Position",
            et.name AS "Employment Type"
     FROM employees e JOIN sites s ON s.id = e.primary_site_id
     LEFT JOIN LATERAL (
       SELECT * FROM employment_assignments a WHERE a.employee_id = e.id AND a.effective_date <= CURRENT_DATE
       ORDER BY a.effective_date DESC, a.created_at DESC LIMIT 1
     ) a ON true
     LEFT JOIN departments d ON d.id = a.department_id LEFT JOIN positions p ON p.id = a.position_id
     LEFT JOIN employment_types et ON et.id = a.employment_type_id
     WHERE ($1::uuid IS NULL OR e.primary_site_id = $1) ${statusClause}
     ORDER BY s.name, d.name NULLS LAST, e.full_legal_name`,
    [siteId],
  );
  return result.rows;
}

async function fetchCatalogRows(actor, key, siteId, filters) {
  if (["employee-master", "by-site", "by-department", "by-position", "by-employment-type"].includes(key)) return employeeRows(siteId);
  if (key === "active-employees") return employeeRows(siteId, "AND e.status = 'ACTIVE'");
  if (key === "former-employees") return employeeRows(siteId, "AND e.status IN ('INACTIVE','RESIGNED','TERMINATED')");
  if (key === "joining-date") {
    const result = await pool.query(
      `SELECT e.employee_code AS "Employee ID", e.full_legal_name AS "Full Legal Name", e.joining_date AS "Joining Date", s.name AS "Site"
       FROM employees e JOIN sites s ON s.id=e.primary_site_id
       WHERE ($1::uuid IS NULL OR e.primary_site_id=$1) AND ($2::date IS NULL OR e.joining_date >= $2)
         AND ($3::date IS NULL OR e.joining_date <= $3) ORDER BY e.joining_date, e.full_legal_name`,
      [siteId, filters.from || null, filters.to || null],
    ); return result.rows;
  }
  if (key === "assignment-history") {
    const result = await pool.query(
      `SELECT e.employee_code AS "Employee ID", e.full_legal_name AS "Full Legal Name", a.effective_date AS "Effective Date",
              s.name AS "Site", d.name AS "Department", p.name AS "Position", et.name AS "Employment Type",
              rm.full_legal_name AS "Reporting Manager", a.reason AS "Reason"
       FROM employment_assignments a JOIN employees e ON e.id=a.employee_id JOIN sites s ON s.id=a.site_id
       LEFT JOIN departments d ON d.id=a.department_id LEFT JOIN positions p ON p.id=a.position_id
       LEFT JOIN employment_types et ON et.id=a.employment_type_id LEFT JOIN employees rm ON rm.id=a.reporting_manager_employee_id
       WHERE ($1::uuid IS NULL OR e.primary_site_id=$1) AND ($2::date IS NULL OR a.effective_date >= $2)
         AND ($3::date IS NULL OR a.effective_date <= $3) ORDER BY e.employee_code, a.effective_date`,
      [siteId, filters.from || null, filters.to || null],
    ); return result.rows;
  }
  if (["profile-completion", "missing-required-data"].includes(key)) {
    const result = await pool.query(
      `SELECT e.employee_code AS "Employee ID", e.full_legal_name AS "Full Legal Name", s.name AS "Site",
              CASE WHEN pd.cnic IS NULL OR btrim(pd.cnic)='' THEN 'Missing' ELSE 'Complete' END AS "CNIC",
              CASE WHEN pd.mobile IS NULL OR btrim(pd.mobile)='' THEN 'Missing' ELSE 'Complete' END AS "Mobile",
              CASE WHEN pd.address IS NULL OR btrim(pd.address)='' THEN 'Missing' ELSE 'Complete' END AS "Address",
              round(100.0 * ((pd.cnic IS NOT NULL AND btrim(pd.cnic)<>'')::int + (pd.mobile IS NOT NULL AND btrim(pd.mobile)<>'')::int + (pd.address IS NOT NULL AND btrim(pd.address)<>'')::int) / 3) AS "Core Completion Percent"
       FROM employees e JOIN sites s ON s.id=e.primary_site_id LEFT JOIN employee_personal_details pd ON pd.employee_id=e.id
       WHERE ($1::uuid IS NULL OR e.primary_site_id=$1)
         ${key === "missing-required-data" ? "AND (pd.cnic IS NULL OR btrim(pd.cnic)='' OR pd.mobile IS NULL OR btrim(pd.mobile)='' OR pd.address IS NULL OR btrim(pd.address)='')" : ""}
       ORDER BY e.full_legal_name`, [siteId]); return result.rows;
  }
  if (key === "missing-required-documents") {
    // ESDMS-007: a hidden document type (not hr_can_view, unless the actor
    // is CEO) must not leak even as a "missing" row — same visibility rule
    // as the ordinary document APIs (documents.service.js).
    const result = await pool.query(
      `SELECT e.employee_code AS "Employee ID", e.full_legal_name AS "Full Legal Name", dt.name AS "Missing Document Type"
       FROM employees e CROSS JOIN employee_document_types dt
       WHERE dt.is_active=true AND dt.is_required=true AND ($1::uuid IS NULL OR e.primary_site_id=$1)
         AND ($2::boolean OR dt.hr_can_view=true)
         AND NOT EXISTS (SELECT 1 FROM employee_documents d WHERE d.employee_id=e.id AND d.document_type_id=dt.id)
       ORDER BY e.employee_code, dt.sort_order, dt.name`, [siteId, actor.role === "CEO"]); return result.rows;
  }
  if (key === "expiring-documents") {
    // ESDMS-007/012: hidden document types are excluded (same visibility
    // rule as the ordinary document APIs), and the latest version per
    // (employee, type) is resolved BEFORE any expiry classification — the
    // subquery carries NO filter at all (not even "expiry_date IS NOT
    // NULL"), so a NULL-expiry latest version is never silently passed
    // over in favor of an older, expired version that happens to have a
    // non-null expiry_date. Mirrors documents.repository.js's listExpiring
    // exactly (deliberately not called directly — different output column
    // shape for the Excel report).
    const result = await pool.query(
      `SELECT e.employee_code AS "Employee ID", e.full_legal_name AS "Full Legal Name",
              dt.name AS "Document Type", d.expiry_date AS "Expiry Date",
              CASE WHEN d.expiry_date < CURRENT_DATE THEN 'Expired' ELSE 'Expiring Soon' END AS "Status",
              d.verification_status AS "Verification Status"
       FROM (
         SELECT DISTINCT ON (employee_id, document_type_id) *
         FROM employee_documents
         ORDER BY employee_id, document_type_id, version DESC
       ) d
       JOIN employees e ON e.id=d.employee_id
       JOIN employee_document_types dt ON dt.id=d.document_type_id
       WHERE d.expiry_date IS NOT NULL
         AND ($1::uuid IS NULL OR e.primary_site_id=$1)
         AND ($3::boolean OR dt.hr_can_view=true)
         AND d.expiry_date <= CURRENT_DATE + $2::int
       ORDER BY d.expiry_date`, [siteId, filters.withinDays, actor.role === "CEO"]); return result.rows;
  }
  if (key === "rotation-balance") {
    const result = await pool.query(
      `SELECT e.employee_code AS "Employee ID", e.full_legal_name AS "Full Legal Name", rp.name AS "Rotation Policy",
              COALESCE(sum(CASE WHEN l.entry_type='CREDIT' THEN l.days WHEN l.entry_type='DEBIT' THEN -l.days ELSE l.days END),0) AS "Balance Days"
       FROM employees e LEFT JOIN LATERAL (SELECT * FROM employment_assignments a WHERE a.employee_id=e.id AND a.effective_date<=CURRENT_DATE ORDER BY a.effective_date DESC LIMIT 1) a ON true
       LEFT JOIN rotation_policies rp ON rp.id=a.rotation_policy_id LEFT JOIN employee_rotation_ledger l ON l.employee_id=e.id
       WHERE ($1::uuid IS NULL OR e.primary_site_id=$1) GROUP BY e.id,rp.name ORDER BY e.full_legal_name`, [siteId]); return result.rows;
  }
  if (key === "rotation-ledger") {
    const result = await pool.query(
      `SELECT e.employee_code AS "Employee ID", e.full_legal_name AS "Full Legal Name", l.effective_date AS "Effective Date",
              l.entry_type AS "Entry Type", l.days AS "Days", l.reason AS "Reason"
       FROM employee_rotation_ledger l JOIN employees e ON e.id=l.employee_id
       WHERE ($1::uuid IS NULL OR e.primary_site_id=$1) AND ($2::date IS NULL OR l.effective_date >= $2)
         AND ($3::date IS NULL OR l.effective_date <= $3) ORDER BY e.employee_code,l.effective_date,l.created_at`,
      [siteId, filters.from || null, filters.to || null]); return result.rows;
  }
  if (key === "leave-history") {
    const result = await pool.query(
      `SELECT e.employee_code AS "Employee ID", e.full_legal_name AS "Full Legal Name", lt.name AS "Leave Type",
              l.start_date AS "Start Date", l.end_date AS "End Date", l.requested_days AS "Days", l.status AS "Status", l.reason AS "Reason", l.decision_remark AS "Decision Remark"
       FROM leave_requests l JOIN employees e ON e.id=l.employee_id JOIN leave_types lt ON lt.id=l.leave_type_id
       WHERE ($1::uuid IS NULL OR e.primary_site_id=$1) AND ($2::date IS NULL OR l.start_date >= $2)
         AND ($3::date IS NULL OR l.end_date <= $3) ORDER BY l.start_date DESC`, [siteId, filters.from || null, filters.to || null]); return result.rows;
  }
  if (key === "compensation") {
    if (!actor.permissions.has("compensation.export")) throw new ForbiddenError();
    const result = await pool.query(
      `SELECT e.employee_code AS "Employee ID", e.full_legal_name AS "Full Legal Name", c.amount AS "Amount", c.currency AS "Currency",
              c.effective_date AS "Effective Date", c.reason AS "Reason"
       FROM employee_compensation_records c JOIN employees e ON e.id=c.employee_id
       WHERE ($1::uuid IS NULL OR e.primary_site_id=$1) AND ($2::date IS NULL OR c.effective_date >= $2)
         AND ($3::date IS NULL OR c.effective_date <= $3) ORDER BY e.employee_code,c.effective_date`, [siteId, filters.from || null, filters.to || null]); return result.rows;
  }
  if (key === "contract-metadata") {
    if (!actor.permissions.has("contract.view")) throw new ForbiddenError();
    const result = await pool.query(
      `SELECT e.employee_code AS "Employee ID", e.full_legal_name AS "Full Legal Name", c.contract_number AS "Contract Number",
              c.kind AS "Kind", c.status AS "Status", c.effective_start_date AS "Effective Start Date", c.effective_end_date AS "Effective End Date",
              c.finalized_at AS "Finalized At"
       FROM employee_contracts c JOIN employees e ON e.id=c.employee_id
       WHERE ($1::uuid IS NULL OR e.primary_site_id=$1) ORDER BY e.employee_code,c.created_at`, [siteId]); return result.rows;
  }
  if (key === "custom-fields") {
    const visibility = actor.role === "CEO" ? "true" : actor.role === "HR" ? "f.hr_can_view" : actor.role === "UPPER_MANAGEMENT" ? "f.management_can_view" : "false";
    const result = await pool.query(
      `SELECT e.employee_code AS "Employee ID", e.full_legal_name AS "Full Legal Name", s.name AS "Section", f.label AS "Field", v.value::text AS "Value"
       FROM employee_custom_field_values v JOIN employees e ON e.id=v.employee_id JOIN employee_custom_fields f ON f.id=v.field_id
       JOIN employee_profile_sections s ON s.id=f.section_id
       WHERE ($1::uuid IS NULL OR e.primary_site_id=$1) AND f.is_active=true AND f.is_reportable=true AND f.is_sensitive=false AND ${visibility}
       ORDER BY e.employee_code,s.sort_order,f.sort_order`, [siteId]); return result.rows;
  }
  throw new NotFoundError("Workforce report not found.");
}

function workbookFromRows(title, rows) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(title.replace(/[\\/*?:[\]]/g, "-").slice(0, 31));
  const keys = rows.length ? Object.keys(rows[0]) : ["Result"];
  sheet.columns = keys.map((key) => ({ header: key, key, width: Math.min(40, Math.max(14, key.length + 2)) }));
  sheet.getRow(1).font = { bold: true };
  sheet.views = [{ state: "frozen", ySplit: 1 }];
  for (const row of rows) sheet.addRow(Object.fromEntries(keys.map((key) => [key, sanitizeCell(row[key])])))
  if (!rows.length) sheet.addRow({ Result: "No matching records" });
  return workbook;
}

export async function generateWorkforceReport(actor, key, filters = {}) {
  assertReportExport(actor);
  const definition = REPORTS.find(([candidate]) => candidate === key);
  const title = definition?.[1];
  if (!title) throw new NotFoundError("Workforce report not found.");
  if (definition[2] && !actor.permissions.has(definition[2])) throw new ForbiddenError();
  const siteId = resolveReportSite(actor, filters.siteId);
  const rows = await fetchCatalogRows(actor, key, siteId, filters);
  const buffer = await workbookFromRows(title, rows).xlsx.writeBuffer();
  await recordGovernanceAudit(pool, {
    actorUserId: actor.id,
    action: "WORKFORCE_EXPORT_GENERATED",
    metadata: { reportType: key.toUpperCase().replaceAll("-", "_"), recordCount: rows.length, siteId },
  });
  return { buffer, filename: safeExportFilename(key.replaceAll("-", "_"), "xlsx") };
}

function safeZipPart(value, fallback) {
  const safe = String(value || "").normalize("NFKC").replace(/[^a-zA-Z0-9._-]/g, "_").replace(/^\.+/, "").slice(0, 80);
  return safe || fallback;
}

function extensionForMime(mime) {
  return { "application/pdf": "pdf", "image/jpeg": "jpg", "image/png": "png", "image/webp": "webp" }[mime] || "bin";
}

export async function streamBulkFileExport(actor, filters, response) {
  if (!actor.permissions.has("employees.view") || !actor.permissions.has("employee_documents.bulk_export") || !actor.permissions.has("workforce.export") || !actor.permissions.has("employee_documents.download")) {
    throw new ForbiddenError();
  }
  const siteId = resolveReportSite(actor, filters.siteId);
  const employeeIds = filters.employeeIds || [];
  const employees = await pool.query(
    `SELECT id, employee_code, full_legal_name, primary_site_id FROM employees
     WHERE ($1::uuid IS NULL OR primary_site_id=$1) AND (cardinality($2::uuid[])=0 OR id=ANY($2::uuid[]))
     ORDER BY employee_code LIMIT 251`, [siteId, employeeIds]);
  if (employees.rows.length > 250) throw new ValidationError("Bulk exports are limited to 250 employees.");
  if (employeeIds.length && employees.rows.length !== new Set(employeeIds).size) throw new NotFoundError("One or more employees are outside your Workforce scope.");
  const ids = employees.rows.map((employee) => employee.id);
  const documents = ids.length ? await pool.query(
    `SELECT DISTINCT ON (d.employee_id,d.document_type_id) d.*,dt.name AS document_type_name
     FROM employee_documents d JOIN employee_document_types dt ON dt.id=d.document_type_id
     WHERE d.employee_id=ANY($1::uuid[]) AND ($2::boolean OR dt.hr_can_view=true)
     ORDER BY d.employee_id,d.document_type_id,d.version DESC`, [ids, actor.role === "CEO"]) : { rows: [] };
  const photos = ids.length ? await pool.query(
    `SELECT p.*, 'Profile photo' AS document_type_name
     FROM employee_personal_details pd JOIN employee_profile_photos p ON p.id=pd.current_photo_id
     WHERE pd.employee_id=ANY($1::uuid[])`, [ids]) : { rows: [] };
  const contracts = filters.includeContracts && actor.permissions.has("contract.view") && actor.permissions.has("contract.download") && ids.length
    ? await pool.query("SELECT * FROM employee_contracts WHERE employee_id=ANY($1::uuid[]) AND status <> 'DRAFT' ORDER BY employee_id,created_at", [ids])
    : { rows: [] };
  const fileRows = [
    ...photos.rows.map((row) => ({ ...row, fileKind: "photo" })),
    ...documents.rows.map((row) => ({ ...row, fileKind: "document" })),
    ...contracts.rows.map((row) => ({ ...row, fileKind: "contract" })),
  ];
  if (fileRows.length > 1000) throw new ValidationError("Bulk exports are limited to 1,000 files.");
  const totalBytes = fileRows.reduce((sum, row) => sum + Number(row.size_bytes || 0), 0);
  if (totalBytes > 500 * 1024 * 1024) throw new ValidationError("Bulk export files exceed the 500 MB safety limit.");

  const employeeById = new Map(employees.rows.map((employee) => [employee.id, employee]));
  const dataRows = await employeeRows(siteId);
  const dataWorkbook = workbookFromRows("Data", dataRows.filter((row) => !employeeIds.length || employees.rows.some((e) => e.employee_code === row["Employee ID"])));
  const indexRows = fileRows.map((row) => ({
    "Employee ID": employeeById.get(row.employee_id)?.employee_code,
    "File Category": row.fileKind === "contract" ? "Contract" : row.fileKind === "photo" ? "Profile photo" : row.document_type_name,
    "Version / Number": row.fileKind === "contract" ? row.contract_number : row.version,
    "MIME Type": row.mime_type,
    "Size Bytes": Number(row.size_bytes),
    "SHA-256": row.checksum_sha256,
  }));
  const indexWorkbook = workbookFromRows("Documents Index", indexRows);

  const filename = safeExportFilename("Workforce_Export", "zip");
  response.set({ "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${filename}"`, "Cache-Control": "private, no-store" });
  const archive = new ZipArchive({ zlib: { level: 6 } });
  archive.on("warning", (error) => { if (error.code !== "ENOENT") response.destroy(error); });
  archive.on("error", (error) => response.destroy(error));
  archive.pipe(response);
  archive.append(Buffer.from(await dataWorkbook.xlsx.writeBuffer()), { name: "Data.xlsx" });
  archive.append(Buffer.from(await indexWorkbook.xlsx.writeBuffer()), { name: "Documents_Index.xlsx" });

  for (const row of fileRows) {
    const employee = employeeById.get(row.employee_id);
    const buffer = await storageService.read(row.storage_key);
    if (!storageService.verifyChecksum(buffer, row.checksum_sha256)) {
      archive.abort();
      throw new ServiceUnavailableError("A stored Workforce file failed its integrity check.");
    }
    const folder = `${safeZipPart(employee.employee_code, "employee")}_${employee.id.slice(0, 8)}`;
    const basename = row.fileKind === "contract"
      ? `contracts/${safeZipPart(row.contract_number, "contract")}`
      : row.fileKind === "photo" ? "profile-photo" : `${safeZipPart(row.document_type_name, "document")}_v${row.version}`;
    archive.append(buffer, { name: `${folder}/${basename}.${extensionForMime(row.mime_type)}` });
  }
  await recordGovernanceAudit(pool, {
    actorUserId: actor.id,
    action: "WORKFORCE_BULK_EXPORT_GENERATED",
    metadata: { employeeCount: employees.rows.length, fileCount: fileRows.length, siteId, includedContracts: contracts.rows.length > 0 },
  });
  await archive.finalize();
}
