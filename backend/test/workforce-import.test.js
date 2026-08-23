import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import ExcelJS from "exceljs";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let users;
let hrToken;
let employeeToken;

const HEADERS = ["Employee ID", "Full Legal Name", "Joining Date", "Site Code", "Department", "Position", "Employment Type", "CNIC", "Mobile", "Personal Email"];
function unique(label) { return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`; }

async function workbookForm(rows, mutate) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Employees");
  sheet.addRow(HEADERS);
  for (const row of rows) sheet.addRow(row);
  if (mutate) mutate(sheet);
  const buffer = await workbook.xlsx.writeBuffer();
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "employees.xlsx");
  return { form, buffer };
}

function formWithConfirmation(buffer, token, confirmWarnings = true) {
  const form = new FormData();
  form.append("file", new Blob([buffer], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }), "employees.xlsx");
  form.append("confirmationToken", token);
  form.append("confirmWarnings", String(confirmWarnings));
  return form;
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
  employeeToken = await authHeader(server.baseUrl, "employee@test.eset.local");
});

after(async () => { await server.close(); await pool.end(); });

test("only an authorized HR/CEO actor can download the import template", async () => {
  const denied = await fetch(`${server.baseUrl}/api/v1/employees/import/template.xlsx`, { headers: { Cookie: employeeToken, Origin: "http://localhost:5173" } });
  assert.equal(denied.status, 403);
  const allowed = await fetch(`${server.baseUrl}/api/v1/employees/import/template.xlsx`, { headers: { Cookie: hrToken, Origin: "http://localhost:5173" } });
  assert.equal(allowed.status, 200);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await allowed.arrayBuffer()));
  assert.deepEqual(HEADERS, workbook.getWorksheet("Employees").getRow(1).values.slice(1));
});

test("preview rejects formulas and altered headers before any mutation", async () => {
  const code = unique("IMP");
  const formula = await workbookForm([[code, "", "2026-01-01", "MAIN", "", "", "", "", "", ""]], (sheet) => {
    sheet.getRow(2).getCell(2).value = { formula: 'HYPERLINK("https://example.invalid")', result: "Employee" };
  });
  const formulaResponse = await apiRequest(server.baseUrl, "POST", "/api/v1/employees/import/preview", { token: hrToken, body: formula.form, isForm: true });
  assert.equal(formulaResponse.status, 400);

  const altered = await workbookForm([[code, "Employee", "2026-01-01", "MAIN", "", "", "", "", "", ""]], (sheet) => { sheet.getRow(1).getCell(10).value = "Salary"; });
  const alteredResponse = await apiRequest(server.baseUrl, "POST", "/api/v1/employees/import/preview", { token: hrToken, body: altered.form, isForm: true });
  assert.equal(alteredResponse.status, 400);

  const extraColumn = await workbookForm([[code, "Employee", "2026-01-01", "MAIN", "", "", "", "", "", ""]], (sheet) => {
    sheet.getRow(1).getCell(11).value = "Compensation";
    sheet.getRow(2).getCell(11).value = "100000";
  });
  const extraColumnResponse = await apiRequest(server.baseUrl, "POST", "/api/v1/employees/import/preview", { token: hrToken, body: extraColumn.form, isForm: true });
  assert.equal(extraColumnResponse.status, 400, "extra columns outside the exact server template must be rejected");

  const duplicateContact = await workbookForm([
    [unique("IMP"), "First Duplicate Contact", "2026-01-01", "MAIN", "", "", "", "", "0300-duplicate", ""],
    [unique("IMP"), "Second Duplicate Contact", "2026-01-01", "MAIN", "", "", "", "", "0300-duplicate", ""],
  ]);
  const duplicateContactResponse = await apiRequest(server.baseUrl, "POST", "/api/v1/employees/import/preview", { token: hrToken, body: duplicateContact.form, isForm: true });
  assert.equal(duplicateContactResponse.status, 200);
  assert.ok(duplicateContactResponse.body.data.warnings.some((warning) => warning.message.includes("mobile number")));
  assert.equal((await pool.query("SELECT 1 FROM employees WHERE employee_code=$1", [code])).rowCount, 0);
});

test("preview plus exact-workbook confirmation imports employees transactionally and audits the result", async () => {
  const codeA = unique("IMP");
  const codeB = unique("IMP");
  const { form, buffer } = await workbookForm([
    [codeA, "=Literal Name", "2026-01-02", "MAIN", "", "", "", "", "0300-1111111", ""],
    [codeB, "Second Imported Employee", "2026-01-03", "MAIN", "", "", "", "", "", ""],
  ]);
  const preview = await apiRequest(server.baseUrl, "POST", "/api/v1/employees/import/preview", { token: hrToken, body: form, isForm: true });
  assert.equal(preview.status, 200, JSON.stringify(preview.body));
  assert.equal(preview.body.data.errors.length, 0);
  assert.ok(preview.body.data.confirmationToken);

  const confirmed = await apiRequest(server.baseUrl, "POST", "/api/v1/employees/import/confirm", {
    token: hrToken,
    body: formWithConfirmation(buffer, preview.body.data.confirmationToken),
    isForm: true,
  });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.body));
  assert.equal(confirmed.body.data.importedCount, 2);
  const records = await pool.query("SELECT employee_code, full_legal_name FROM employees WHERE employee_code=ANY($1::text[])", [[codeA, codeB]]);
  assert.equal(records.rowCount, 2);
  assert.equal(records.rows.find((row) => row.employee_code === codeA).full_legal_name, "=Literal Name", "plain formula-like text is stored as text and sanitized only on export");
  const audit = await pool.query("SELECT metadata FROM governance_audit_log WHERE action='WORKFORCE_BULK_IMPORT_COMPLETED' ORDER BY created_at DESC LIMIT 1");
  assert.equal(audit.rows[0].metadata.employeeCount, 2);
});

test("confirmation is bound to the actor and exact workbook", async () => {
  const first = await workbookForm([[unique("IMP"), "Bound Employee", "2026-01-02", "MAIN", "", "", "", "", "", ""]]);
  const preview = await apiRequest(server.baseUrl, "POST", "/api/v1/employees/import/preview", { token: hrToken, body: first.form, isForm: true });
  const changed = await workbookForm([[unique("IMP"), "Changed Employee", "2026-01-02", "MAIN", "", "", "", "", "", ""]]);
  const rejected = await apiRequest(server.baseUrl, "POST", "/api/v1/employees/import/confirm", {
    token: hrToken, body: formWithConfirmation(changed.buffer, preview.body.data.confirmationToken), isForm: true,
  });
  assert.equal(rejected.status, 400);
});
