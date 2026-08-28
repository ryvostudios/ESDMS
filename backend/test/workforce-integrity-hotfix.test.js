// Regression suite for the two Workforce data-integrity defects found by
// the Phase 2 browser acceptance run:
//
//   1. the compensation chronological guard never fired, because a
//      YYYY-MM-DD string was compared against a JS Date;
//   2. a contract could be finalized — and so made permanently immutable —
//      with no effective start date and no terms summary.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let ceoToken;
let hrToken;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

function pdfForm() {
  const form = new FormData();
  const pdfBytes = Buffer.from("%PDF-1.4\n%integrity hotfix fixture\ntrailer<<>>", "utf8");
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "contract.pdf");
  return form;
}

// A dedicated employee per test keeps every chronological assertion
// independent of rows other tests (or earlier runs) left behind.
async function newEmployee() {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/employees", {
    token: hrToken,
    body: { employeeCode: unique("INTEG"), fullLegalName: unique("Integrity Fixture"), joiningDate: "2026-01-01" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return created.body.data.id;
}

function recordCompensation(employeeId, body, token = ceoToken) {
  return apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/compensation`, { token, body });
}

before(async () => {
  server = await startTestServer();
  await seedUsers();
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
});

after(async () => {
  await server.close();
  await pool.end();
});

// ---------------------------------------------------------------------
// Defect 1 — compensation chronological guard
// ---------------------------------------------------------------------

test("A — a record earlier than the current record is rejected", async () => {
  const employeeId = await newEmployee();
  assert.equal((await recordCompensation(employeeId, { amount: 90000, effectiveDate: "2026-01-01" })).status, 201);

  const backdated = await recordCompensation(employeeId, { amount: 5, effectiveDate: "2025-03-01" });
  assert.equal(backdated.status, 400, JSON.stringify(backdated.body));
  assert.match(backdated.body.error.message, /earlier than the current compensation record/i);

  const history = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/compensation/history`, { token: ceoToken });
  assert.equal(history.body.data.length, 1, "the rejected record was never written");
});

test("A2 — rejection holds across a year boundary and one day before the current record", async () => {
  const employeeId = await newEmployee();
  assert.equal((await recordCompensation(employeeId, { amount: 100000, effectiveDate: "2026-03-10" })).status, 201);

  for (const effectiveDate of ["2026-03-09", "2026-01-31", "2025-12-31"]) {
    const attempt = await recordCompensation(employeeId, { amount: 1, effectiveDate });
    assert.equal(attempt.status, 400, `${effectiveDate} must be rejected: ${JSON.stringify(attempt.body)}`);
  }
});

