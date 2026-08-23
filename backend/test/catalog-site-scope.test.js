import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let users;
let hrToken; // site-scoped (mainSite), holds employees.create
let ceoToken; // all-site
let posMainId;
let posOtherId;
let inactivePosMainId;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");

  const dupCode = unique("ENG-DUP");
  const dupName = unique("Engineer");

  // Same code/name deliberately reused across two different sites — must
  // stay separated by id/site, never merged/ambiguous (item #6). (code,
  // name) are each unique per-site in the schema, so the same values are
  // only reusable across two *different* sites, which is exactly the case
  // under test.
  const posMain = await apiRequest(server.baseUrl, "POST", "/api/v1/positions", {
    token: ceoToken,
    body: { code: dupCode, name: dupName, siteId: users.mainSite },
  });
  posMainId = posMain.body.data.id;

  const posOther = await apiRequest(server.baseUrl, "POST", "/api/v1/positions", {
    token: ceoToken,
    body: { code: dupCode, name: dupName, siteId: users.otherSite },
  });
  posOtherId = posOther.body.data.id;

  const inactivePos = await apiRequest(server.baseUrl, "POST", "/api/v1/positions", {
    token: ceoToken,
    body: { code: unique("ARCHIVED"), name: unique("Retired Role"), siteId: users.mainSite },
  });
  inactivePosMainId = inactivePos.body.data.id;
  await apiRequest(server.baseUrl, "PATCH", `/api/v1/positions/${inactivePosMainId}`, {
    token: ceoToken,
    body: { isActive: false },
  });
});

after(async () => {
  await server.close();
  await pool.end();
});

test("site-scoped actor: active Department/Position selectors return their own site only, ignoring any siteId query param", async () => {
  const departments = await apiRequest(server.baseUrl, "GET", "/api/v1/departments", { token: hrToken });
  assert.equal(departments.status, 200);
  assert.ok(departments.body.data.every((d) => d.id !== users.otherSiteDepartment));
  assert.ok(departments.body.data.some((d) => d.id === users.departmentA));

  const positions = await apiRequest(server.baseUrl, "GET", "/api/v1/positions", { token: hrToken });
  assert.equal(positions.status, 200);
  assert.ok(positions.body.data.some((p) => p.id === posMainId));
  assert.ok(positions.body.data.every((p) => p.id !== posOtherId));
});

test("site-scoped actor: supplying another site's id does not expand scope", async () => {
  const departments = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/departments?siteId=${users.otherSite}`,
    { token: hrToken },
  );
  assert.equal(departments.status, 403, JSON.stringify(departments.body));

  const positions = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/positions?siteId=${users.otherSite}`,
    { token: hrToken },
  );
  assert.equal(positions.status, 403, JSON.stringify(positions.body));
});

test("all-site actor: explicitly requesting Site A returns only Site A's active options", async () => {
  const positions = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/positions?siteId=${users.mainSite}`,
    { token: ceoToken },
  );
  assert.equal(positions.status, 200);
  assert.ok(positions.body.data.some((p) => p.id === posMainId));
  assert.ok(positions.body.data.every((p) => p.id !== posOtherId));

  const departments = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/departments?siteId=${users.mainSite}`,
    { token: ceoToken },
  );
  assert.ok(departments.body.data.some((d) => d.id === users.departmentA));
  assert.ok(departments.body.data.every((d) => d.id !== users.otherSiteDepartment));
});

test("all-site actor: explicitly requesting Site B returns only Site B's active options", async () => {
  const positions = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/positions?siteId=${users.otherSite}`,
    { token: ceoToken },
  );
  assert.equal(positions.status, 200);
  assert.ok(positions.body.data.some((p) => p.id === posOtherId));
  assert.ok(positions.body.data.every((p) => p.id !== posMainId));

  const departments = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/departments?siteId=${users.otherSite}`,
    { token: ceoToken },
  );
  assert.ok(departments.body.data.some((d) => d.id === users.otherSiteDepartment));
  assert.ok(departments.body.data.every((d) => d.id !== users.departmentA));
});

test("all-site actor: no siteId supplied is rejected rather than silently defaulting", async () => {
  const positions = await apiRequest(server.baseUrl, "GET", "/api/v1/positions", { token: ceoToken });
  assert.equal(positions.status, 400, JSON.stringify(positions.body));
});

test("inactive entries are excluded from the active selector", async () => {
  const positions = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/positions?siteId=${users.mainSite}`,
    { token: ceoToken },
  );
  assert.ok(positions.body.data.every((p) => p.id !== inactivePosMainId));
});

test("duplicate position code/name across two sites remain correctly separated by id/site", async () => {
  const mainPositions = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/positions?siteId=${users.mainSite}`,
    { token: ceoToken },
  );
  const otherPositions = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/positions?siteId=${users.otherSite}`,
    { token: ceoToken },
  );

  const mainMatch = mainPositions.body.data.find((p) => p.id === posMainId);
  const otherMatch = otherPositions.body.data.find((p) => p.id === posOtherId);
  assert.ok(mainMatch && otherMatch, "both same-named/coded positions are individually resolvable");
  assert.notEqual(mainMatch.id, otherMatch.id);

  // Neither selector leaks the other site's row despite the identical name/code.
  assert.ok(mainPositions.body.data.every((p) => p.id !== posOtherId));
  assert.ok(otherPositions.body.data.every((p) => p.id !== posMainId));
});

test("management list still shows all sites, clearly site-labelled, unaffected by the selector fix", async () => {
  const managed = await apiRequest(server.baseUrl, "GET", "/api/v1/positions/manage", { token: ceoToken });
  assert.equal(managed.status, 200);
  const rows = managed.body.data.filter((p) => p.id === posMainId || p.id === posOtherId);
  assert.equal(rows.length, 2);
  assert.ok(rows.every((r) => r.site_name), "each row carries its site's name for disambiguation");
});
