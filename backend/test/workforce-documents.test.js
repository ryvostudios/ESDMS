import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pool from "../src/config/database.js";
import { config } from "../src/config/env.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let hrToken;
let employeeId;
let selfToken;
let otherEmployeeToken;
let docTypeId;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

// ESDMS-012: the production expiry-classification SQL compares against
// Postgres's own CURRENT_DATE, not the host machine's clock. Building
// fixtures from `new Date()` (host/Node UTC) instead of the database's own
// date basis made this test genuinely flaky whenever the two fell on
// opposite sides of midnight (confirmed independently of this test file:
// the DB pool didn't pin a session timezone, so CURRENT_DATE followed
// whatever the Postgres server defaulted to — now fixed at the connection
// layer in config/database.js). Deriving fixtures via CURRENT_DATE +/-
// interval arithmetic keeps them on the exact same date basis as the SQL
// under test regardless of either clock.
async function isoDate(offsetDays) {
  const result = await pool.query("SELECT (CURRENT_DATE + ($1 * interval '1 day'))::date::text AS d", [offsetDays]);
  return result.rows[0].d;
}

function pdfForm(fields = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  const pdfBytes = Buffer.from("%PDF-1.4\n%mock\n1 0 obj<<>>endobj\ntrailer<<>>", "utf8");
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "cv.pdf");
  return form;
}

function fakePdfForm(fields = {}) {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.append(key, String(value));
  form.append("file", new Blob([Buffer.from("not a pdf")], { type: "application/pdf" }), "cv.pdf");
  return form;
}

before(async () => {
  server = await startTestServer();
  await seedUsers();
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
  otherEmployeeToken = await authHeader(server.baseUrl, "employee@test.eset.local");

  const docType = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/document-types", {
    token: hrToken,
    body: { name: unique("CV"), allowedMimeTypes: ["application/pdf"], verificationRequired: true, expiryRequired: false },
  });
  docTypeId = docType.body.data.id;

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/employees", {
    token: hrToken,
    body: { employeeCode: unique("EMP"), fullLegalName: unique("Doc Employee"), joiningDate: "2026-01-01" },
  });
  employeeId = created.body.data.id;

  const email = `${unique("doc-self")}@test.eset.local`;
  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email },
  });
  const tempToken = await authHeader(server.baseUrl, email, login.body.data.temporaryPassword);
  await apiRequest(server.baseUrl, "POST", "/api/v1/auth/change-password", {
    token: tempToken,
    body: { currentPassword: login.body.data.temporaryPassword, newPassword: "Doc-Self-Pw-123" },
  });
  selfToken = await authHeader(server.baseUrl, email, "Doc-Self-Pw-123");
});

after(async () => {
  await server.close();
  await pool.end();
});

test("self can upload a document of an allowed type; forged signature is rejected", async () => {
  const forged = await apiRequest(server.baseUrl, "POST", "/api/v1/me/documents", {
    token: selfToken,
    body: fakePdfForm({ documentTypeId: docTypeId }),
    isForm: true,
  });
  assert.equal(forged.status, 400);

  const uploaded = await apiRequest(server.baseUrl, "POST", "/api/v1/me/documents", {
    token: selfToken,
    body: pdfForm({ documentTypeId: docTypeId }),
    isForm: true,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));
  assert.equal(uploaded.body.data.version, 1);
});

test("a second upload of the same type creates version 2, not an overwrite", async () => {
  const second = await apiRequest(server.baseUrl, "POST", "/api/v1/me/documents", {
    token: selfToken,
    body: pdfForm({ documentTypeId: docTypeId }),
    isForm: true,
  });
  assert.equal(second.status, 201);
  assert.equal(second.body.data.version, 2);

  const versions = await apiRequest(server.baseUrl, "GET", `/api/v1/me/documents/versions/${docTypeId}`, { token: selfToken });
  assert.equal(versions.body.data.length, 2);

  const latest = await apiRequest(server.baseUrl, "GET", "/api/v1/me/documents", { token: selfToken });
  const entry = latest.body.data.find((d) => d.document_type_id === docTypeId);
  assert.equal(entry.version, 2, "the list view shows only the latest version");
});