test("B — the same effective date is rejected and never duplicates the record", async () => {
  const employeeId = await newEmployee();
  assert.equal((await recordCompensation(employeeId, { amount: 120000, effectiveDate: "2026-02-01" })).status, 201);

  // The intended rule for an equal date comes from the schema, not the
  // chronological guard: employee_compensation_records carries a
  // unique(employee_id, effective_date) constraint, so an employee has at
  // most one record per effective date. The guard deliberately rejects only
  // a *strictly earlier* date and leaves this case to the constraint.
  const sameDay = await recordCompensation(employeeId, { amount: 130000, effectiveDate: "2026-02-01" });
  assert.ok(sameDay.status >= 400, `a duplicate effective date must not be written: ${JSON.stringify(sameDay.body)}`);

  // The integrity property is what matters here and it holds: nothing was
  // written and the original record is untouched. The status code is not:
  // the unique violation escapes as 500 rather than a handled conflict.
  // Recorded as finding H1 — outside this hotfix's two-defect scope.
  const history = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/compensation/history`, { token: ceoToken });
  assert.equal(history.body.data.length, 1, "no duplicate row was created");
  assert.equal(history.body.data[0].amount, "120000.00", "the original record is unchanged");
});

test("C — a later effective date is accepted, including a future-dated one", async () => {
  const employeeId = await newEmployee();
  assert.equal((await recordCompensation(employeeId, { amount: 100000, effectiveDate: "2026-02-01" })).status, 201);
  assert.equal((await recordCompensation(employeeId, { amount: 110000, effectiveDate: "2026-06-01" })).status, 201);
  assert.equal((await recordCompensation(employeeId, { amount: 125000, effectiveDate: "2099-01-01" })).status, 201);
});

test("D — compensation history stays append-only and unchanged by later records", async () => {
  const employeeId = await newEmployee();
  await recordCompensation(employeeId, { amount: 100000, effectiveDate: "2026-02-01", reason: "Initial" });
  const first = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/compensation/history`, { token: ceoToken });
  const originalRow = first.body.data[0];

  await recordCompensation(employeeId, { amount: 140000, effectiveDate: "2026-07-01", reason: "Raise" });
  const after = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/compensation/history`, { token: ceoToken });

  assert.equal(after.body.data.length, 2, "a change appends, never overwrites");
  const preserved = after.body.data.find((row) => row.id === originalRow.id);
  assert.deepEqual(preserved, originalRow, "the earlier record is byte-for-byte unchanged");

  // Exact decimal money, never a JS float round-trip.
  assert.equal(preserved.amount, "100000.00");

  // There is no update or delete path at all, by design.
  assert.equal(
    (await apiRequest(server.baseUrl, "DELETE", `/api/v1/employees/${employeeId}/compensation/${originalRow.id}`, { token: ceoToken })).status,
    404,
  );
});

test("E — getCurrent still resolves the latest record already in effect, ignoring future ones", async () => {
  const employeeId = await newEmployee();
  await recordCompensation(employeeId, { amount: 100000, effectiveDate: "2026-02-01" });
  await recordCompensation(employeeId, { amount: 190000, effectiveDate: "2099-01-01" });

  const current = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/compensation/current`, { token: ceoToken });
  assert.equal(current.status, 200);
  assert.equal(current.body.data.amount, "100000.00", "a future-dated record is not yet current");

  // And the guard measures against that same row: 2026-01-01 is earlier
  // than the current 2026-02-01 even though a 2099 record also exists.
  assert.equal((await recordCompensation(employeeId, { amount: 1, effectiveDate: "2026-01-01" })).status, 400);
});

test("E2 — an employee with no compensation yet can receive any effective date", async () => {
  const employeeId = await newEmployee();
  assert.equal((await recordCompensation(employeeId, { amount: 50000, effectiveDate: "2020-05-05" })).status, 201);
});

test("F — an actor without compensation.change is still denied, before any date check", async () => {
  const employeeId = await newEmployee();
  await recordCompensation(employeeId, { amount: 100000, effectiveDate: "2026-02-01" });

  const denied = await recordCompensation(employeeId, { amount: 1, effectiveDate: "2020-01-01" }, hrToken);
  assert.equal(denied.status, 403, "authorization is decided before validation");
  assert.equal(
    (await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/compensation/current`, { token: hrToken })).status,
    403,
  );
});

// ---------------------------------------------------------------------
// Defect 1, concurrency — the guard must survive two writers at once
// ---------------------------------------------------------------------

// Holds the very row lock recordCompensation takes, so writes for this
// employee pile up at a point we control. This is what lets the test prove
// two requests are genuinely in flight together instead of assuming it from
// having called them without an await in between.
async function holdEmployeeLock(employeeId) {
  const client = await pool.connect();
  let held = true;

  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM employees WHERE id = $1 FOR UPDATE", [employeeId]);
    const { rows } = await client.query("SELECT pg_backend_pid() AS pid");

    return {
      pid: rows[0].pid,
      // Idempotent so the test can release the gate at the right moment and
      // still release it from a finally block if an assertion threw first.
      release: async () => {
        if (!held) return;
        held = false;
        try {
          await client.query("COMMIT");
        } finally {
          client.release();
        }
      },
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

// How many backends Postgres itself reports as stuck behind the gate.
// Asking the database beats sleeping: overlap becomes an observation rather
// than a timing guess.
//
// The walk has to be transitive. Only the first waiter blocks on the gate's
// transaction directly; every later one blocks on the *tuple* lock held by
// the waiter ahead of it, so its pg_blocking_pids names that waiter, not the
// gate. That chain is also precisely why the outcome below is deterministic
// rather than a coin flip: Postgres hands the row lock to the queued
// waiters in the order they started waiting.
async function blockedByGate(pid) {
  const { rows } = await pool.query(
    `WITH RECURSIVE waiters AS (
       SELECT pid FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))
       UNION
       SELECT a.pid FROM pg_stat_activity a JOIN waiters w ON w.pid = ANY(pg_blocking_pids(a.pid))
     )
     SELECT count(*)::int AS blocked FROM waiters`,
    [pid],
  );
  return rows[0].blocked;
}

// Bounded on purpose: without the row lock nothing ever blocks, so this has
// to give up instead of hanging the suite. The status/history assertions —
// not this wait — are what fail in that case.
async function waitForBlocked(pid, count, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if ((await blockedByGate(pid)) >= count) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  return false;
}

// Sends the later-dated write first and the earlier-dated one second, with
// both parked on the gate before either is allowed to proceed. Postgres
// grants a contended row lock in the order backends began waiting, so the
// later-dated write commits first and the earlier-dated one then re-reads a
// current record it is behind — a deterministic outcome, not a race the
// test hopes will land the same way twice.
async function racePair(employeeId) {
  const gate = await holdEmployeeLock(employeeId);

  try {
    const later = recordCompensation(employeeId, { amount: 150000, effectiveDate: "2026-08-01" });
    const laterQueued = await waitForBlocked(gate.pid, 1);

    const earlier = recordCompensation(employeeId, { amount: 60000, effectiveDate: "2026-07-01" });
    const bothQueued = await waitForBlocked(gate.pid, 2);

    // Released before awaiting: both requests are stuck behind this gate and
    // cannot finish until it commits.
    await gate.release();

    const [laterResult, earlierResult] = await Promise.all([later, earlier]);
    return { laterQueued, bothQueued, laterResult, earlierResult };
  } finally {
    await gate.release();
  }
}

async function compensationHistory(employeeId) {
  const response = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/compensation/history`, {
    token: ceoToken,
  });
  return response.body.data;
}

