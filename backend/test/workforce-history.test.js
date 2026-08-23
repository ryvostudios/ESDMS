import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers, TEST_PASSWORD } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let hrToken;
let ceoToken;
let employeeId;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

before(async () => {
  server = await startTestServer();
  await seedUsers();
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/employees", {
    token: hrToken,
    body: { employeeCode: unique("EMP"), fullLegalName: unique("History Employee"), joiningDate: "2026-01-01" },
  });
  employeeId = created.body.data.id;
});

after(async () => {
  await server.close();
  await pool.end();
});

test("business history records EMPLOYEE_CREATED and is visible to HR", async () => {
  const history = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/history`, { token: hrToken });
  assert.equal(history.status, 200);
  assert.ok(history.body.data.some((h) => h.event_type === "EMPLOYEE_CREATED"));
});

test("HR (non-CEO) cannot remove a history entry even with correct password", async () => {
  const history = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/history`, { token: hrToken });
  const entryId = history.body.data[0].id;

  const attempt = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/history/${entryId}/remove`, {
    token: hrToken,
    body: { reason: "test", confirmPassword: TEST_PASSWORD },
  });
  assert.equal(attempt.status, 403);
});

test("CEO removal requires the correct password and a reason, and is itself forensically audited", async () => {
  const history = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/history`, { token: ceoToken });
  const entryId = history.body.data[0].id;

  const wrongPassword = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/history/${entryId}/remove`, {
    token: ceoToken,
    body: { reason: "Incorrect data", confirmPassword: "definitely-wrong-password" },
  });
  assert.equal(wrongPassword.status, 401);

  const noReason = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/history/${entryId}/remove`, {
    token: ceoToken,
    body: { reason: "", confirmPassword: TEST_PASSWORD },
  });
  assert.equal(noReason.status, 400);

  const removed = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/history/${entryId}/remove`, {
    token: ceoToken,
    body: { reason: "Duplicate entry, correcting", confirmPassword: TEST_PASSWORD },
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  const afterRemoval = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/history`, { token: ceoToken });
  assert.ok(!afterRemoval.body.data.some((h) => h.id === entryId), "removed entries are excluded from the normal view");

  const auditRow = await pool.query("SELECT * FROM governance_audit_log WHERE action = 'HISTORY_REMOVED' AND target_employee_id = $1", [
    employeeId,
  ]);
  assert.ok(auditRow.rowCount > 0);

  // The row itself is never deleted — only logically marked removed.
  const rawRow = await pool.query("SELECT is_removed FROM employee_business_history WHERE id = $1", [entryId]);
  assert.equal(rawRow.rows[0].is_removed, true);

  await assert.rejects(pool.query("DELETE FROM employee_business_history WHERE id = $1", [entryId]), /deleted/);
});