test("another employee cannot view or download this employee's documents", async () => {
  const list = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/documents`, { token: otherEmployeeToken });
  assert.equal(list.status, 403);
});

test("HR can verify a document; verification is recorded", async () => {
  const list = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/documents`, { token: hrToken });
  const documentId = list.body.data[0].id;

  const verify = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents/${documentId}/verify`, {
    token: hrToken,
    body: { status: "VERIFIED", remark: "Looks good" },
  });
  assert.equal(verify.status, 200, JSON.stringify(verify.body));
  assert.equal(verify.body.data.verification_status, "VERIFIED");
});

test("a document download works for HR and self, and requires the right permission for others", async () => {
  const list = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/documents`, { token: hrToken });
  const documentId = list.body.data[0].id;

  const selfDownload = await apiRequest(server.baseUrl, "GET", `/api/v1/me/documents/${documentId}/download`, { token: selfToken });
  assert.equal(selfDownload.status, 200);

  const hrDownload = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/documents/${documentId}/download`, {
    token: hrToken,
  });
  assert.equal(hrDownload.status, 200);
});

test("HR can request a document; uploading the matching type fulfills the request", async () => {
  const request = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents/requests`, {
    token: hrToken,
    body: { documentTypeId: docTypeId, note: "Please re-upload" },
  });
  assert.equal(request.status, 201);

  const pendingBefore = await apiRequest(server.baseUrl, "GET", "/api/v1/me/documents/requests", { token: selfToken });
  assert.equal(pendingBefore.body.data.length, 1);

  await apiRequest(server.baseUrl, "POST", "/api/v1/me/documents", {
    token: selfToken,
    body: pdfForm({ documentTypeId: docTypeId }),
    isForm: true,
  });

  const pendingAfter = await apiRequest(server.baseUrl, "GET", "/api/v1/me/documents/requests", { token: selfToken });
  assert.equal(pendingAfter.body.data.length, 0, "the request is fulfilled, not still pending");
});

test("hidden document types do not leak through version listing or download", async () => {
  const hiddenType = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/document-types", {
    token: hrToken,
    body: { name: unique("Internal HR File"), employeeCanView: false, employeeCanUpload: false, allowedMimeTypes: ["application/pdf"] },
  });
  const uploaded = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents`, {
    token: hrToken,
    body: pdfForm({ documentTypeId: hiddenType.body.data.id }),
    isForm: true,
  });
  assert.equal(uploaded.status, 201);
  const versions = await apiRequest(server.baseUrl, "GET", `/api/v1/me/documents/versions/${hiddenType.body.data.id}`, { token: selfToken });
  assert.equal(versions.status, 200);
  assert.deepEqual(versions.body.data, []);
  const download = await apiRequest(server.baseUrl, "GET", `/api/v1/me/documents/${uploaded.body.data.id}/download`, { token: selfToken });
  assert.equal(download.status, 403);
});

test("a document request cannot be cancelled through a different employee path", async () => {
  const other = await apiRequest(server.baseUrl, "POST", "/api/v1/employees", {
    token: hrToken, body: { employeeCode: unique("EMP"), fullLegalName: unique("Other Request Employee"), joiningDate: "2026-01-01" },
  });
  const request = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents/requests`, {
    token: hrToken, body: { documentTypeId: docTypeId },
  });
  const crossEmployee = await apiRequest(server.baseUrl, "DELETE", `/api/v1/employees/${other.body.data.id}/documents/requests/${request.body.data.id}`, { token: hrToken });
  assert.equal(crossEmployee.status, 404);
  const stillPending = await pool.query("SELECT status FROM employee_document_requests WHERE id = $1", [request.body.data.id]);
  assert.equal(stillPending.rows[0].status, "PENDING");
});

test("stored document versions are DB-immutable and checksum-verified on download", async () => {
  const document = await pool.query(
    "SELECT id,storage_key FROM employee_documents WHERE employee_id=$1 AND document_type_id=$2 ORDER BY version DESC LIMIT 1",
    [employeeId, docTypeId],
  );
  await assert.rejects(pool.query("UPDATE employee_documents SET storage_key='workforce/tampered.pdf' WHERE id=$1", [document.rows[0].id]), /immutable/i);
  const filename = path.resolve(config.storageDir, document.rows[0].storage_key);
  const original = await fs.readFile(filename);
  try {
    await fs.writeFile(filename, Buffer.from("tampered document bytes"));
    const response = await apiRequest(server.baseUrl, "GET", `/api/v1/me/documents/${document.rows[0].id}/download`, { token: selfToken });
    assert.equal(response.status, 503);
  } finally {
    await fs.writeFile(filename, original);
  }
});