async function sideEffectCounts(employeeId) {
  const timeline = await pool.query(
    "SELECT count(*)::int AS n FROM employee_business_history WHERE employee_id = $1 AND event_type = 'COMPENSATION_CHANGED'",
    [employeeId],
  );
  const audit = await pool.query(
    "SELECT count(*)::int AS n FROM governance_audit_log WHERE target_employee_id = $1 AND action = 'COMPENSATION_RECORDED'",
    [employeeId],
  );
  return { timeline: timeline.rows[0].n, audit: audit.rows[0].n };
}

test("G — two concurrent writes cannot both append, leaving a record behind the current one", async () => {
  const employeeId = await newEmployee();
  assert.equal((await recordCompensation(employeeId, { amount: 90000, effectiveDate: "2026-01-01" })).status, 201);

  const { laterQueued, bothQueued, laterResult, earlierResult } = await racePair(employeeId);

  assert.ok(laterQueued, "the 2026-08-01 write must wait on the employee row lock, not read past it");
  assert.ok(bothQueued, "both writes must be in flight at the same time, not run one after the other");

  assert.equal(laterResult.status, 201, JSON.stringify(laterResult.body));

  // The whole point: 2026-07-01 was legal against the record that was
  // current when it arrived (2026-01-01) and is illegal against the one that
  // is current when it finally gets the lock (2026-08-01). It must be judged
  // against the latter.
  assert.equal(earlierResult.status, 400, JSON.stringify(earlierResult.body));
  assert.match(earlierResult.body.error.message, /earlier than the current compensation record/i);

  const history = await compensationHistory(employeeId);
  assert.equal(history.length, 2, "the rejected write appended nothing");
  assert.deepEqual(
    history.map((row) => row.amount),
    ["150000.00", "90000.00"],
    "only the chronologically valid history survives",
  );

  // Nothing partial: the rejected transaction rolled back its timeline and
  // audit rows along with the compensation row.
  assert.deepEqual(await sideEffectCounts(employeeId), { timeline: 2, audit: 2 });
});

test("H — the first-ever compensation record is serialized too", async () => {
  // No compensation row exists yet, so there is nothing but the Employee row
  // available to lock — the case a compensation-row lock would miss.
  const employeeId = await newEmployee();

  const { laterQueued, bothQueued, laterResult, earlierResult } = await racePair(employeeId);

  assert.ok(laterQueued && bothQueued, "both first-ever writes must contend for the same employee lock");
  assert.equal(laterResult.status, 201, JSON.stringify(laterResult.body));
  assert.equal(earlierResult.status, 400, JSON.stringify(earlierResult.body));

  const history = await compensationHistory(employeeId);
  assert.equal(history.length, 1, "only one of two concurrent first-ever records is written");
  assert.equal(history[0].amount, "150000.00");
  assert.deepEqual(await sideEffectCounts(employeeId), { timeline: 1, audit: 1 });
});

