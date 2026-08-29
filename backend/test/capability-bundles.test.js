import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let users;
let ceoToken;
let adminToken;
let teamLeadToken;
let otherSiteTeamLeadToken;
let mainDemandId;
let foreignDemandId;

async function permissions(token) {
  const response = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return new Set(response.body.data.user.permissions);
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  adminToken = await authHeader(server.baseUrl, "admin@test.eset.local");
  teamLeadToken = await authHeader(server.baseUrl, "teamlead@test.eset.local");
  otherSiteTeamLeadToken = await authHeader(server.baseUrl, "teamlead-othersite@test.eset.local");

  const uom = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", { token: ceoToken });
  const mainCatalog = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { newItem: { name: `Bundle Main ${Date.now()}` }, defaultUomId: uom.body.data[0].id },
  });
  const foreignCatalog = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: otherSiteTeamLeadToken,
    body: { newItem: { name: `Bundle Foreign ${Date.now()}` }, defaultUomId: uom.body.data[0].id },
  });
  const mainDemand = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: { lines: [{ catalogEntryId: mainCatalog.body.data.id, quantity: 1 }] },
  });
  const foreignDemand = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: otherSiteTeamLeadToken,
    body: { lines: [{ catalogEntryId: foreignCatalog.body.data.id, quantity: 1 }] },
  });
  mainDemandId = mainDemand.body.data.demand.id;
  foreignDemandId = foreignDemand.body.data.demand.id;
});

after(async () => {
  await pool.query("DELETE FROM user_permission_bundle_assignments WHERE user_id = $1", [users.admin]);
  await pool.query("DELETE FROM user_permission_overrides WHERE user_id = $1", [users.admin]);
  await server.close();
  await pool.end();
});

test("Procurement Staff is reversible, site-bound, transparent, and explicit DENY still wins", async () => {
  const beforeAssignment = await apiRequest(server.baseUrl, "GET", "/api/v1/demands", { token: adminToken });
  assert.equal(beforeAssignment.status, 200);
  assert.deepEqual(beforeAssignment.body.data, [], "demand.view without organizational scope is a safe empty state");

  const unrelatedGrant = await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.admin}/permissions/gate_pass.verify`, {
    token: ceoToken,
    body: { effect: "GRANT", reason: "Unrelated guard cover" },
  });
  assert.equal(unrelatedGrant.status, 200);

  const assigned = await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.admin}/bundles/PROCUREMENT_STAFF`, {
    token: ceoToken,
    body: {},
  });
  assert.equal(assigned.status, 200, JSON.stringify(assigned.body));

  const overview = await apiRequest(server.baseUrl, "GET", `/api/v1/users/${users.admin}/permissions`, { token: ceoToken });
  assert.ok(overview.body.data.availableBundles.some((bundle) => bundle.code === "PROCUREMENT_STAFF"));
  assert.ok(overview.body.data.assignedBundles.some((bundle) => bundle.code === "PROCUREMENT_STAFF"));

  const bundled = await permissions(adminToken);
  for (const code of ["procurement.site_scope", "procurement.pricing", "procurement.view_prices", "procurement.purchase", "dc.manage"]) {
    assert.ok(bundled.has(code), `${code} comes from Procurement Staff`);
  }
  assert.ok(!bundled.has("demand.approve"), "formal approval is separate");
  assert.ok(!bundled.has("ipo.cancel"), "IPO cancellation is separate");

  const scopedList = await apiRequest(server.baseUrl, "GET", "/api/v1/demands?pageSize=100", { token: adminToken });
  assert.equal(scopedList.status, 200, JSON.stringify(scopedList.body));
  assert.ok(scopedList.body.data.some((demand) => demand.id === mainDemandId));
  assert.ok(!scopedList.body.data.some((demand) => demand.id === foreignDemandId), "another site stays concealed");
  const foreignDetail = await apiRequest(server.baseUrl, "GET", `/api/v1/demands/${foreignDemandId}`, { token: adminToken });
  assert.equal(foreignDetail.status, 404);

  const denyPrice = await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.admin}/permissions/procurement.view_prices`, {
    token: ceoToken,
    body: { effect: "DENY", reason: "Separation-of-duties test" },
  });
  assert.equal(denyPrice.status, 200);
  const denied = await permissions(adminToken);
  assert.ok(!denied.has("procurement.view_prices"), "explicit DENY overrides bundle membership");
  assert.ok(denied.has("procurement.site_scope"), "the DENY does not mutate unrelated bundle capabilities");

  const removed = await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.admin}/bundles/PROCUREMENT_STAFF`, {
    token: ceoToken,
  });
  assert.equal(removed.status, 200, JSON.stringify(removed.body));
  const afterRemoval = await permissions(adminToken);
  assert.ok(!afterRemoval.has("procurement.site_scope"));
  assert.ok(!afterRemoval.has("procurement.pricing"));
  assert.ok(!afterRemoval.has("procurement.purchase"));
  assert.ok(afterRemoval.has("gate_pass.verify"), "removing a bundle preserves an unrelated explicit grant");
});

test("Formal / Financial Approver stays separate from Procurement Staff", async () => {
  const assigned = await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.admin}/bundles/FORMAL_APPROVER`, {
    token: ceoToken,
    body: {},
  });
  assert.equal(assigned.status, 200);
  const current = await permissions(adminToken);
  assert.ok(current.has("demand.approve"));
  assert.ok(!current.has("procurement.site_scope"));
  assert.ok(!current.has("procurement.purchase"));
  const removed = await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.admin}/bundles/FORMAL_APPROVER`, { token: ceoToken });
  assert.equal(removed.status, 200);
});
