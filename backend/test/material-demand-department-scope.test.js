import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let users;
let teamLeadToken; // departmentA
let teamLeadOtherDeptToken; // departmentB
let otherSiteTeamLeadToken; // otherSite / otherSiteDepartment
let employeeToken; // departmentA, view-only
let adminToken; // no department assigned
let ceoToken; // all-departments
let upperManagementToken; // view only, site-scoped
let guardToken;
let uomId;
let catalogEntryA; // department_material_catalog id in departmentA
let catalogEntryB; // department_material_catalog id in departmentB

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

async function addCatalogEntry(token, name) {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token,
    body: { newItem: { name: unique(name) }, defaultUomId: uomId },
  });
  assert.equal(response.status, 201);
  return response.body.data.id;
}

function demandPayload(catalogEntryId, overrides = {}) {
  return {
    lines: [{ catalogEntryId, quantity: 10 }],
    ...overrides,
  };
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  teamLeadToken = await authHeader(server.baseUrl, "teamlead@test.eset.local");
  teamLeadOtherDeptToken = await authHeader(server.baseUrl, "teamlead2@test.eset.local");
  otherSiteTeamLeadToken = await authHeader(server.baseUrl, "teamlead-othersite@test.eset.local");
  employeeToken = await authHeader(server.baseUrl, "employee@test.eset.local");
  adminToken = await authHeader(server.baseUrl, "admin@test.eset.local");
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  upperManagementToken = await authHeader(server.baseUrl, "um@test.eset.local");
  guardToken = await authHeader(server.baseUrl, "guard@test.eset.local");

  const uomResponse = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: ceoToken,
  });
  uomId = uomResponse.body.data[0].id;

  catalogEntryA = await addCatalogEntry(teamLeadToken, "Cement");
  catalogEntryB = await addCatalogEntry(teamLeadOtherDeptToken, "Paint");
});

after(async () => {
  await server.close();
});

// --- A. Department isolation ------------------------------------------

test("a department Demand creator can create and view their own Demand", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: demandPayload(catalogEntryA),
  });

  assert.equal(created.status, 201);
  assert.equal(created.body.data.demand.department_id, users.departmentA);
  assert.equal(created.body.data.demand.status, "DRAFT");
  assert.match(created.body.data.demand.demand_number, /^DL-\d{4}-\d{6}$/);
  assert.equal(created.body.data.lines[0].item_name_snapshot, created.body.data.lines[0].item_name_snapshot);

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/demands/${created.body.data.demand.id}`, {
    token: teamLeadToken,
  });
  assert.equal(detail.status, 200);
});

test("Team Lead cannot create a Demand for another department by forging departmentId", async () => {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: demandPayload(catalogEntryA, { departmentId: users.departmentB }),
  });

  assert.equal(response.status, 403);
});

test("Team Lead cannot list another department's Demands by requesting it explicitly", async () => {
  const response = await apiRequest(server.baseUrl, "GET", `/api/v1/demands?departmentId=${users.departmentB}`, {
    token: teamLeadToken,
  });

  assert.equal(response.status, 403);
});

test("Team Lead cannot load, edit, or submit another department's Demand by UUID", async () => {
  const otherDeptDemand = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadOtherDeptToken,
    body: demandPayload(catalogEntryB),
  });
  const otherId = otherDeptDemand.body.data.demand.id;

  const view = await apiRequest(server.baseUrl, "GET", `/api/v1/demands/${otherId}`, { token: teamLeadToken });
  assert.equal(view.status, 404);

  const edit = await apiRequest(server.baseUrl, "PATCH", `/api/v1/demands/${otherId}`, {
    token: teamLeadToken,
    body: { note: "trying to edit" },
  });
  assert.equal(edit.status, 404);

  const submit = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${otherId}/submit`, {
    token: teamLeadToken,
  });
  assert.equal(submit.status, 404);
});

// --- B. Site isolation --------------------------------------------------

test("an actor at a different site cannot view a Demand across the site boundary", async () => {
  const mainSiteDemand = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: demandPayload(catalogEntryA),
  });

  const crossSiteView = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/demands/${mainSiteDemand.body.data.demand.id}`,
    { token: otherSiteTeamLeadToken },
  );
  assert.equal(crossSiteView.status, 404);

  const crossSiteList = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/demands?departmentId=${users.departmentA}`,
    { token: otherSiteTeamLeadToken },
  );
  assert.equal(crossSiteList.status, 403);
});

// --- C. Capabilities ------------------------------------------------------

test("a view-only Employee can view but not create a Demand", async () => {
  const list = await apiRequest(server.baseUrl, "GET", "/api/v1/demands", { token: employeeToken });
  assert.equal(list.status, 200);

  const create = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: employeeToken,
    body: demandPayload(catalogEntryA),
  });
  assert.equal(create.status, 403);
});

test("Gate Guard has no Demand access at all", async () => {
  const list = await apiRequest(server.baseUrl, "GET", "/api/v1/demands", { token: guardToken });
  assert.equal(list.status, 403);

  const create = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: guardToken,
    body: demandPayload(catalogEntryA),
  });
  assert.equal(create.status, 403);
});