test("I — the lock is per-employee and is taken only after authorization", async () => {
  const locked = await newEmployee();
  const unrelated = await newEmployee();
  const gate = await holdEmployeeLock(locked);

  try {
    // Different employee, so it must not queue behind the gate at all.
    const other = await recordCompensation(unrelated, { amount: 100000, effectiveDate: "2026-03-01" });
    assert.equal(other.status, 201, JSON.stringify(other.body));

    // Same (locked) employee, but the actor lacks compensation.change:
    // refused outright while the row is still locked, which is only possible
    // because authorization is decided before the lock is ever requested.
    const denied = await recordCompensation(locked, { amount: 1, effectiveDate: "2026-09-01" }, hrToken);
    assert.equal(denied.status, 403, JSON.stringify(denied.body));

    assert.equal(await blockedByGate(gate.pid), 0, "neither request was serialized behind an unrelated employee's lock");
  } finally {
    await gate.release();
  }

  // The gate held no compensation of its own, and the refused attempt left
  // nothing behind.
  assert.equal((await compensationHistory(locked)).length, 0);
});

// ---------------------------------------------------------------------
// Defect 2 — a contract must be complete before it becomes immutable
// ---------------------------------------------------------------------

async function draftWithFile(employeeId, body = { kind: "ORIGINAL" }) {
  const draft = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts`, { token: ceoToken, body });
  assert.equal(draft.status, 201, JSON.stringify(draft.body));
  const contractId = draft.body.data.id;
  const uploaded = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts/${contractId}/file`, {
    token: ceoToken,
    body: pdfForm(),
    isForm: true,
  });
  assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
  return contractId;
}

function finalize(employeeId, contractId, token = ceoToken) {
  return apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts/${contractId}/finalize`, { token });
}

test("1 — finalization is rejected when required contract metadata is missing", async () => {
  const employeeId = await newEmployee();

  const noMetadata = await draftWithFile(employeeId);
  const rejectedBoth = await finalize(employeeId, noMetadata);
  assert.equal(rejectedBoth.status, 400, JSON.stringify(rejectedBoth.body));
  assert.match(rejectedBoth.body.error.message, /effective start date/i);

  const noTerms = await draftWithFile(employeeId, { kind: "ORIGINAL", effectiveStartDate: "2026-01-15" });
  const rejectedTerms = await finalize(employeeId, noTerms);
  assert.equal(rejectedTerms.status, 400, JSON.stringify(rejectedTerms.body));
  assert.match(rejectedTerms.body.error.message, /terms summary/i);

  const noStart = await draftWithFile(employeeId, { kind: "ORIGINAL", termsSummary: "Terms only." });
  const rejectedStart = await finalize(employeeId, noStart);
  assert.equal(rejectedStart.status, 400, JSON.stringify(rejectedStart.body));
  assert.match(rejectedStart.body.error.message, /effective start date/i);

  for (const id of [noMetadata, noTerms, noStart]) {
    const still = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/contracts/${id}`, { token: ceoToken });
    assert.equal(still.body.data.status, "DRAFT", "a rejected finalization leaves the contract editable");
  }
});

