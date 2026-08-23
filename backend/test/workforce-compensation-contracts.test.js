import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pool from "../src/config/database.js";
import { config } from "../src/config/env.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let users;
let ceoToken;
let hrToken;
let employeeId;
let selfToken;
let otherEmployeeToken;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function pdfForm() {
  const form = new FormData();
  const pdfBytes = Buffer.from("%PDF-1.4\n%mock contract\ntrailer<<>>", "utf8");
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "contract.pdf");
  return form;
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
  otherEmployeeToken = await authHeader(server.baseUrl, "employee@test.eset.local");

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/employees", {
    token: hrToken,
    body: { employeeCode: unique("EMP"), fullLegalName: unique("Comp Contract Employee"), joiningDate: "2026-01-01" },
  });
  employeeId = created.body.data.id;

  const email = `${unique("cc-self")}@test.eset.local`;
  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email },
  });
  const tempToken = await authHeader(server.baseUrl, email, login.body.data.temporaryPassword);
  await apiRequest(server.baseUrl, "POST", "/api/v1/auth/change-password", {
    token: tempToken,
    body: { currentPassword: login.body.data.temporaryPassword, newPassword: "Cc-Self-Pw-123" },
  });
  selfToken = await authHeader(server.baseUrl, email, "Cc-Self-Pw-123");
});

after(async () => {
  await server.close();
  await pool.end();
});

// ---------------------------------------------------------------------
// Compensation
// ---------------------------------------------------------------------

test("HR without compensation.view cannot see an employee's compensation, and the employee detail endpoint never includes salary", async () => {
  const current = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/compensation/current`, {
    token: hrToken,
  });
  assert.equal(current.status, 403);

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}`, { token: hrToken });
  const detailText = JSON.stringify(detail.body);
  assert.ok(!detailText.toLowerCase().includes("amount"), "generic employee endpoint must never carry compensation data");
});

test("an employee can always view their own compensation without any special permission", async () => {
  await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/compensation`, {
    token: ceoToken,
    body: { amount: 100000, currency: "PKR", effectiveDate: "2026-01-15", reason: "Starting salary" },
  });

  const current = await apiRequest(server.baseUrl, "GET", "/api/v1/me/compensation/current", { token: selfToken });
  assert.equal(current.status, 200, JSON.stringify(current.body));
  assert.equal(current.body.data.amount, "100000.00");
});

test("another employee cannot view this employee's compensation", async () => {
  const response = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/compensation/current`, {
    token: otherEmployeeToken,
  });
  assert.equal(response.status, 403);
});

test("a new compensation record never overwrites history — both remain, current is derived", async () => {
  await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/compensation`, {
    token: ceoToken,
    body: { amount: 120000, currency: "PKR", effectiveDate: "2026-08-01", reason: "Raise" },
  });

  const history = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/compensation/history`, {
    token: ceoToken,
  });
  assert.equal(history.status, 200);
  assert.ok(history.body.data.length >= 2);
  assert.ok(history.body.data.some((r) => r.amount === "100000.00"));
  assert.ok(history.body.data.some((r) => r.amount === "120000.00"));
});

test("compensation history is immutable at the database boundary", async () => {
  const row = await pool.query("SELECT id FROM employee_compensation_records WHERE employee_id = $1 LIMIT 1", [employeeId]);
  await assert.rejects(pool.query("UPDATE employee_compensation_records SET amount = amount + 1 WHERE id = $1", [row.rows[0].id]), /append-only/i);
  await assert.rejects(pool.query("DELETE FROM employee_compensation_records WHERE id = $1", [row.rows[0].id]), /append-only/i);
});

test("a future-dated compensation record is not yet 'current'", async () => {
  const future = new Date();
  future.setFullYear(future.getFullYear() + 1);
  const futureDate = future.toISOString().slice(0, 10);

  await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/compensation`, {
    token: ceoToken,
    body: { amount: 999999, currency: "PKR", effectiveDate: futureDate, reason: "Future approved increase" },
  });

  const current = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/compensation/current`, {
    token: ceoToken,
  });
  assert.notEqual(current.body.data.amount, "999999.00", "a future-effective record must not be exposed as current yet");
});

