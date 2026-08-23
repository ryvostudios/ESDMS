import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers, login } from "./setup.js";
import { logServerError, hashForLogging } from "../src/shared/logging/safe-logger.js";
import { classifyOutboxFailure } from "../src/shared/notifications/outbox.processor.js";
import { markFailed } from "../src/shared/notifications/outbox.repository.js";
import { withTransaction } from "../src/shared/db/with-transaction.js";
import { enqueue } from "../src/shared/notifications/outbox.repository.js";

const SECRET_MESSAGE = "SUPER_SECRET_PROVIDER_TEXT";
const SECRET_PATH = "private/employee/secret-document.pdf";

let server;
let users;

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
});

after(async () => {
  await server.close();
  await pool.end();
});

function captureConsoleErrors(t) {
  const lines = [];
  t.mock.method(console, "error", (...args) => {
    lines.push(args.join(" "));
  });
  return lines;
}

test("ESDMS-021: raw provider error message and message-via-stack are absent from logs", (t) => {
  const lines = captureConsoleErrors(t);
  const error = new Error(SECRET_MESSAGE);

  logServerError(error, undefined, { operation: "storage.supabase.remove", provider: "supabase" });

  const output = lines.join("\n");
  assert.ok(!output.includes(SECRET_MESSAGE), "raw provider error.message must never appear, including inside the stack");
});

test("ESDMS-021: raw private storage key is absent from logs — only a non-reversible hash appears", (t) => {
  const lines = captureConsoleErrors(t);
  const error = new Error(SECRET_MESSAGE);

  logServerError(error, undefined, {
    operation: "storage.local.remove",
    storageKeyHash: hashForLogging(SECRET_PATH),
  });

  const output = lines.join("\n");
  assert.ok(!output.includes(SECRET_PATH), "the raw storage key/path must never be logged");
  assert.ok(output.includes(hashForLogging(SECRET_PATH)), "a safe, non-reversible reference remains for correlation");
});

test("ESDMS-021: durable outbox failure state never contains the raw thrown error.message", async () => {
  const entityId = crypto.randomUUID();
  const idempotencyKey = `safe-logging-test:${entityId}`;
  await withTransaction((client) =>
    enqueue(client, [
      {
        channel: "WHATSAPP",
        eventType: "GATE_PASS_APPROVED",
        entityType: "GATE_PASS",
        entityId,
        recipientPhone: "+10000000000",
        recipientSiteId: users.mainSite,
        idempotencyKey,
        payload: { storageKey: "x", filename: "x.pdf", caption: "x" },
      },
    ]),
  );
  const jobRow = await pool.query("SELECT id FROM notification_outbox WHERE idempotency_key = $1", [idempotencyKey]);
  const jobId = jobRow.rows[0].id;

  const providerError = new Error(SECRET_MESSAGE);
  await markFailed(pool, jobId, classifyOutboxFailure(providerError));

  const row = await pool.query("SELECT last_error FROM notification_outbox WHERE id = $1", [jobId]);
  assert.ok(!row.rows[0].last_error.includes(SECRET_MESSAGE), "the raw provider error text must never be persisted");
  assert.match(row.rows[0].last_error, /PROVIDER_ERROR/, "a safe, bounded classification remains available");
});

test("ESDMS-021: logout does not emit a duplicate operational log for the same failure, and the record is still produced with a consistent requestId", async (t) => {
  const { cookie } = await login(server.baseUrl, "hr@test.eset.local");

  const lines = captureConsoleErrors(t);
  const realQuery = pool.query.bind(pool);
  t.mock.method(pool, "query", (text, params) => {
    if (typeof text === "string" && text.includes("UPDATE users SET session_version")) {
      throw new Error(SECRET_MESSAGE);
    }
    return realQuery(text, params);
  });

  const response = await fetch(`${server.baseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: { Origin: "http://localhost:5173", Cookie: cookie },
  });
  t.mock.restoreAll();

  assert.equal(response.status, 503);
  const body = await response.json();
  assert.ok(body.error.requestId, "the failure is still surfaced with a correlation id (required evidence, not silently dropped)");

  const serverErrorLines = lines.filter((l) => l.includes("[server-error]"));
  assert.equal(serverErrorLines.length, 1, "exactly one operational log record for this one failed request — no accidental duplicate");
  assert.ok(
    serverErrorLines[0].includes(body.error.requestId),
    "the logged record's requestId matches the one returned to the client — consistent correlation, not two unrelated ids",
  );
  assert.ok(!serverErrorLines[0].includes(SECRET_MESSAGE), "the raw DB error text must never be logged");
});