test("2 — finalization is still rejected when the PDF is missing", async () => {
  const employeeId = await newEmployee();
  const draft = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts`, {
    token: ceoToken,
    body: { kind: "ORIGINAL", effectiveStartDate: "2026-01-15", termsSummary: "Complete terms." },
  });
  const attempt = await finalize(employeeId, draft.body.data.id);
  assert.equal(attempt.status, 400, JSON.stringify(attempt.body));
  assert.match(attempt.body.error.message, /upload the contract file/i);
});

test("3 — a draft completed through the normal edit path finalizes", async () => {
  const employeeId = await newEmployee();
  const contractId = await draftWithFile(employeeId);

  const saved = await apiRequest(server.baseUrl, "PATCH", `/api/v1/employees/${employeeId}/contracts/${contractId}`, {
    token: ceoToken,
    body: { effectiveStartDate: "2026-01-15", termsSummary: "Permanent employment, standard terms." },
  });
  assert.equal(saved.status, 200, JSON.stringify(saved.body));

  const finalized = await finalize(employeeId, contractId);
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  assert.equal(finalized.body.data.status, "CURRENT");
  assert.equal(finalized.body.data.terms_summary, "Permanent employment, standard terms.");
  assert.ok(finalized.body.data.effective_start_date, "the finalized contract carries its start date");
});

test("4-7 — every immutability protection is unchanged after finalization", async () => {
  const employeeId = await newEmployee();
  const contractId = await draftWithFile(employeeId, {
    kind: "ORIGINAL",
    effectiveStartDate: "2026-01-15",
    termsSummary: "Original agreed terms.",
  });
  assert.equal((await finalize(employeeId, contractId)).status, 200);

  const edit = await apiRequest(server.baseUrl, "PATCH", `/api/v1/employees/${employeeId}/contracts/${contractId}`, {
    token: ceoToken,
    body: { termsSummary: "Tampered terms" },
  });
  assert.equal(edit.status, 409, "4 — edit rejected");

  const replace = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts/${contractId}/file`, {
    token: ceoToken,
    body: pdfForm(),
    isForm: true,
  });
  assert.equal(replace.status, 409, "5 — file replacement rejected");

  const removed = await apiRequest(server.baseUrl, "DELETE", `/api/v1/employees/${employeeId}/contracts/${contractId}`, { token: ceoToken });
  assert.equal(removed.status, 403, "6 — deletion rejected");

  assert.equal((await finalize(employeeId, contractId)).status, 409, "7 — re-finalize rejected");

  await assert.rejects(
    pool.query("UPDATE employee_contracts SET terms_summary = 'db tamper' WHERE id = $1", [contractId]),
    /immutable/,
    "the DB trigger still backs the service layer",
  );

  const intact = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/contracts/${contractId}`, { token: ceoToken });
  assert.equal(intact.body.data.terms_summary, "Original agreed terms.");
});

test("8 — amendment and supersession rules are unchanged", async () => {
  const employeeId = await newEmployee();
  const originalId = await draftWithFile(employeeId, {
    kind: "ORIGINAL",
    effectiveStartDate: "2026-01-15",
    termsSummary: "Original terms.",
  });
  assert.equal((await finalize(employeeId, originalId)).status, 200);

  const orphan = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts`, {
    token: ceoToken,
    body: { kind: "AMENDMENT" },
  });
  assert.equal(orphan.status, 400, "an amendment still requires a finalized original");

  const amendmentId = await draftWithFile(employeeId, {
    kind: "AMENDMENT",
    amendsContractId: originalId,
    effectiveStartDate: "2026-06-01",
    termsSummary: "Amended terms.",
  });
  assert.equal((await finalize(employeeId, amendmentId)).status, 200);

  const transition = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/contracts/${originalId}/transition`, {
    token: ceoToken,
    body: { status: "SUPERSEDED" },
  });
  assert.equal(transition.status, 200);
  assert.equal(transition.body.data.status, "SUPERSEDED");
  assert.equal(transition.body.data.terms_summary, "Original terms.", "a transition never rewrites terms");
});

test("9 — an actor without contract.finalize is denied before any completeness check", async () => {
  const employeeId = await newEmployee();
  const contractId = await draftWithFile(employeeId);

  const denied = await finalize(employeeId, contractId, hrToken);
  assert.equal(denied.status, 403, "authorization is decided before validation");
});

test("10 — pre-existing finalized contracts with null terms still read correctly", async () => {
  const employeeId = await newEmployee();
  const contractId = await draftWithFile(employeeId);

  // A row created before this fix: finalized while still incomplete. The
  // trigger permits this UPDATE only because the row is still DRAFT, which
  // is exactly how the historical rows came to exist.
  await pool.query(
    "UPDATE employee_contracts SET status = 'CURRENT', finalized_at = CURRENT_TIMESTAMP WHERE id = $1",
    [contractId],
  );

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/contracts/${contractId}`, { token: ceoToken });
  assert.equal(detail.status, 200, JSON.stringify(detail.body));
  assert.equal(detail.body.data.status, "CURRENT");
  assert.equal(detail.body.data.effective_start_date, null);
  assert.equal(detail.body.data.terms_summary, null);

  const list = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/contracts`, { token: ceoToken });
  assert.equal(list.status, 200);
  assert.ok(list.body.data.some((c) => c.id === contractId), "a legacy incomplete row still lists");

  const download = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/contracts/${contractId}/download`, { token: ceoToken });
  assert.equal(download.status, 200, "and still downloads");

  // The new rule is prospective only: it never retro-invalidates a stored row.
  assert.equal((await finalize(employeeId, contractId)).status, 409);
});
