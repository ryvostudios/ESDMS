import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let users;
let teamLeadToken; // departmentA
let teamLeadOtherDeptToken; // departmentB
let employeeToken; // departmentA, view-only (material_catalog.view but not .manage)
let adminToken; // no department assigned
let ceoToken; // all-departments
let upperManagementToken; // view only, no manage, no all_departments by default
let guardToken;
let uomId;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  teamLeadToken = await authHeader(server.baseUrl, "teamlead@test.eset.local");
  teamLeadOtherDeptToken = await authHeader(server.baseUrl, "teamlead2@test.eset.local");
  employeeToken = await authHeader(server.baseUrl, "employee@test.eset.local");
  adminToken = await authHeader(server.baseUrl, "admin@test.eset.local");
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  upperManagementToken = await authHeader(server.baseUrl, "um@test.eset.local");
  guardToken = await authHeader(server.baseUrl, "guard@test.eset.local");

  const uomResponse = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: ceoToken,
  });
  uomId = uomResponse.body.data[0].id;
});

after(async () => {
  await server.close();
});

test("Gate Guard has no material catalog access at all", async () => {
  const list = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog", { token: guardToken });
  assert.equal(list.status, 403);

  const uom = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: guardToken,
  });
  assert.equal(uom.status, 403);
});

test("department-scoped Team Lead can create a catalog entry (new Company Item) in their own department", async () => {
  const itemName = unique("Cement");

  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { newItem: { name: itemName }, defaultUomId: uomId },
  });

  assert.equal(response.status, 201);
  assert.equal(response.body.data.department_id, users.departmentA);
  assert.equal(response.body.data.companyItem.name, itemName);
});

test("Team Lead cannot create a catalog entry for another department (explicit denial, not silent override)", async () => {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { departmentId: users.departmentB, newItem: { name: unique("Paint") }, defaultUomId: uomId },
  });

  assert.equal(response.status, 403);
});

test("Team Lead cannot view another department's catalog by requesting it explicitly", async () => {
  const response = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/material-catalog?departmentId=${users.departmentB}`,
    { token: teamLeadToken },
  );

  assert.equal(response.status, 403);
});

test("a department's own catalog listing never includes another department's entries", async () => {
  const itemName = unique("Binding Wire");
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { newItem: { name: itemName }, defaultUomId: uomId },
  });
  assert.equal(created.status, 201);

  const otherDeptList = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog", {
    token: teamLeadOtherDeptToken,
  });
  assert.equal(otherDeptList.status, 200);
  assert.ok(!otherDeptList.body.data.some((row) => row.item_name === itemName));

  const ownDeptList = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog", { token: teamLeadToken });
  assert.equal(ownDeptList.status, 200);
  assert.ok(ownDeptList.body.data.some((row) => row.item_name === itemName));
});

test("Team Lead cannot archive another department's catalog entry (404, not 403 — data-minimized)", async () => {
  const itemName = unique("Transformer Oil");
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { newItem: { name: itemName }, defaultUomId: uomId },
  });
  const entryId = created.body.data.id;

  const response = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/${entryId}`, {
    token: teamLeadOtherDeptToken,
    body: { isActive: false },
  });

  assert.equal(response.status, 404);
});

test("a view-only Employee can list the catalog but cannot add a material", async () => {
  const list = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog", { token: employeeToken });
  assert.equal(list.status, 200);

  const create = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: employeeToken,
    body: { newItem: { name: unique("WD-40") }, defaultUomId: uomId },
  });
  assert.equal(create.status, 403);
});

test("adding the same Company Item to the same department's catalog twice is a conflict", async () => {
  const itemName = unique("PVC Pipe");
  const first = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { newItem: { name: itemName }, defaultUomId: uomId },
  });
  assert.equal(first.status, 201);
  const companyItemId = first.body.data.company_item_id;

  const second = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { companyItemId, defaultUomId: uomId },
  });
  assert.equal(second.status, 409);
});

test("company-item search is scoped and annotates department-catalog membership correctly", async () => {
  const itemName = unique("Bearing Assembly");
  await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { newItem: { name: itemName }, defaultUomId: uomId },
  });

  const ownSearch = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/material-catalog/company-items/search?q=${encodeURIComponent(itemName)}`,
    { token: teamLeadToken },
  );
  assert.equal(ownSearch.status, 200);
  const ownMatch = ownSearch.body.data.find((row) => row.name === itemName);
  assert.equal(ownMatch.in_department_catalog, true);

  const otherSearch = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/material-catalog/company-items/search?q=${encodeURIComponent(itemName)}`,
    { token: teamLeadOtherDeptToken },
  );
  assert.equal(otherSearch.status, 200);
  const otherMatch = otherSearch.body.data.find((row) => row.name === itemName);
  assert.equal(otherMatch.in_department_catalog, false);
});

test("an actor with no department assigned sees an empty catalog rather than every department's", async () => {
  const response = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog", { token: adminToken });
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.data, []);
  assert.equal(response.body.meta.total, 0);
});

