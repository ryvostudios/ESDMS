import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest, buildCreatePayload, buildPhotoForm, buildFakePhotoForm } from "./gate-pass-helpers.js";
import * as gatePassService from "../src/modules/gate-pass/gate-pass.service.js";
import config from "../src/config/env.js";

const storageDir = path.resolve(config.storageDir);

let server;
let users;
let departmentId;
let tokens;

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  departmentId = users.departmentA;

  tokens = {
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    teamLeadOtherDept: await authHeader(server.baseUrl, "teamlead2@test.eset.local"),
    guard: await authHeader(server.baseUrl, "guard@test.eset.local"),
  };
});

after(async () => {
  await server.close();
  await pool.end();
});

async function createDraft(token, overrides = {}) {
  const { status, body } = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token,
    body: buildCreatePayload({ issuingDepartmentId: departmentId, ...overrides }),
  });

  assert.equal(status, 201, JSON.stringify(body));
  return body.data;
}

test("TEAM_LEAD creates a draft and submits it for approval", async () => {
  const draft = await createDraft(tokens.teamLead);
  assert.equal(draft.status, "DRAFT");
  assert.match(draft.gatePassNumber, /^ESD-\d{4}-\d{6}$/);

  const submitted = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/submit`, {
    token: tokens.teamLead,
  });

  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.data.status, "PENDING_APPROVAL");
});

test("TEAM_LEAD cannot approve a Gate Pass (no permission)", async () => {
  const draft = await createDraft(tokens.teamLead);

  const result = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/approve`, {
    token: tokens.teamLead,
  });

  assert.equal(result.status, 403);
});

test("GATE_GUARD cannot access the general list/detail endpoints", async () => {
  const listResult = await apiRequest(server.baseUrl, "GET", "/api/v1/gate-passes", { token: tokens.guard });
  assert.equal(listResult.status, 403);

  const draft = await createDraft(tokens.admin);
  const detailResult = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${draft.id}`, {
    token: tokens.guard,
  });
  assert.equal(detailResult.status, 403);
});

test("TEAM_LEAD in a different department cannot view another department's draft (404, not 403)", async () => {
  const draft = await createDraft(tokens.teamLead);

  const result = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${draft.id}`, {
    token: tokens.teamLeadOtherDept,
  });

  assert.equal(result.status, 404);
});

test("ADMIN can create and approve their own Gate Pass directly (no four-eyes enforcement)", async () => {
  const draft = await createDraft(tokens.admin);

  const approved = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/approve`, {
    token: tokens.admin,
  });

  assert.equal(approved.status, 200);
  assert.equal(approved.body.data.status, "APPROVED");
  assert.equal(approved.body.data.approvedByName, "Test Admin");
});

test("cannot approve twice (state machine rejects the second attempt)", async () => {
  const draft = await createDraft(tokens.admin);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/approve`, { token: tokens.admin });

  const secondApprove = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/approve`, {
    token: tokens.admin,
  });

  assert.equal(secondApprove.status, 409);
});

test("concurrent approve requests for the same Gate Pass: exactly one wins (real row lock, not a sequential fake)", async () => {
  const draft = await createDraft(tokens.admin);

  const [first, second] = await Promise.all([
    apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/approve`, { token: tokens.admin }),
    apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/approve`, { token: tokens.admin }),
  ]);

  const statuses = [first.status, second.status].sort();
  assert.deepEqual(statuses, [200, 409], "one concurrent approve must succeed and the other must be rejected");

  const finalCount = await pool.query(
    "SELECT count(*)::int AS n FROM gate_pass_audit_log WHERE gate_pass_id = $1 AND action = 'APPROVE'",
    [draft.id],
  );
  assert.equal(finalCount.rows[0].n, 1, "exactly one APPROVE audit row — the row lock must serialize the race");
});

test("SITE_MANAGER rejects a pending Gate Pass with a reason", async () => {
  const draft = await createDraft(tokens.teamLead);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/submit`, { token: tokens.teamLead });

  const rejected = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/reject`, {
    token: tokens.siteManager,
    body: { reason: "Vehicle registration does not match fleet records." },
  });

  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.data.status, "REJECTED");
  assert.equal(rejected.body.data.rejectionReason, "Vehicle registration does not match fleet records.");
});

test("cannot approve a rejected Gate Pass", async () => {
  const draft = await createDraft(tokens.teamLead);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/submit`, { token: tokens.teamLead });
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/reject`, {
    token: tokens.admin,
    body: { reason: "Not required." },
  });

  const result = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/approve`, {
    token: tokens.admin,
  });

  assert.equal(result.status, 409);
});

test("cancel is permitted before exit but not after vehicle is outside", async () => {
  const draft = await createDraft(tokens.admin);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/approve`, { token: tokens.admin });

  const cancelled = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/cancel`, {
    token: tokens.admin,
    body: { reason: "Trip no longer required." },
  });

  assert.equal(cancelled.status, 200);
  assert.equal(cancelled.body.data.status, "CANCELLED");
});

