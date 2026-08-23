import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let hrToken;
let ceoToken;
let employeeId;
let selfToken;

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
    body: { employeeCode: unique("EMP"), fullLegalName: unique("Rotation Leave Employee"), joiningDate: "2026-01-01" },
  });
  employeeId = created.body.data.id;

  const email = `${unique("rl-self")}@test.eset.local`;
  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email },
  });
  const tempToken = await authHeader(server.baseUrl, email, login.body.data.temporaryPassword);
  await apiRequest(server.baseUrl, "POST", "/api/v1/auth/change-password", {
    token: tempToken,
    body: { currentPassword: login.body.data.temporaryPassword, newPassword: "Rl-Self-Pw-123" },
  });
  selfToken = await authHeader(server.baseUrl, email, "Rl-Self-Pw-123");
});

after(async () => {
  await server.close();
  await pool.end();
});

test("HR creates the default 22/8 rotation policy and assigns it via a transfer", async () => {
  const policy = await apiRequest(server.baseUrl, "POST", "/api/v1/rotation-policies", {
    token: hrToken,
    body: { name: unique("22/8"), workDays: 22, offDays: 8 },
  });
  assert.equal(policy.status, 201, JSON.stringify(policy.body));

  const transfer = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/transfer`, {
    token: hrToken,
    body: { rotationPolicyId: policy.body.data.id, effectiveDate: "2026-01-01" },
  });
  assert.equal(transfer.status, 201, JSON.stringify(transfer.body));

  const status = await apiRequest(server.baseUrl, "GET", "/api/v1/me/rotation", { token: selfToken });
  assert.equal(status.status, 200);
  assert.equal(status.body.data.policy.work_days, 22);
});

test("a manual rotation adjustment requires rotation.adjust and accumulates in the ledger (no auto-expiry)", async () => {
  const denied = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/rotation`, {
    token: await authHeader(server.baseUrl, "employee@test.eset.local"),
  });
  assert.equal(denied.status, 403);

  const adjust1 = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/rotation/adjust`, {
    token: hrToken,
    body: { days: 8, reason: "Off-days earned", effectiveDate: "2026-08-01" },
  });
  assert.equal(adjust1.status, 201, JSON.stringify(adjust1.body));

  const adjust2 = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/rotation/adjust`, {
    token: hrToken,
    body: { days: 4, reason: "More off-days, unused ones accumulate", effectiveDate: "2026-08-05" },
  });
  assert.equal(adjust2.status, 201);

  const status = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/rotation`, { token: hrToken });
  assert.equal(status.body.data.balance, 12, "accumulated, not reset/expired");
  assert.equal(status.body.data.ledger.length, 2);
});

test("leave: employee submits, cannot decide their own request, HR/CEO approves through an explicit transition", async () => {
  const type = await apiRequest(server.baseUrl, "POST", "/api/v1/leave-types", {
    token: hrToken,
    body: { name: unique("Annual Leave") },
  });
  assert.equal(type.status, 201);

  const submitted = await apiRequest(server.baseUrl, "POST", "/api/v1/me/leave", {
    token: selfToken,
    body: { leaveTypeId: type.body.data.id, startDate: "2026-09-01", endDate: "2026-09-03", requestedDays: 3 },
  });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  const requestId = submitted.body.data.id;

  const invalidRange = await apiRequest(server.baseUrl, "POST", "/api/v1/me/leave", {
    token: selfToken,
    body: { leaveTypeId: type.body.data.id, startDate: "2026-09-01", endDate: "2026-09-02", requestedDays: 10 },
  });
  assert.equal(invalidRange.status, 400, "requestedDays cannot exceed the date span");

  const pending = await apiRequest(server.baseUrl, "GET", "/api/v1/leave/pending", { token: hrToken });
  assert.ok(pending.body.data.some((r) => r.id === requestId));

  const decide = await apiRequest(server.baseUrl, "POST", `/api/v1/leave/${requestId}/decide`, {
    token: hrToken,
    body: { status: "APPROVED", remark: "Approved" },
  });
  assert.equal(decide.status, 200, JSON.stringify(decide.body));

  const doubleDecide = await apiRequest(server.baseUrl, "POST", `/api/v1/leave/${requestId}/decide`, {
    token: hrToken,
    body: { status: "REJECTED" },
  });
  assert.equal(doubleDecide.status, 409, "an already-decided request cannot be re-decided");

  const myLeave = await apiRequest(server.baseUrl, "GET", "/api/v1/me/leave", { token: selfToken });
  assert.equal(myLeave.body.data.find((r) => r.id === requestId).status, "APPROVED");

  const notifications = await apiRequest(server.baseUrl, "GET", "/api/v1/notifications", { token: selfToken });
  assert.ok(
    notifications.body.data.some((n) => n.eventType === "LEAVE_APPROVED" && n.entityId === requestId),
    "the leave decision reuses the existing notification outbox and is visible via the existing endpoint",
  );
});

test("an actor with leave.approve still cannot decide their own leave request", async () => {
  const type = await apiRequest(server.baseUrl, "GET", "/api/v1/leave-types", { token: hrToken });
  const leaveTypeId = type.body.data[0].id;

  const submitted = await apiRequest(server.baseUrl, "POST", "/api/v1/me/leave", {
    token: selfToken,
    body: { leaveTypeId, startDate: "2026-10-01", endDate: "2026-10-01", requestedDays: 1 },
  });
  const requestId = submitted.body.data.id;

  const userRow = await pool.query("SELECT user_id FROM employees WHERE id = $1", [employeeId]);
  const selfUserId = userRow.rows[0].user_id;

  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${selfUserId}/permissions/leave.approve`, {
    token: ceoToken,
    body: { effect: "GRANT" },
  });

  try {
    const selfDecide = await apiRequest(server.baseUrl, "POST", `/api/v1/leave/${requestId}/decide`, {
      token: selfToken,
      body: { status: "APPROVED" },
    });
    assert.equal(selfDecide.status, 403, "leave.approve does not let an actor approve their own request");
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${selfUserId}/permissions/leave.approve`, {
      token: ceoToken,
    });
  }
});
