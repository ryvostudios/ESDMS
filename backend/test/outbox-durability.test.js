import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest, buildCreatePayload } from "./gate-pass-helpers.js";
import { processOnce } from "../src/shared/notifications/outbox.processor.js";
import { claimBatch, enqueue } from "../src/shared/notifications/outbox.repository.js";
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
