import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest, buildCreatePayload } from "./gate-pass-helpers.js";
import { processOnce } from "../src/shared/notifications/outbox.processor.js";
import { claimBatch, enqueue, markDelivered } from "../src/shared/notifications/outbox.repository.js";
import { withTransaction } from "../src/shared/db/with-transaction.js";

let server;
let users;
let tokens;
let departmentId;

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  departmentId = users.departmentA;

  tokens = {
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
  };
});

after(async () => {
  await server.close();
  await pool.end();
});

async function createApprovedDraft() {
  const { body } = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.admin,
    body: buildCreatePayload({ issuingDepartmentId: departmentId }),
  });

  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${body.data.id}/approve`, {
    token: tokens.admin,
  });

  return body.data.id;
}

test("approval returns before the PDF exists — generation is a durable background job, not inline", async () => {
  const id = await createApprovedDraft();

  const immediately = await pool.query(
    "SELECT count(*)::int AS n FROM gate_pass_files WHERE gate_pass_id = $1 AND file_type = 'APPROVED_PDF'",
    [id],
  );
  assert.equal(immediately.rows[0].n, 0, "PDF must not exist synchronously right after approve");

  const pendingJob = await pool.query(
    "SELECT status, channel, event_type FROM notification_outbox WHERE entity_id = $1 AND event_type = 'GENERATE_APPROVAL_PDF'",
    [id],
  );
  assert.equal(pendingJob.rows[0].status, "PENDING");

  await processOnce();

  const afterProcessing = await pool.query(
    "SELECT count(*)::int AS n FROM gate_pass_files WHERE gate_pass_id = $1 AND file_type = 'APPROVED_PDF'",
    [id],
  );
  assert.equal(afterProcessing.rows[0].n, 1, "the worker must have generated exactly one PDF file");

  const whatsapp = await pool.query(
    "SELECT status FROM notification_outbox WHERE entity_id = $1 AND channel = 'WHATSAPP'",
    [id],
  );
  assert.equal(whatsapp.rows[0].status, "SIMULATED");
});

test("the Gate Pass detail API's documentReady flag is false immediately after approval and true once the worker has run", async () => {
  const id = await createApprovedDraft();

  const beforeWorker = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}`, {
    token: tokens.admin,
  });
  assert.equal(beforeWorker.status, 200);
  assert.equal(
    beforeWorker.body.data.documentReady,
    false,
    "documentReady must be false before the background job has run — the frontend must not enable View PDF yet",
  );

  await processOnce();

  const afterWorker = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}`, {
    token: tokens.admin,
  });
  assert.equal(afterWorker.body.data.documentReady, true);
});

test("the raw verification token is erased from the SYSTEM job's payload once the PDF has been generated", async () => {
  const id = await createApprovedDraft();

  const beforeWorker = await pool.query(
    "SELECT payload->>'rawToken' AS raw_token FROM notification_outbox WHERE entity_id = $1 AND event_type = 'GENERATE_APPROVAL_PDF'",
    [id],
  );
  assert.ok(beforeWorker.rows[0].raw_token, "the raw token must be present before finalization runs");

  await processOnce();

  const afterWorker = await pool.query(
    "SELECT payload->>'rawToken' AS raw_token FROM notification_outbox WHERE entity_id = $1 AND event_type = 'GENERATE_APPROVAL_PDF'",
    [id],
  );
  assert.equal(afterWorker.rows[0].raw_token, null, "the raw token must be erased once finalization has used it");
});

test("re-running the outbox worker after success is a safe no-op (idempotent retry)", async () => {
  const id = await createApprovedDraft();

  await processOnce();
  await processOnce();
  await processOnce();

  const files = await pool.query(
    "SELECT count(*)::int AS n FROM gate_pass_files WHERE gate_pass_id = $1 AND file_type = 'APPROVED_PDF'",
    [id],
  );
  assert.equal(files.rows[0].n, 1, "retrying the job must never create a second PDF file row");

  const whatsappJobs = await pool.query(
    "SELECT count(*)::int AS n FROM notification_outbox WHERE entity_id = $1 AND channel = 'WHATSAPP'",
    [id],
  );
  assert.equal(whatsappJobs.rows[0].n, 1, "retrying the job must never enqueue a duplicate WhatsApp send");
});

test("claimBatch atomically claims a row exactly once under concurrent callers (FOR UPDATE SKIP LOCKED)", async () => {
  await createApprovedDraft();
  await createApprovedDraft();
  await createApprovedDraft();

  const [batchA, batchB] = await Promise.all([claimBatch("SYSTEM", 10), claimBatch("SYSTEM", 10)]);

  const idsA = new Set(batchA.map((row) => row.id));
  const idsB = new Set(batchB.map((row) => row.id));
  const overlap = [...idsA].filter((id) => idsB.has(id));

  assert.equal(overlap.length, 0, "two concurrent claimers must never receive the same row");
  assert.ok(idsA.size + idsB.size >= 3, "between them, the pending SYSTEM jobs must all have been claimed");

  // Every claimed row must now show PROCESSING, not still PENDING.
  for (const row of [...batchA, ...batchB]) {
    assert.equal(row.status, "PROCESSING");
  }
});

test("enqueue with a duplicate idempotency key is a no-op, not a duplicate row", async () => {
  const id = await createApprovedDraft();
  await processOnce();

  const before = await pool.query(
    "SELECT count(*)::int AS n FROM notification_outbox WHERE entity_id = $1 AND channel = 'WHATSAPP'",
    [id],
  );

  await withTransaction((client) =>
    enqueue(client, [
      {
        channel: "WHATSAPP",
        eventType: "GATE_PASS_APPROVED",
        entityType: "GATE_PASS",
        entityId: id,
        recipientPhone: "+10000000000",
        recipientSiteId: users.mainSite,
        idempotencyKey: `whatsapp-approval:${id}`,
        payload: { storageKey: "x", filename: "x.pdf", caption: "x" },
      },
    ]),
  );

  const after = await pool.query(
    "SELECT count(*)::int AS n FROM notification_outbox WHERE entity_id = $1 AND channel = 'WHATSAPP'",
    [id],
  );

  assert.equal(after.rows[0].n, before.rows[0].n, "a duplicate idempotency key must not insert a second row");
});

test("a stale PROCESSING job (worker crashed mid-send, lease expired) is reclaimed exactly once", async () => {
  const id = await createApprovedDraft();

  const [firstClaim] = await claimBatch("SYSTEM", 1);
  assert.equal(firstClaim.entity_id, id);
  assert.equal(firstClaim.status, "PROCESSING");

  // Simulate the worker that claimed it crashing before finishing: back-date
  // locked_at past the lease window instead of waiting for real time to pass.
  await pool.query("UPDATE notification_outbox SET locked_at = now() - interval '10 minutes' WHERE id = $1", [
    firstClaim.id,
  ]);

  const reclaimed = await claimBatch("SYSTEM", 10);
  const reclaimedIds = reclaimed.map((row) => row.id);

  assert.equal(reclaimedIds.filter((rowId) => rowId === firstClaim.id).length, 1, "reclaimed exactly once");

  const row = await pool.query("SELECT status, locked_at FROM notification_outbox WHERE id = $1", [firstClaim.id]);
  assert.equal(row.rows[0].status, "PROCESSING");
  assert.ok(new Date(row.rows[0].locked_at) > new Date(Date.now() - 60_000), "lease must be refreshed on reclaim");
});

test("cancelling right after approval, before the worker runs, voids the pending PDF/WhatsApp jobs — no stale approved delivery", async () => {
  const id = await createApprovedDraft();

  const cancelled = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/cancel`, {
    token: tokens.admin,
    body: { reason: "Trip no longer required." },
  });
  assert.equal(cancelled.status, 200);

  const beforeWorker = await pool.query(
    "SELECT status FROM notification_outbox WHERE entity_id = $1 AND event_type = 'GENERATE_APPROVAL_PDF'",
    [id],
  );
  assert.equal(beforeWorker.rows[0].status, "VOID", "cancellation must void the not-yet-claimed PDF job");

  await processOnce();

  const pdfFiles = await pool.query(
    "SELECT count(*)::int AS n FROM gate_pass_files WHERE gate_pass_id = $1 AND file_type = 'APPROVED_PDF'",
    [id],
  );
  assert.equal(pdfFiles.rows[0].n, 0, "no PDF must ever be generated for a cancelled pass");

  const whatsappJobs = await pool.query(
    "SELECT count(*)::int AS n FROM notification_outbox WHERE entity_id = $1 AND channel = 'WHATSAPP'",
    [id],
  );
  assert.equal(whatsappJobs.rows[0].n, 0, "no WhatsApp 'approved' message may ever be enqueued for a cancelled pass");
});