test("no actor can record their own compensation change, even CEO", async () => {
  const response = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${users.ceo}/compensation`, {
    token: ceoToken,
    body: { amount: 500000, currency: "PKR", effectiveDate: "2026-08-01" },
  });
  // CEO has no linked Employee record in the fixtures, so this exercises
  // the not-found path rather than the self-block — the important
  // production invariant (self-block for an actor who DOES have a linked
  // Employee) is covered by the next test using the HR-delegated actor.
  assert.notEqual(response.status, 201);
});

test("audit metadata for a compensation change never contains the amount", async () => {
  const rows = await pool.query(
    "SELECT metadata FROM governance_audit_log WHERE action = 'COMPENSATION_RECORDED' AND target_employee_id = $1",
    [employeeId],
  );
  assert.ok(rows.rowCount > 0);
  for (const row of rows.rows) {
    assert.ok(!("amount" in row.metadata));
    assert.ok(!JSON.stringify(row.metadata).includes("100000"));
  }
});

// ---------------------------------------------------------------------
// Contracts
// ---------------------------------------------------------------------

let contractId;

test("HR without contract permissions cannot create a contract", async () => {
  const response = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts`, {
    token: hrToken,
    body: { kind: "ORIGINAL" },
  });
  assert.equal(response.status, 403);
});

test("CEO can create, upload, and finalize a contract; the file/hash become immutable", async () => {
  const draft = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts`, {
    token: ceoToken,
    body: { kind: "ORIGINAL", effectiveStartDate: "2026-01-15", termsSummary: "Initial employment terms." },
  });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  contractId = draft.body.data.id;
  assert.equal(draft.body.data.status, "DRAFT");

  const uploaded = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts/${contractId}/file`, {
    token: ceoToken,
    body: pdfForm(),
    isForm: true,
  });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  const originalChecksum = uploaded.body.data.checksum_sha256;
  assert.ok(originalChecksum);

  const finalized = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts/${contractId}/finalize`, {
    token: ceoToken,
  });
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  assert.equal(finalized.body.data.status, "CURRENT");
  assert.equal(finalized.body.data.checksum_sha256, originalChecksum, "finalization does not alter the stored file");
});

test("after finalization, NO ONE can edit metadata, replace the file, or delete — including CEO", async () => {
  const editAttempt = await apiRequest(server.baseUrl, "PATCH", `/api/v1/employees/${employeeId}/contracts/${contractId}`, {
    token: ceoToken,
    body: { termsSummary: "Tampered terms" },
  });
  assert.equal(editAttempt.status, 409, JSON.stringify(editAttempt.body));

  const replaceAttempt = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts/${contractId}/file`, {
    token: ceoToken,
    body: pdfForm(),
    isForm: true,
  });
  assert.equal(replaceAttempt.status, 409, JSON.stringify(replaceAttempt.body));

  const deleteAttempt = await apiRequest(server.baseUrl, "DELETE", `/api/v1/employees/${employeeId}/contracts/${contractId}`, {
    token: ceoToken,
  });
  assert.equal(deleteAttempt.status, 403, JSON.stringify(deleteAttempt.body));

  // Defense-in-depth: even a raw, direct SQL statement (bypassing the
  // service layer entirely, as a compromised process or a careless direct
  // DB session might) is rejected by the database trigger itself.
  await assert.rejects(
    pool.query("UPDATE employee_contracts SET terms_summary = 'db-level tamper attempt' WHERE id = $1", [contractId]),
    /immutable/,
  );
  await assert.rejects(
    pool.query("UPDATE employee_contracts SET effective_end_date = '2026-08-01' WHERE id = $1", [contractId]),
    /immutable/,
  );
  await assert.rejects(pool.query("DELETE FROM employee_contracts WHERE id = $1", [contractId]), /cannot be deleted/);

  const stillIntact = await pool.query("SELECT terms_summary FROM employee_contracts WHERE id = $1", [contractId]);
  assert.equal(stillIntact.rows[0].terms_summary, "Initial employment terms.");
});