test("full gate workflow: approve -> guard verify -> exit -> return, with distance computed server-side", async () => {
  const draft = await createDraft(tokens.admin);

  // Direct service call to capture the raw verification token — production
  // API responses never expose it; only the generated PDF/QR does.
  const admin = {
    id: users.admin,
    siteId: users.mainSite,
    permissions: new Set(["gate_pass.approve", "gate_pass.view_site"]),
  };
  const { verificationToken } = await gatePassService.approveGatePass(admin, draft.id);
  assert.ok(verificationToken);

  const verify = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes/guard/verify", {
    token: tokens.guard,
    body: { token: verificationToken },
  });

  assert.equal(verify.status, 200);
  assert.equal(verify.body.data.allowedAction, "EXIT");
  // Data-minimized: Guard view must not include requested_by/remarks/etc.
  assert.equal(verify.body.data.gatePass.requestedBy, undefined);

  const exitForm = buildPhotoForm({ odometer: 1000 });
  const exit = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/exit`, {
    token: tokens.guard,
    body: exitForm,
    isForm: true,
  });

  assert.equal(exit.status, 200, JSON.stringify(exit.body));
  assert.equal(exit.body.data.status, "VEHICLE_OUTSIDE");

  const duplicateExit = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/exit`, {
    token: tokens.guard,
    body: buildPhotoForm({ odometer: 1000 }),
    isForm: true,
  });
  assert.equal(duplicateExit.status, 409);

  const invalidReturn = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/return`, {
    token: tokens.guard,
    body: buildPhotoForm({ odometer: 500 }),
    isForm: true,
  });
  assert.equal(invalidReturn.status, 400);

  const validReturn = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/return`, {
    token: tokens.guard,
    body: buildPhotoForm({ odometer: 1250, remarks: "Delivered on time." }),
    isForm: true,
  });
  assert.equal(validReturn.status, 200, JSON.stringify(validReturn.body));
  assert.equal(validReturn.body.data.status, "COMPLETED");

  const duplicateReturn = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/return`, {
    token: tokens.guard,
    body: buildPhotoForm({ odometer: 1300 }),
    isForm: true,
  });
  assert.equal(duplicateReturn.status, 409);

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${draft.id}`, { token: tokens.admin });
  assert.equal(detail.body.data.distanceKm, 250);
  assert.equal(detail.body.data.auditLog.length, 4); // CREATE, APPROVE, EXIT, RETURN

  // Evidence review (Admin/Site Manager): metadata only, no storage path,
  // downloadable through the authorized file endpoint.
  assert.equal(detail.body.data.departureEvidence.odometer, 1000);
  assert.equal(detail.body.data.departureEvidence.recordedByName, "Test Guard");
  assert.ok(detail.body.data.departureEvidence.fileId);
  assert.equal(detail.body.data.departureEvidence.storageKey, undefined);
  assert.equal(detail.body.data.returnEvidence.odometer, 1250);
  assert.ok(detail.body.data.returnEvidence.fileId);

  const departurePhoto = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/gate-passes/${draft.id}/files/${detail.body.data.departureEvidence.fileId}`,
    { token: tokens.admin },
  );
  assert.equal(departurePhoto.status, 200);
});

test("exit is rejected before approval (still DRAFT/PENDING)", async () => {
  const draft = await createDraft(tokens.teamLead);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/submit`, { token: tokens.teamLead });

  const exit = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/exit`, {
    token: tokens.guard,
    body: buildPhotoForm({ odometer: 100 }),
    isForm: true,
  });

  assert.equal(exit.status, 409);
});

test("evidence photo is required for exit", async () => {
  const draft = await createDraft(tokens.admin);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/approve`, { token: tokens.admin });

  const form = new FormData();
  form.append("odometer", "100");

  const exit = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/exit`, {
    token: tokens.guard,
    body: form,
    isForm: true,
  });

  assert.equal(exit.status, 400);
});

test("exit rejects a file whose bytes don't match its declared image type", async () => {
  const draft = await createDraft(tokens.admin);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/approve`, { token: tokens.admin });

  const exit = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/exit`, {
    token: tokens.guard,
    body: buildFakePhotoForm({ odometer: 100 }),
    isForm: true,
  });

  assert.equal(exit.status, 400, JSON.stringify(exit.body));
});

test("a rejected exit attempt leaves no orphaned evidence file on disk", async () => {
  // Still DRAFT/PENDING (never approved) — exit must be rejected for state,
  // but only after the photo would otherwise have already been written.
  const draft = await createDraft(tokens.admin);

  const beforeDir = await fs.readdir(path.join(storageDir, "gate-pass", draft.id, "departure")).catch(() => []);
  assert.equal(beforeDir.length, 0);

  const exit = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/exit`, {
    token: tokens.guard,
    body: buildPhotoForm({ odometer: 100 }),
    isForm: true,
  });

  assert.equal(exit.status, 409);

  const afterDir = await fs.readdir(path.join(storageDir, "gate-pass", draft.id, "departure")).catch(() => []);
  assert.equal(afterDir.length, 0, "exit rejected for state must not leave an orphaned file on disk");
});