test("a job already claimed (PROCESSING) when cancellation happens — voidPending can't reach it — is still caught by the worker's own re-check once reclaimed", async () => {
  const id = await createApprovedDraft();

  // Simulate a worker having claimed the job and then crashing before
  // finishing (locked_at goes stale) — voidPending only reaches
  // PENDING/FAILED rows, so cancellation below cannot touch this one
  // directly. It's only when a *different* worker legitimately reclaims
  // the stale lease that anything looks at this job again.
  const [claimed] = await claimBatch("SYSTEM", 1);
  assert.equal(claimed.entity_id, id);
  await pool.query("UPDATE notification_outbox SET locked_at = now() - interval '10 minutes' WHERE id = $1", [
    claimed.id,
  ]);

  const cancelled = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/cancel`, {
    token: tokens.admin,
    body: { reason: "Trip no longer required." },
  });
  assert.equal(cancelled.status, 200);

  // Reclaims the stale job and runs the handler — which must re-check
  // authoritative Gate Pass state and void it, not generate a document for
  // an already-cancelled pass just because the job itself looked runnable.
  await processOnce();

  const jobStatus = await pool.query("SELECT status FROM notification_outbox WHERE id = $1", [claimed.id]);
  assert.equal(jobStatus.rows[0].status, "VOID");

  const pdfFiles = await pool.query(
    "SELECT count(*)::int AS n FROM gate_pass_files WHERE gate_pass_id = $1 AND file_type = 'APPROVED_PDF'",
    [id],
  );
  assert.equal(pdfFiles.rows[0].n, 0);
});

test("a non-stale PROCESSING job (lease still fresh) is never stolen by another claim", async () => {
  const id = await createApprovedDraft();

  const [claimed] = await claimBatch("SYSTEM", 1);
  assert.equal(claimed.entity_id, id);

  // No time manipulation this time — locked_at is fresh (just claimed).
  const secondAttempt = await claimBatch("SYSTEM", 10);

  assert.ok(
    !secondAttempt.some((row) => row.id === claimed.id),
    "a job whose lease has not expired must not be reclaimed",
  );
});

test("a provider outcome of UNCERTAIN is recorded as UNCERTAIN, never coerced into SENT, and is not silently retried as fresh", async () => {
  const id = await createApprovedDraft();

  await enqueue(pool, [
    {
      channel: "WHATSAPP",
      eventType: "SEND_APPROVAL_DOCUMENT",
      entityType: "GATE_PASS",
      entityId: id,
      recipientPhone: "+923000000000",
      recipientSiteId: users.mainSite,
      payload: {},
      idempotencyKey: `whatsapp-uncertain:${id}`,
    },
  ]);

  const [claimed] = await claimBatch("WHATSAPP", 1);
  await markDelivered(pool, claimed.id, "UNCERTAIN", "provider-ref-123");

  const stored = await pool.query("SELECT status FROM notification_outbox WHERE id = $1", [claimed.id]);
  assert.equal(stored.rows[0].status, "UNCERTAIN");

  // claimBatch only reclaims PENDING/FAILED/stale-PROCESSING — an UNCERTAIN
  // row must never be picked up again as if it were a fresh send.
  const reclaimed = await claimBatch("WHATSAPP", 10);
  assert.ok(!reclaimed.some((row) => row.id === claimed.id));
});