test("an all-departments actor (CEO) can create, view, and edit across departments explicitly", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: ceoToken,
    body: demandPayload(catalogEntryB, { departmentId: users.departmentB }),
  });
  assert.equal(created.status, 201);

  const edited = await apiRequest(server.baseUrl, "PATCH", `/api/v1/demands/${created.body.data.demand.id}`, {
    token: ceoToken,
    body: { note: "CEO note" },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.demand.note, "CEO note");
});

test("Upper Management's default view access does not grant creation authority", async () => {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: upperManagementToken,
    body: demandPayload(catalogEntryA, { departmentId: users.departmentA }),
  });
  assert.equal(response.status, 403);
});

test("an explicit DENY override wins even though the role grants the permission", async () => {
  const permissionId = await pool.query("SELECT id FROM permissions WHERE code = 'demand.submit'");
  await pool.query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by_user_id)
     VALUES ($1, $2, 'DENY', $3)
     ON CONFLICT (user_id, permission_id) DO UPDATE SET effect = 'DENY'`,
    [users.teamLead, permissionId.rows[0].id, users.admin],
  );

  try {
    const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
      token: teamLeadToken,
      body: demandPayload(catalogEntryA),
    });
    assert.equal(created.status, 201, "create is unaffected by a DENY on a different permission");

    const submitted = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${created.body.data.demand.id}/submit`, {
      token: teamLeadToken,
    });
    assert.equal(submitted.status, 403, "an explicit DENY on demand.submit overrides the TEAM_LEAD role grant");
  } finally {
    await pool.query("DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission_id = $2", [
      users.teamLead,
      permissionId.rows[0].id,
    ]);
  }
});

// --- D. Draft integrity -----------------------------------------------

test("a Demand with zero lines cannot be submitted", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: { lines: [] },
  });
  assert.equal(created.status, 201);

  const submitted = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${created.body.data.demand.id}/submit`, {
    token: teamLeadToken,
  });
  assert.equal(submitted.status, 400);
});

test("a non-positive quantity is rejected", async () => {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: { lines: [{ catalogEntryId: catalogEntryA, quantity: 0 }] },
  });
  assert.equal(response.status, 400);
});

test("duplicate lines for the same catalog entry are rejected", async () => {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: { lines: [{ catalogEntryId: catalogEntryA, quantity: 5 }, { catalogEntryId: catalogEntryA, quantity: 3 }] },
  });
  assert.equal(response.status, 400);
});

test("a line referencing another department's catalog entry is rejected", async () => {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: demandPayload(catalogEntryB), // belongs to departmentB, actor is departmentA
  });
  assert.equal(response.status, 400);
});

test("a line referencing a nonexistent catalog entry is rejected", async () => {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: { lines: [{ catalogEntryId: "00000000-0000-0000-0000-000000000000", quantity: 1 }] },
  });
  assert.equal(response.status, 400);
});

test("editing is rejected once a Demand has been submitted", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: demandPayload(catalogEntryA),
  });
  const id = created.body.data.demand.id;

  const submitted = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/submit`, { token: teamLeadToken });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.data.demand.status, "PENDING_INITIAL_REVIEW");

  const edit = await apiRequest(server.baseUrl, "PATCH", `/api/v1/demands/${id}`, {
    token: teamLeadToken,
    body: { note: "too late" },
  });
  assert.equal(edit.status, 409);
});

test("a replayed Submit does not transition twice or duplicate notifications", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: demandPayload(catalogEntryA),
  });
  const id = created.body.data.demand.id;

  const first = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/submit`, { token: teamLeadToken });
  assert.equal(first.status, 200);

  const second = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/submit`, { token: teamLeadToken });
  assert.equal(second.status, 409);

  const notifications = await pool.query(
    "SELECT recipient_role FROM notification_outbox WHERE entity_type = 'MATERIAL_DEMAND' AND entity_id = $1",
    [id],
  );
  assert.equal(notifications.rowCount, 2);
  assert.deepEqual(
    notifications.rows.map((row) => row.recipient_role).sort(),
    ["CEO", "UPPER_MANAGEMENT"],
  );
});

// --- Notification routing -------------------------------------------------

test("Upper Management at the same site receives the Demand Submitted notification; a different site does not", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: demandPayload(catalogEntryA),
  });
  const id = created.body.data.demand.id;
  await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/submit`, { token: teamLeadToken });

  const umNotifications = await apiRequest(server.baseUrl, "GET", "/api/v1/notifications", {
    token: upperManagementToken,
  });
  assert.equal(umNotifications.status, 200);
  assert.ok(umNotifications.body.data.some((row) => row.entityId === id));

  const otherSiteAdminToken = await authHeader(server.baseUrl, "admin-othersite@test.eset.local");
  const otherSiteNotifications = await apiRequest(server.baseUrl, "GET", "/api/v1/notifications", {
    token: otherSiteAdminToken,
  });
  assert.equal(otherSiteNotifications.status, 200);
  assert.ok(!otherSiteNotifications.body.data.some((row) => row.entityId === id));
});