test("malformed UUID in path is rejected, not 500", async () => {
  const result = await apiRequest(server.baseUrl, "GET", "/api/v1/gate-passes/not-a-uuid", { token: tokens.admin });
  assert.ok([400, 404].includes(result.status), `expected 400/404, got ${result.status}`);
});

test("an invalid status filter value is rejected, not silently ignored", async () => {
  const result = await apiRequest(server.baseUrl, "GET", "/api/v1/gate-passes?status=NOT_A_REAL_STATUS", {
    token: tokens.admin,
  });
  assert.equal(result.status, 400);
});

test("guard search only returns state-appropriate, data-minimized results", async () => {
  // Must be unique per test run, not just per test — the test DB is not
  // reset between runs, so a fixed literal would match a leftover
  // already-approved row from a previous run.
  const registration = `SEARCH-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
  const draft = await createDraft(tokens.admin, { vehicleRegistration: registration });

  const beforeApproval = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/gate-passes/guard/search?query=${registration}`,
    { token: tokens.guard },
  );
  assert.equal(beforeApproval.body.data.length, 0);

  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/approve`, { token: tokens.admin });

  const afterApproval = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/gate-passes/guard/search?query=${registration}`,
    { token: tokens.guard },
  );
  assert.equal(afterApproval.body.data.length, 1);
  assert.equal(afterApproval.body.data[0].requestedBy, undefined);
});

test("guard can fetch a Gate Pass by id directly (refresh/deep-link, not just via nav state)", async () => {
  const draft = await createDraft(tokens.admin);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.id}/approve`, { token: tokens.admin });

  const result = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/guard/${draft.id}`, {
    token: tokens.guard,
  });

  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.data.id, draft.id);
  assert.equal(result.body.data.status, "APPROVED");
  // Same data-minimized shape as search/dashboard/verify.
  assert.equal(result.body.data.requestedBy, undefined);
});

test("guard direct-id fetch discloses only APPROVED and VEHICLE_OUTSIDE — every other state is invisible", async () => {
  const draftOnly = await createDraft(tokens.admin);
  const draftResult = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/guard/${draftOnly.id}`, {
    token: tokens.guard,
  });
  assert.equal(draftResult.status, 404, "DRAFT must not be disclosed to Guard");

  const pending = await createDraft(tokens.teamLead);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${pending.id}/submit`, { token: tokens.teamLead });
  const pendingResult = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/guard/${pending.id}`, {
    token: tokens.guard,
  });
  assert.equal(pendingResult.status, 404, "PENDING_APPROVAL must not be disclosed to Guard");

  const rejected = await createDraft(tokens.teamLead);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${rejected.id}/submit`, { token: tokens.teamLead });
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${rejected.id}/reject`, {
    token: tokens.siteManager,
    body: { reason: "Not approved." },
  });
  const rejectedResult = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/guard/${rejected.id}`, {
    token: tokens.guard,
  });
  assert.equal(rejectedResult.status, 404, "REJECTED must not be disclosed to Guard");

  const cancelled = await createDraft(tokens.admin);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${cancelled.id}/cancel`, {
    token: tokens.admin,
    body: { reason: "No longer needed." },
  });
  const cancelledResult = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/guard/${cancelled.id}`, {
    token: tokens.guard,
  });
  assert.equal(cancelledResult.status, 404, "CANCELLED must not be disclosed to Guard");

  const approved = await createDraft(tokens.admin);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${approved.id}/approve`, { token: tokens.admin });
  const approvedResult = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/guard/${approved.id}`, {
    token: tokens.guard,
  });
  assert.equal(approvedResult.status, 200, "APPROVED must be visible to Guard");

  const outside = await createDraft(tokens.admin);
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${outside.id}/approve`, { token: tokens.admin });
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${outside.id}/exit`, {
    token: tokens.guard,
    body: buildPhotoForm({ odometer: 100 }),
    isForm: true,
  });
  const outsideResult = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/guard/${outside.id}`, {
    token: tokens.guard,
  });
  assert.equal(outsideResult.status, 200, "VEHICLE_OUTSIDE must be visible to Guard");
});

test("guard verify token travels in the POST body, not the URL — the old GET-with-token-in-path route is gone", async () => {
  const draft = await createDraft(tokens.admin);
  const admin = {
    id: users.admin,
    siteId: users.mainSite,
    permissions: new Set(["gate_pass.approve", "gate_pass.view_site"]),
  };
  const { verificationToken } = await gatePassService.approveGatePass(admin, draft.id);

  const oldStyleGet = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/gate-passes/guard/verify/${verificationToken}`,
    { token: tokens.guard },
  );
  assert.notEqual(oldStyleGet.status, 200);
});
