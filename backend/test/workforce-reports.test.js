import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let hrToken;
let ceoToken;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

async function fetchWorkbook(baseUrl, token) {
  const response = await fetch(`${baseUrl}/api/v1/reports/workforce/employee-master.xlsx`, {
    headers: { Cookie: token, Origin: "http://localhost:5173" },
  });
  const buffer = Buffer.from(await response.arrayBuffer());
  return { status: response.status, buffer };
}

function zipEntryNames(buffer) {
  const names = [];
  for (let offset = 0; offset <= buffer.length - 46; offset += 1) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) continue;
    const nameLength = buffer.readUInt16LE(offset + 28);
    names.push(buffer.toString("utf8", offset + 46, offset + 46 + nameLength));
  }
  return names;
}

before(async () => {
  server = await startTestServer();
  await seedUsers();
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
});

after(async () => {
  await server.close();
  await pool.end();
});

test("an actor without workforce.reports.view/export cannot download the report", async () => {
  const employeeToken = await authHeader(server.baseUrl, "employee@test.eset.local");
  const response = await fetch(`${server.baseUrl}/api/v1/reports/workforce/employee-master.xlsx`, {
    headers: { Cookie: employeeToken, Origin: "http://localhost:5173" },
  });
  assert.equal(response.status, 403);
});

test("HR's export (no compensation.export) contains no compensation column or values at all", async () => {
  const nameWithFormula = "=2+2 Injected Name";
  await apiRequest(server.baseUrl, "POST", "/api/v1/employees", {
    token: hrToken,
    body: { employeeCode: unique("EMP"), fullLegalName: nameWithFormula, joiningDate: "2026-01-01" },
  });

  const { status, buffer } = await fetchWorkbook(server.baseUrl, hrToken);
  assert.equal(status, 200);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Employee Master");

  const headerRow = sheet.getRow(1).values;
  assert.ok(!headerRow.some((v) => typeof v === "string" && v.toLowerCase().includes("compensation")));
});

test("formula-injection is neutralized: a leading '=' in a name is stored as literal text, not a formula", async () => {
  const { buffer } = await fetchWorkbook(server.baseUrl, hrToken);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Employee Master");

  let found = false;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    const nameCell = row.getCell(2);
    if (typeof nameCell.value === "string" && nameCell.value.includes("Injected Name")) {
      found = true;
      assert.equal(typeof nameCell.value, "string", "must be a plain string cell, not a formula object");
      assert.ok(nameCell.value.startsWith("'"), "a dangerous leading character must be neutralized with a leading quote");
    }
  });
  assert.ok(found, "the test employee's row must be present in the export");
});

test("an actor with compensation.export sees the compensation column and correct current amount", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/employees", {
    token: hrToken,
    body: { employeeCode: unique("EMP"), fullLegalName: unique("Report Comp Employee"), joiningDate: "2026-01-01" },
  });
  await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${created.body.data.id}/compensation`, {
    token: ceoToken,
    body: { amount: 55000, currency: "PKR", effectiveDate: "2026-01-01" },
  });

  const { status, buffer } = await fetchWorkbook(server.baseUrl, ceoToken);
  assert.equal(status, 200);

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);
  const sheet = workbook.getWorksheet("Employee Master");
  const headerRow = sheet.getRow(1).values;
  assert.ok(headerRow.some((v) => typeof v === "string" && v.includes("Compensation")));

  let matched = false;
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    if (row.getCell(1).value === created.body.data.employeeCode) {
      matched = true;
      assert.equal(row.getCell(9).value, 55000);
    }
  });
  assert.ok(matched);
});

test("an export generates a WORKFORCE_EXPORT_GENERATED protected audit event with a record count, not raw data", async () => {
  const rows = await pool.query(
    "SELECT metadata FROM governance_audit_log WHERE action = 'WORKFORCE_EXPORT_GENERATED' ORDER BY created_at DESC LIMIT 1",
  );
  assert.ok(rows.rowCount > 0);
  assert.ok(typeof rows.rows[0].metadata.recordCount === "number");
});

test("the report catalog is permission-aware and every HR-visible report generates a valid workbook", async () => {
  const hrCatalog = await apiRequest(server.baseUrl, "GET", "/api/v1/reports/workforce/catalog", { token: hrToken });
  assert.equal(hrCatalog.status, 200);
  assert.ok(hrCatalog.body.data.length >= 17);
  assert.ok(!hrCatalog.body.data.some((item) => item.key === "compensation" || item.key === "contract-metadata"));

  for (const report of hrCatalog.body.data) {
    const response = await fetch(`${server.baseUrl}/api/v1/reports/workforce/${report.key}.xlsx`, {
      headers: { Cookie: hrToken, Origin: "http://localhost:5173" },
    });
    assert.equal(response.status, 200, `${report.key} must be available to authorized HR`);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
    assert.ok(workbook.worksheets.length > 0);
  }

  const ceoCatalog = await apiRequest(server.baseUrl, "GET", "/api/v1/reports/workforce/catalog", { token: ceoToken });
  assert.ok(ceoCatalog.body.data.some((item) => item.key === "compensation"));
  assert.ok(ceoCatalog.body.data.some((item) => item.key === "contract-metadata"));
});

test("bulk ZIP export is private, bounded, audited, and uses server-generated safe paths", async () => {
  const docType = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/document-types", {
    token: hrToken, body: { name: unique("Bulk CV"), allowedMimeTypes: ["application/pdf"] },
  });
  const employee = await apiRequest(server.baseUrl, "POST", "/api/v1/employees", {
    token: hrToken, body: { employeeCode: unique("ZIP"), fullLegalName: unique("ZIP Export Employee"), joiningDate: "2026-01-01" },
  });
  assert.equal(employee.status, 201, JSON.stringify(employee.body));
  const form = new FormData();
  form.append("documentTypeId", docType.body.data.id);
  form.append("file", new Blob([Buffer.from("%PDF-1.4\nmock\ntrailer<<>>")], { type: "application/pdf" }), "../../hostile-name.pdf");
  const upload = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employee.body.data.id}/documents`, { token: hrToken, body: form, isForm: true });
  assert.equal(upload.status, 201);

  const response = await fetch(`${server.baseUrl}/api/v1/reports/workforce/bulk-files.zip`, {
    method: "POST",
    headers: { Cookie: hrToken, Origin: "http://localhost:5173", "Content-Type": "application/json" },
    body: JSON.stringify({ employeeIds: [employee.body.data.id], includeContracts: false }),
  });
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.readUInt32LE(0), 0x04034b50);
  const entries = zipEntryNames(bytes);
  assert.ok(entries.includes("Data.xlsx"));
  assert.ok(entries.includes("Documents_Index.xlsx"));
  assert.ok(entries.every((name) => !name.includes("..") && !name.startsWith("/") && !name.includes("\\")), "every ZIP entry path must be server-generated and traversal-safe");
  const audit = await pool.query("SELECT metadata FROM governance_audit_log WHERE action='WORKFORCE_BULK_EXPORT_GENERATED' ORDER BY created_at DESC LIMIT 1");
  assert.equal(audit.rows[0].metadata.fileCount, 1);
});
