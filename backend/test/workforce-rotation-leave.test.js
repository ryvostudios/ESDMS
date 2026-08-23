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

test("ESDMS-003: an explicit DENY on leave.self.view blocks a self leave read even though identity matches", async () => {
  const userRow = await pool.query("SELECT user_id FROM employees WHERE id = $1", [employeeId]);
  const selfUserId = userRow.rows[0].user_id;

  const before = await apiRequest(server.baseUrl, "GET", "/api/v1/me/leave", { token: selfToken });
  assert.equal(before.status, 200, "self can read their own leave by default");

  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${selfUserId}/permissions/leave.self.view`, {
    token: ceoToken,
    body: { effect: "DENY" },
  });

  try {
    const denied = await apiRequest(server.baseUrl, "GET", "/api/v1/me/leave", { token: selfToken });
    assert.equal(denied.status, 403, "identity (isSelf) alone must not bypass an explicit DENY on leave.self.view");

    // The management path is a separate grant of access to OTHER
    // employees' leave — it must not be usable to route around a
    // self-view denial for one's own record.
    const grantManage = await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${selfUserId}/permissions/leave.manage`, {
      token: ceoToken,
      body: { effect: "GRANT" },
    });
    assert.equal(grantManage.status, 200);
    try {
      const stillDenied = await apiRequest(server.baseUrl, "GET", "/api/v1/me/leave", { token: selfToken });
      assert.equal(stillDenied.status, 403, "leave.manage does not route around a self.view denial for one's own record");
    } finally {
      await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${selfUserId}/permissions/leave.manage`, {
        token: ceoToken,
      });
    }
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${selfUserId}/permissions/leave.self.view`, {
      token: ceoToken,
    });
  }

  const after = await apiRequest(server.baseUrl, "GET", "/api/v1/me/leave", { token: selfToken });
  assert.equal(after.status, 200, "removing the override restores the role default");
});

async function submitSelfLeave(token, dateOverride) {
  const type = await apiRequest(server.baseUrl, "GET", "/api/v1/leave-types", { token: hrToken });
  const leaveTypeId = type.body.data[0].id;
  const date = dateOverride || `2026-11-${String(1 + Math.floor(Math.random() * 27)).padStart(2, "0")}`;

  const submitted = await apiRequest(server.baseUrl, "POST", "/api/v1/me/leave", {
    token,
    body: { leaveTypeId, startDate: date, endDate: date, requestedDays: 1 },
  });
  assert.equal(submitted.status, 201, JSON.stringify(submitted.body));
  return submitted.body.data.id;
}

async function selfUserIdFor(empId) {
  const userRow = await pool.query("SELECT user_id FROM employees WHERE id = $1", [empId]);
  return userRow.rows[0].user_id;
}

test("leave.self.create without leave.self.cancel: can submit a new request but cannot cancel their own", async () => {
  const selfUserId = await selfUserIdFor(employeeId);
  const requestId = await submitSelfLeave(selfToken);

  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${selfUserId}/permissions/leave.self.cancel`, {
    token: ceoToken,
    body: { effect: "DENY" },
  });

  try {
    const cancelled = await apiRequest(server.baseUrl, "POST", `/api/v1/me/leave/${requestId}/cancel`, {
      token: selfToken,
    });
    assert.equal(cancelled.status, 403, "leave.self.create alone no longer authorizes cancellation");

    const resubmitted = await submitSelfLeave(selfToken);
    assert.ok(resubmitted, "leave.self.create independently still authorizes submitting a new request");
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${selfUserId}/permissions/leave.self.cancel`, {
      token: ceoToken,
    });
  }

  const cancelledAfterRestore = await apiRequest(server.baseUrl, "POST", `/api/v1/me/leave/${requestId}/cancel`, {
    token: selfToken,
  });
  assert.equal(cancelledAfterRestore.status, 200, JSON.stringify(cancelledAfterRestore.body));
});

test("leave.self.cancel without leave.self.create: can cancel an otherwise-cancellable own request but cannot submit a new one", async () => {
  const selfUserId = await selfUserIdFor(employeeId);
  const requestId = await submitSelfLeave(selfToken);

  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${selfUserId}/permissions/leave.self.create`, {
    token: ceoToken,
    body: { effect: "DENY" },
  });

  try {
    const type = await apiRequest(server.baseUrl, "GET", "/api/v1/leave-types", { token: hrToken });
    const blockedSubmit = await apiRequest(server.baseUrl, "POST", "/api/v1/me/leave", {
      token: selfToken,
      body: { leaveTypeId: type.body.data[0].id, startDate: "2026-12-01", endDate: "2026-12-01", requestedDays: 1 },
    });
    assert.equal(blockedSubmit.status, 403, "leave.self.cancel alone does not authorize submitting a new request");

    const cancelled = await apiRequest(server.baseUrl, "POST", `/api/v1/me/leave/${requestId}/cancel`, {
      token: selfToken,
    });
    assert.equal(cancelled.status, 200, "leave.self.cancel independently still authorizes cancelling own request");
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${selfUserId}/permissions/leave.self.create`, {
      token: ceoToken,
    });
  }
});