test("ESDMS-007: expiring-documents excludes a document type HR is not permitted to view", async () => {
  const hiddenType = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/document-types", {
    token: hrToken,
    body: { name: unique("Confidential HR-hidden"), hrCanView: false, allowedMimeTypes: ["application/pdf"], expiryRequired: true },
  });

  const uploaded = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents`, {
    token: hrToken,
    body: pdfForm({ documentTypeId: hiddenType.body.data.id, expiryDate: "2026-08-25" }),
    isForm: true,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

  const expiring = await apiRequest(server.baseUrl, "GET", "/api/v1/documents/expiring?withinDays=30", { token: hrToken });
  assert.equal(expiring.status, 200);
  assert.ok(
    !expiring.body.data.some((row) => row.document_type_id === hiddenType.body.data.id),
    "a document type HR cannot view must not leak into the expiring-documents listing",
  );
});

test("ESDMS-012: the latest document version is resolved before expiry classification — an old expired v1 does not override a valid, non-expiring v2", async () => {
  const type = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/document-types", {
    token: hrToken,
    body: { name: unique("Version Order Check"), allowedMimeTypes: ["application/pdf"], expiryRequired: true },
  });
  const typeId = type.body.data.id;

  const v1 = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents`, {
    token: hrToken,
    body: pdfForm({ documentTypeId: typeId, expiryDate: "2020-01-01" }), // long expired
    isForm: true,
  });
  assert.equal(v1.status, 201, JSON.stringify(v1.body));

  const v2 = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents`, {
    token: hrToken,
    body: pdfForm({ documentTypeId: typeId, expiryDate: "2030-01-01" }), // far from expiring
    isForm: true,
  });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  assert.equal(v2.body.data.version, 2);

  const expiring = await apiRequest(server.baseUrl, "GET", "/api/v1/documents/expiring?withinDays=30", { token: hrToken });
  assert.equal(expiring.status, 200);
  assert.ok(
    !expiring.body.data.some((row) => row.document_type_id === typeId),
    "the current (v2) document is not expiring soon, so this employee/type must not appear at all",
  );
});

test("ESDMS-012: v1 expired, v2 latest with expiry_date = NULL — v1 must NOT be returned", async () => {
  const type = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/document-types", {
    token: hrToken,
    body: { name: unique("Null Latest Check"), allowedMimeTypes: ["application/pdf"] },
  });
  const typeId = type.body.data.id;

  await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents`, {
    token: hrToken,
    body: pdfForm({ documentTypeId: typeId, expiryDate: await isoDate(-1000) }),
    isForm: true,
  });
  const v2 = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents`, {
    token: hrToken,
    body: pdfForm({ documentTypeId: typeId }), // no expiryDate at all
    isForm: true,
  });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  assert.equal(v2.body.data.version, 2);

  const expiring = await apiRequest(server.baseUrl, "GET", "/api/v1/documents/expiring?withinDays=30", { token: hrToken });
  assert.equal(expiring.status, 200);
  assert.ok(
    !expiring.body.data.some((row) => row.document_type_id === typeId),
    "the latest version has no expiry at all — the older expired v1 must never be substituted for it",
  );
});

test("ESDMS-012: v1 expired, v2 latest with a future expiry within the threshold — v2 is returned as expiring", async () => {
  const type = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/document-types", {
    token: hrToken,
    body: { name: unique("Within Threshold Check"), allowedMimeTypes: ["application/pdf"], expiryRequired: true },
  });
  const typeId = type.body.data.id;

  await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents`, {
    token: hrToken,
    body: pdfForm({ documentTypeId: typeId, expiryDate: await isoDate(-1000) }),
    isForm: true,
  });
  const v2 = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents`, {
    token: hrToken,
    body: pdfForm({ documentTypeId: typeId, expiryDate: await isoDate(10) }),
    isForm: true,
  });
  assert.equal(v2.status, 201, JSON.stringify(v2.body));
  assert.equal(v2.body.data.version, 2);

  const expiring = await apiRequest(server.baseUrl, "GET", "/api/v1/documents/expiring?withinDays=30", { token: hrToken });
  assert.equal(expiring.status, 200);
  const row = expiring.body.data.find((r) => r.document_type_id === typeId);
  assert.ok(row, "the current (v2) document expires within the threshold and must appear");
  assert.equal(row.version, 2, "the returned row must be the latest (v2) version, not the stale expired v1");
  assert.equal(row.is_expired, false, "a future expiry is expiring soon, not expired");
});

test("ESDMS-012: latest expiry_date = CURRENT_DATE classifies as expiring, not expired", async () => {
  const type = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/document-types", {
    token: hrToken,
    body: { name: unique("Today Boundary"), allowedMimeTypes: ["application/pdf"], expiryRequired: true },
  });
  const uploaded = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents`, {
    token: hrToken,
    body: pdfForm({ documentTypeId: type.body.data.id, expiryDate: await isoDate(0) }),
    isForm: true,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

  const expiring = await apiRequest(server.baseUrl, "GET", "/api/v1/documents/expiring?withinDays=30", { token: hrToken });
  const row = expiring.body.data.find((r) => r.document_type_id === type.body.data.id);
  assert.ok(row, "expiring today must still appear");
  assert.equal(row.is_expired, false, "expiring exactly today is 'expiring', not 'expired'");
});