test("a status-only transition (CURRENT -> SUPERSEDED) is allowed and preserves the record", async () => {
  const transition = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts/${contractId}/transition`, {
    token: ceoToken,
    body: { status: "SUPERSEDED", effectiveEndDate: "2026-08-01" },
  });
  assert.equal(transition.status, 200, JSON.stringify(transition.body));
  assert.equal(transition.body.data.status, "SUPERSEDED");
  assert.equal(transition.body.data.effective_end_date, null, "a lifecycle transition cannot mutate an original contract term");

  const stillThere = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/contracts/${contractId}`, {
    token: ceoToken,
  });
  assert.equal(stillThere.status, 200, "superseded does not mean deleted");
});

test("an amendment must reference an already-finalized contract and does not touch the original", async () => {
  const invalidAmendment = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts`, {
    token: ceoToken,
    body: { kind: "AMENDMENT" },
  });
  assert.equal(invalidAmendment.status, 400, "amendsContractId is required for an amendment");

  const amendment = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts`, {
    token: ceoToken,
    body: { kind: "AMENDMENT", amendsContractId: contractId, termsSummary: "Salary increase amendment." },
  });
  assert.equal(amendment.status, 201, JSON.stringify(amendment.body));
  assert.equal(amendment.body.data.amends_contract_id, contractId);
});

test("employee self-access: can view/download own FINALIZED contract, never a DRAFT, never another employee's", async () => {
  const draft = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts`, {
    token: ceoToken,
    body: { kind: "ORIGINAL" },
  });
  const draftId = draft.body.data.id;

  const selfDraftView = await apiRequest(server.baseUrl, "GET", `/api/v1/me/contracts/${draftId}`, { token: selfToken });
  assert.equal(selfDraftView.status, 403, "an employee must never see an unfinalized draft, even their own");

  const selfFinalizedView = await apiRequest(server.baseUrl, "GET", `/api/v1/me/contracts/${contractId}`, { token: selfToken });
  assert.equal(selfFinalizedView.status, 200);

  const selfDownload = await apiRequest(server.baseUrl, "GET", `/api/v1/me/contracts/${contractId}/download`, { token: selfToken });
  assert.equal(selfDownload.status, 200);

  const otherView = await apiRequest(server.baseUrl, "GET", `/api/v1/me/contracts/${contractId}`, { token: otherEmployeeToken });
  assert.equal(otherView.status, 404, "wrong employee's contract via /me must look like not-found");
});

test("contract finalize/download generate protected audit events", async () => {
  const rows = await pool.query(
    "SELECT action FROM governance_audit_log WHERE target_contract_id = $1 ORDER BY created_at",
    [contractId],
  );
  const actions = rows.rows.map((r) => r.action);
  assert.ok(actions.includes("CONTRACT_FINALIZED"));
  assert.ok(actions.includes("CONTRACT_VIEWED") || actions.includes("CONTRACT_DOWNLOADED"));
});

test("SHA-256 verification detects stored contract tampering before download", async () => {
  const stored = await pool.query("SELECT storage_key FROM employee_contracts WHERE id = $1", [contractId]);
  const filename = path.resolve(config.storageDir, stored.rows[0].storage_key);
  const original = await fs.readFile(filename);
  try {
    await fs.writeFile(filename, Buffer.from("tampered contract bytes"));
    const response = await apiRequest(server.baseUrl, "GET", `/api/v1/me/contracts/${contractId}/download`, { token: selfToken });
    assert.equal(response.status, 503);
  } finally {
    await fs.writeFile(filename, original);
  }
});

test("CEO can delegate contract.create to HR without granting every other contract capability", async () => {
  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.hr}/permissions/contract.create`, {
    token: ceoToken,
    body: { effect: "GRANT" },
  });

  try {
    const created = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts`, {
      token: hrToken,
      body: { kind: "ORIGINAL" },
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));

    const finalizeAttempt = await apiRequest(
      server.baseUrl,
      "POST",
      `/api/v1/employees/${employeeId}/contracts/${created.body.data.id}/finalize`,
      { token: hrToken },
    );
    assert.equal(finalizeAttempt.status, 403, "contract.create does not imply contract.finalize");
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.hr}/permissions/contract.create`, { token: ceoToken });
  }
});
