import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest, buildCreatePayload } from "./gate-pass-helpers.js";

let server;
let users;
let tokens;

before(async () => {
  server = await startTestServer();
  users = await seedUsers();

  tokens = {
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    otherSiteAdmin: await authHeader(server.baseUrl, "admin-othersite@test.eset.local"),
    otherSiteTeamLead: await authHeader(server.baseUrl, "teamlead-othersite@test.eset.local"),
    guard: await authHeader(server.baseUrl, "guard@test.eset.local"),
  };
});

after(async () => {
  await server.close();
  await pool.end();
});

test("TEAM_LEAD creating a Gate Pass with a different department id is server-overridden to their own department", async () => {
  const { status, body } = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentB }),
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