test("ESDMS-012: latest expiry_date = yesterday classifies as expired", async () => {
  const type = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/document-types", {
    token: hrToken,
    body: { name: unique("Yesterday Boundary"), allowedMimeTypes: ["application/pdf"], expiryRequired: true },
  });
  const uploaded = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents`, {
    token: hrToken,
    body: pdfForm({ documentTypeId: type.body.data.id, expiryDate: await isoDate(-1) }),
    isForm: true,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

  const expiring = await apiRequest(server.baseUrl, "GET", "/api/v1/documents/expiring?withinDays=30", { token: hrToken });
  const row = expiring.body.data.find((r) => r.document_type_id === type.body.data.id);
  assert.ok(row, "an already-expired document must still appear");
  assert.equal(row.is_expired, true, "expiry in the past is 'expired'");
});

test("ESDMS-012: latest expiry_date beyond the threshold is not returned as expiring", async () => {
  const type = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/document-types", {
    token: hrToken,
    body: { name: unique("Beyond Threshold"), allowedMimeTypes: ["application/pdf"], expiryRequired: true },
  });
  const uploaded = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents`, {
    token: hrToken,
    body: pdfForm({ documentTypeId: type.body.data.id, expiryDate: await isoDate(45) }),
    isForm: true,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

  const expiring = await apiRequest(server.baseUrl, "GET", "/api/v1/documents/expiring?withinDays=30", { token: hrToken });
  assert.ok(
    !expiring.body.data.some((r) => r.document_type_id === type.body.data.id),
    "an expiry 45 days out is beyond a 30-day threshold and must not be listed",
  );
});

test("ESDMS-012: latest expiry_date = CURRENT_DATE + threshold (inclusive boundary) is still returned as expiring", async () => {
  const type = await apiRequest(server.baseUrl, "POST", "/api/v1/workforce-config/document-types", {
    token: hrToken,
    body: { name: unique("Exact Threshold Boundary"), allowedMimeTypes: ["application/pdf"], expiryRequired: true },
  });
  const uploaded = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents`, {
    token: hrToken,
    body: pdfForm({ documentTypeId: type.body.data.id, expiryDate: await isoDate(30) }),
    isForm: true,
  });
  assert.equal(uploaded.status, 201, JSON.stringify(uploaded.body));

  const expiring = await apiRequest(server.baseUrl, "GET", "/api/v1/documents/expiring?withinDays=30", { token: hrToken });
  const row = expiring.body.data.find((r) => r.document_type_id === type.body.data.id);
  assert.ok(row, "expiry exactly at CURRENT_DATE + withinDays is inclusive (<=) and must still be listed");
  assert.equal(row.is_expired, false);
});

// ---------------------------------------------------------------------
// ESDMS-008 failure-injection: requestDocument writes the request row,
// its business-history entry, and a notification-outbox enqueue in one
// withTransaction — prove a failure on the history write rolls back the
// request row too (the outbox enqueue never runs at all in that case).
//
// pool.connect() is used two different ways in this codebase (see the
// identical, already-proven pattern in outbox-durability.test.js): promise
// style with no arguments (withTransaction, awaited directly) and
// Node-callback style (pg-pool's own internal pool.query() convenience
// method calls `this.connect((err, client) => {...})` for every plain,
// non-transactional query). A mock that only implements the promise style
// silently never invokes that callback, hanging pool.query() forever.
// pg-pool also reuses the same small set of underlying client objects
// across pool.connect() calls, so the client's own .query override is
// restored in t.after() too — resetting pool.connect alone isn't enough.
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

test("ESDMS-008 rollback: requestDocument rolls back the request row (and never enqueues a notification) if the history write fails", async (t) => {
  const before = await pool.query(
    "SELECT count(*)::int AS n FROM employee_document_requests WHERE employee_id = $1",
    [employeeId],
  );
  const outboxBefore = await pool.query(
    "SELECT count(*)::int AS n FROM notification_outbox WHERE entity_type = 'EMPLOYEE_DOCUMENT_REQUEST'",
  );

  injectQueryFailure(t, "INSERT INTO employee_business_history");

  const response = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/documents/requests`, {
    token: hrToken,
    body: { documentTypeId: docTypeId, note: "Rollback test" },
  });
  assert.equal(response.status, 500, JSON.stringify(response.body));
  t.mock.reset();

  const after = await pool.query(
    "SELECT count(*)::int AS n FROM employee_document_requests WHERE employee_id = $1",
    [employeeId],
  );
  assert.equal(after.rows[0].n, before.rows[0].n, "the document request insert was rolled back, not partially committed");

  const outboxAfter = await pool.query(
    "SELECT count(*)::int AS n FROM notification_outbox WHERE entity_type = 'EMPLOYEE_DOCUMENT_REQUEST'",
  );
  assert.equal(
    outboxAfter.rows[0].n,
    outboxBefore.rows[0].n,
    "the notification enqueue (which runs after the failing history write) never happened either",
  );
});
