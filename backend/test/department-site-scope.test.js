import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest, buildCreatePayload, buildPhotoForm } from "./gate-pass-helpers.js";

let server;
let users;
let tokens;

before(async () => {
  server = await startTestServer();
  users = await seedUsers();

  tokens = {
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    otherSiteAdmin: await authHeader(server.baseUrl, "admin-othersite@test.eset.local"),
    otherSiteTeamLead: await authHeader(server.baseUrl, "teamlead-othersite@test.eset.local"),
    guard: await authHeader(server.baseUrl, "guard@test.eset.local"),
    otherSiteGuard: await authHeader(server.baseUrl, "guard-othersite@test.eset.local"),
  };
});

after(async () => {
  await server.close();
  await pool.end();
});

test("TEAM_LEAD submitting a different department id on create is explicitly rejected, not silently overridden", async () => {
  const vehicleRegistration = `TL-REJECT-${Date.now()}`;

  const { status, body } = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentB, vehicleRegistration }),
  });

  assert.equal(status, 403, JSON.stringify(body));

  const count = await pool.query("SELECT count(*)::int AS n FROM gate_passes WHERE vehicle_registration = $1", [
    vehicleRegistration,
  ]);
  assert.equal(count.rows[0].n, 0, "the rejected create must not have inserted a row under either department");
});

test("TEAM_LEAD submitting their own department id on create is accepted", async () => {
  const { status, body } = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA }),
  });

  assert.equal(status, 201, JSON.stringify(body));

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${body.data.id}`, {
    token: tokens.teamLead,
  });
  assert.equal(detail.body.data.issuingDepartmentId, users.departmentA);
});

test("TEAM_LEAD cannot move their own draft into another department (explicit denial, not silent override)", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA }),
  });

  const patched = await apiRequest(server.baseUrl, "PATCH", `/api/v1/gate-passes/${created.body.data.id}`, {
    token: tokens.teamLead,
    body: { issuingDepartmentId: users.departmentB },
  });

  assert.equal(patched.status, 403);
});

test("a rejected department on create leaves no ghost row (invalid department id is rejected, nothing persisted)", async () => {
  const { status } = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.otherSiteAdmin,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA }),
  });

  // departmentA belongs to the main site, not the actor's own site.
  assert.equal(status, 400);

  const count = await pool.query(
    "SELECT count(*)::int AS n FROM gate_passes WHERE issuing_department_id = $1 AND site_id = $2",
    [users.departmentA, users.otherSite],
  );

  assert.equal(count.rows[0].n, 0);
});

test("a Gate Pass on one site is invisible (404) to an ADMIN on another site", async () => {
  const draft = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA }),
  });

  const crossSite = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${draft.body.data.id}`, {
    token: tokens.otherSiteAdmin,
  });

  assert.equal(crossSite.status, 404);
});

test("a Team Lead on another site cannot submit/approve a Gate Pass belonging to a different site", async () => {
  const draft = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA }),
  });

  const submit = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${draft.body.data.id}/submit`, {
    token: tokens.otherSiteTeamLead,
  });

  assert.equal(submit.status, 404);
});

test("departments listing is scoped to the caller's own site", async () => {
  const mainSiteDepartments = await apiRequest(server.baseUrl, "GET", "/api/v1/departments", {
    token: tokens.teamLead,
  });
  const otherSiteDepartments = await apiRequest(server.baseUrl, "GET", "/api/v1/departments", {
    token: tokens.otherSiteAdmin,
  });

  assert.ok(mainSiteDepartments.body.data.every((d) => d.id !== users.otherSiteDepartment));
  assert.ok(otherSiteDepartments.body.data.some((d) => d.id === users.otherSiteDepartment));
});

test("GATE_GUARD cannot list department master data — it has no create/edit permission", async () => {
  const result = await apiRequest(server.baseUrl, "GET", "/api/v1/departments", { token: tokens.guard });

  assert.equal(result.status, 403);
});

test("guard direct-id fetch is invisible across sites, even for an APPROVED Gate Pass", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.admin,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA }),
  });
  const gatePassId = created.body.data.id;
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${gatePassId}/approve`, { token: tokens.admin });

  const sameSite = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/guard/${gatePassId}`, {
    token: tokens.guard,
  });
  assert.equal(sameSite.status, 200);

  const crossSite = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/guard/${gatePassId}`, {
    token: tokens.otherSiteGuard,
  });
  assert.equal(crossSite.status, 404);
});

async function createExitedGatePass(actorToken, departmentId) {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: actorToken,
    body: buildCreatePayload({ issuingDepartmentId: departmentId }),
  });
  const gatePassId = created.body.data.id;
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${gatePassId}/approve`, { token: actorToken });
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${gatePassId}/exit`, {
    token: tokens.guard,
    body: buildPhotoForm({ odometer: 100 }),
    isForm: true,
  });
  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${gatePassId}`, { token: actorToken });
  return { gatePassId, fileId: detail.body.data.departureEvidence.fileId };
}

test("evidence file IDOR: a file id that belongs to a different Gate Pass is denied, not served", async () => {
  const passA = await createExitedGatePass(tokens.admin, users.departmentA);
  const passB = await createExitedGatePass(tokens.admin, users.departmentA);

  const mismatched = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/gate-passes/${passB.gatePassId}/files/${passA.fileId}`,
    { token: tokens.admin },
  );
  assert.equal(mismatched.status, 404);
});

test("evidence file download is denied cross-site even with a correct gatePassId/fileId pair", async () => {
  const pass = await createExitedGatePass(tokens.admin, users.departmentA);

  const crossSite = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/gate-passes/${pass.gatePassId}/files/${pass.fileId}`,
    { token: tokens.otherSiteAdmin },
  );
  assert.equal(crossSite.status, 404);
});
