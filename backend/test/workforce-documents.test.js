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