test("an actor with no department assigned cannot create a catalog entry without specifying one", async () => {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: adminToken,
    body: { newItem: { name: unique("Diesel") }, defaultUomId: uomId },
  });
  assert.equal(response.status, 403);
});

test("an all-departments actor (CEO) can view and manage any department's catalog explicitly", async () => {
  const list = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/material-catalog?departmentId=${users.departmentB}`,
    { token: ceoToken },
  );
  assert.equal(list.status, 200);

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: ceoToken,
    body: { departmentId: users.departmentB, newItem: { name: unique("Grease") }, defaultUomId: uomId },
  });
  assert.equal(created.status, 201);
  assert.equal(created.body.data.department_id, users.departmentB);
});

test("Upper Management's broad view does not by itself grant catalog editing authority", async () => {
  // UM holds material_catalog.view only by default (no .manage at all —
  // mirrors Workforce's UPPER_MANAGEMENT baseline, which never includes a
  // full-editing permission by default either).
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: upperManagementToken,
    body: { departmentId: users.departmentA, newItem: { name: unique("Rebar") }, defaultUomId: uomId },
  });

  assert.equal(response.status, 403);
});

test("Upper Management does not receive material_catalog.all_departments by default (action authority and scope authority are separate)", async () => {
  // Same request a genuine all-departments actor (CEO — see the CEO test
  // above) is allowed to make explicitly; UM must be denied it, proving
  // "broad viewing per existing governance" was not silently widened into
  // "every department's catalog" for this module.
  const response = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/material-catalog?departmentId=${users.departmentA}`,
    { token: upperManagementToken },
  );

  assert.equal(response.status, 403);
});

test("a similarly named new material warns via possibleDuplicates but is not blocked", async () => {
  const baseName = unique("Cement");
  const first = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { newItem: { name: baseName }, defaultUomId: uomId },
  });
  assert.equal(first.status, 201);

  // A distinct, legitimately different material whose name merely
  // contains the first one — must succeed (not hard-blocked) and surface
  // the near-match as a hint, not an error.
  const second = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { newItem: { name: `${baseName} Grade A` }, defaultUomId: uomId },
  });

  assert.equal(second.status, 201);
  assert.ok(second.body.meta.possibleDuplicates.some((row) => row.name === baseName));
  assert.notEqual(second.body.data.company_item_id, first.body.data.company_item_id);
});

test("create requires exactly one of companyItemId or newItem", async () => {
  const neither = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { defaultUomId: uomId },
  });
  assert.equal(neither.status, 400);

  const both = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { defaultUomId: uomId, companyItemId: "00000000-0000-0000-0000-000000000000", newItem: { name: "X" } },
  });
  assert.equal(both.status, 400);
});

test("Company Item metadata/lifecycle is company-wide, non-destructive, and blocked while any catalog link is active", async () => {
  const originalName = unique("Company Item Lifecycle");
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: ceoToken,
    body: { departmentId: users.departmentA, newItem: { name: originalName }, defaultUomId: uomId },
  });
  assert.equal(created.status, 201);
  const companyItemId = created.body.data.company_item_id;
  const entryId = created.body.data.id;

  const scopedEdit = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/company-items/${companyItemId}`, {
    token: teamLeadToken,
    body: { name: `${originalName} unauthorized` },
  });
  assert.equal(scopedEdit.status, 403);

  const unsafeArchive = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/company-items/${companyItemId}`, {
    token: ceoToken,
    body: { isActive: false },
  });
  assert.equal(unsafeArchive.status, 409);
  assert.match(unsafeArchive.body.error.message, /every active department catalog/i);

  const removeFromCatalog = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/${entryId}`, {
    token: ceoToken,
    body: { isActive: false },
  });
  assert.equal(removeFromCatalog.status, 200);

  const updatedName = `${originalName} Updated`;
  const safeArchive = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/company-items/${companyItemId}`, {
    token: ceoToken,
    body: { name: updatedName, description: "Safe global metadata", isActive: false },
  });
  assert.equal(safeArchive.status, 200);
  assert.equal(safeArchive.body.data.name, updatedName);
  assert.equal(safeArchive.body.data.is_active, false);

  const blockedCatalogRestore = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/${entryId}`, {
    token: ceoToken,
    body: { isActive: true },
  });
  assert.equal(blockedCatalogRestore.status, 409);
  assert.match(blockedCatalogRestore.body.error.message, /reactivate the Company Item/i);

  const reactivate = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/company-items/${companyItemId}`, {
    token: ceoToken,
    body: { isActive: true },
  });
  assert.equal(reactivate.status, 200);
  assert.equal(reactivate.body.data.is_active, true);

  const allRows = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/material-catalog?departmentId=${users.departmentA}&includeInactive=true&search=${encodeURIComponent(updatedName)}`,
    { token: ceoToken },
  );
  assert.equal(allRows.status, 200);
  const row = allRows.body.data.find((candidate) => candidate.company_item_id === companyItemId);
  assert.equal(row.item_name, updatedName);
  assert.equal(row.is_active, false, "reactivating a Company Item must not silently restore department catalog links");
});