test("an explicit DENY on leave.self.cancel overrides the EMPLOYEE baseline role grant", async () => {
  const selfUserId = await selfUserIdFor(employeeId);
  const requestId = await submitSelfLeave(selfToken);

  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${selfUserId}/permissions/leave.self.cancel`, {
    token: ceoToken,
    body: { effect: "DENY" },
  });

  try {
    const denied = await apiRequest(server.baseUrl, "POST", `/api/v1/me/leave/${requestId}/cancel`, {
      token: selfToken,
    });
    assert.equal(denied.status, 403, "explicit DENY beats the role's baseline GRANT of leave.self.cancel");
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${selfUserId}/permissions/leave.self.cancel`, {
      token: ceoToken,
    });
  }

  const allowedAfterRemoval = await apiRequest(server.baseUrl, "POST", `/api/v1/me/leave/${requestId}/cancel`, {
    token: selfToken,
  });
  assert.equal(allowedAfterRemoval.status, 200, "removing the override restores the role default (able to cancel)");
});

test("an employee cannot cancel another employee's own leave request through the self-cancel endpoint", async () => {
  const otherCreated = await apiRequest(server.baseUrl, "POST", "/api/v1/employees", {
    token: hrToken,
    body: { employeeCode: unique("EMP-OTHER"), fullLegalName: unique("Other Leave Employee"), joiningDate: "2026-01-01" },
  });
  const otherEmployeeId = otherCreated.body.data.id;
  const otherEmail = `${unique("rl-other")}@test.eset.local`;
  const otherLogin = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${otherEmployeeId}/login`, {
    token: hrToken,
    body: { email: otherEmail },
  });
  const otherTempToken = await authHeader(server.baseUrl, otherEmail, otherLogin.body.data.temporaryPassword);
  await apiRequest(server.baseUrl, "POST", "/api/v1/auth/change-password", {
    token: otherTempToken,
    body: { currentPassword: otherLogin.body.data.temporaryPassword, newPassword: "Rl-Other-Pw-123" },
  });
  const otherToken = await authHeader(server.baseUrl, otherEmail, "Rl-Other-Pw-123");

  const requestId = await submitSelfLeave(selfToken, "2026-10-15");

  const crossCancel = await apiRequest(server.baseUrl, "POST", `/api/v1/me/leave/${requestId}/cancel`, {
    token: otherToken,
  });
  assert.equal(crossCancel.status, 409, "the self-cancel endpoint only ever matches the caller's own request");

  const ownCancel = await apiRequest(server.baseUrl, "POST", `/api/v1/me/leave/${requestId}/cancel`, {
    token: selfToken,
  });
  assert.equal(ownCancel.status, 200, "the actual owner can still cancel it");
});

test("existing cancellation state-machine rules still hold: only a SUBMITTED request can be cancelled, and not twice", async () => {
  const requestId = await submitSelfLeave(selfToken, "2026-10-20");

  const firstCancel = await apiRequest(server.baseUrl, "POST", `/api/v1/me/leave/${requestId}/cancel`, {
    token: selfToken,
  });
  assert.equal(firstCancel.status, 200, JSON.stringify(firstCancel.body));

  const secondCancel = await apiRequest(server.baseUrl, "POST", `/api/v1/me/leave/${requestId}/cancel`, {
    token: selfToken,
  });
  assert.equal(secondCancel.status, 409, "an already-cancelled request cannot be cancelled again");
});

// ---------------------------------------------------------------------
// ESDMS-008 failure-injection: prove the single withTransaction covering
// each flow's primary mutation + business-history write is truly atomic —
// a failure on the SECOND write must roll back the FIRST too, and leave no
// success history row behind.
//
// pool.connect() is used two different ways in this codebase (see the
// identical, already-proven pattern in outbox-durability.test.js): promise
// style with no arguments (withTransaction, awaited directly) and
// Node-callback style (pg-pool's own internal pool.query() convenience
// method calls `this.connect((err, client) => {...})` for every plain,
// non-transactional query — auth/permission lookups, validation reads,
// etc). A mock that only implements the promise style silently never
// invokes that callback, hanging pool.query() (and pool.end()) forever.
// Only the ONE promise-style call — withTransaction's own client — is
// poisoned; every callback-style call is passed straight through
// untouched. Callers must call `t.mock.reset()` right after asserting the
// injected failure, before running any cleanup/assertion queries.
//
// pg-pool also reuses the same small set of underlying client objects
// across separate pool.connect() calls (including ones from later,
// unrelated tests) — resetting pool.connect via t.mock.reset() does NOT
// undo the direct client.query override made below, since that lives on
// the client object itself. Without restoring it too, a later test whose
// pool.connect() happens to be handed this exact reused client inherits
// this test's failure — confirmed empirically (submitLeave's own
// recordHistory call, unrelated to a later cancel/decide test, kept
// failing because it reused the poisoned client). t.after() restores
// every wrapped client regardless of whether it ever matched.
function injectQueryFailure(t, failingSqlFragment) {
  const realConnect = pool.connect.bind(pool);
  const wrapped = [];
  t.mock.method(pool, "connect", (callback) => {
    if (typeof callback === "function") {
      return realConnect(callback);
    }

    return (async () => {
      const client = await realConnect();
      const realQuery = client.query.bind(client);
      client.query = (text, ...args) => {
        if (typeof text === "string" && text.includes(failingSqlFragment)) {
          client.query = realQuery;
          throw new Error("ESDMS-008_INJECTED_FAILURE");
        }
        return realQuery(text, ...args);
      };
      wrapped.push({ client, realQuery });
      return client;
    })();
  });
  t.after(() => {
    for (const { client, realQuery } of wrapped) client.query = realQuery;
  });
}

test("ESDMS-008 rollback: submitLeave rolls back the leave_requests insert entirely if the history write fails", async (t) => {
  const type = await apiRequest(server.baseUrl, "GET", "/api/v1/leave-types", { token: hrToken });
  const leaveTypeId = type.body.data[0].id;

  const before = await pool.query("SELECT count(*)::int AS n FROM leave_requests WHERE employee_id = $1", [
    employeeId,
  ]);
  const historyBefore = await pool.query(
    "SELECT count(*)::int AS n FROM employee_business_history WHERE employee_id = $1 AND event_type = 'LEAVE_SUBMITTED'",
    [employeeId],
  );

  injectQueryFailure(t, "INSERT INTO employee_business_history");

  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/me/leave", {
    token: selfToken,
    body: { leaveTypeId, startDate: "2026-09-01", endDate: "2026-09-01", requestedDays: 1 },
  });
  assert.equal(response.status, 500, JSON.stringify(response.body));
  t.mock.reset();

  const after = await pool.query("SELECT count(*)::int AS n FROM leave_requests WHERE employee_id = $1", [
    employeeId,
  ]);
  assert.equal(after.rows[0].n, before.rows[0].n, "the leave request insert was rolled back, not partially committed");

  // employeeId is shared with every other test in this file (many of which
  // legitimately submit leave) — assert no NEW row appeared, not an
  // absolute count.
  const historyAfter = await pool.query(
    "SELECT count(*)::int AS n FROM employee_business_history WHERE employee_id = $1 AND event_type = 'LEAVE_SUBMITTED'",
    [employeeId],
  );
  assert.equal(
    historyAfter.rows[0].n,
    historyBefore.rows[0].n,
    "no success history row survives a rolled-back submit",
  );
});

test("ESDMS-008 rollback: cancelMyLeave rolls back the status change if the history write fails", async (t) => {
  const requestId = await submitSelfLeave(selfToken, "2026-09-05");

  injectQueryFailure(t, "INSERT INTO employee_business_history");

  const response = await apiRequest(server.baseUrl, "POST", `/api/v1/me/leave/${requestId}/cancel`, {
    token: selfToken,
  });
  assert.equal(response.status, 500, JSON.stringify(response.body));
  t.mock.reset();

  const row = await pool.query("SELECT status FROM leave_requests WHERE id = $1", [requestId]);
  assert.equal(row.rows[0].status, "SUBMITTED", "the cancellation was rolled back — status is unchanged");

  // Scoped to this specific request (via its id in the JSONB summary), not
  // an absolute count — other tests in this file legitimately cancel their
  // own, different leave requests.
  const history = await pool.query(
    "SELECT count(*)::int AS n FROM employee_business_history WHERE event_type = 'LEAVE_CANCELLED' AND summary->>'requestId' = $1",
    [requestId],
  );
  assert.equal(history.rows[0].n, 0, "no success history row survives a rolled-back cancel");
});

test("ESDMS-008 rollback: decideLeave rolls back the decision (and history) if the notification enqueue fails", async (t) => {
  const requestId = await submitSelfLeave(selfToken, "2026-09-10");

  injectQueryFailure(t, "INSERT INTO notification_outbox");

  const response = await apiRequest(server.baseUrl, "POST", `/api/v1/leave/${requestId}/decide`, {
    token: hrToken,
    body: { status: "APPROVED" },
  });
  assert.equal(response.status, 500, JSON.stringify(response.body));
  t.mock.reset();

  const row = await pool.query("SELECT status, decided_by_user_id FROM leave_requests WHERE id = $1", [requestId]);
  assert.equal(row.rows[0].status, "SUBMITTED", "the decision was rolled back — status is unchanged");
  assert.equal(row.rows[0].decided_by_user_id, null, "the decision fields were rolled back too");

  // Scoped to this specific request, not an absolute count — other tests
  // in this file legitimately approve their own, different leave requests.
  const history = await pool.query(
    "SELECT count(*)::int AS n FROM employee_business_history WHERE event_type = 'LEAVE_APPROVED' AND summary->>'requestId' = $1",
    [requestId],
  );
  assert.equal(history.rows[0].n, 0, "no success history row survives a rolled-back decision, even though it was written before the failing query");
});
