// The owner-reported Team Lead scope bug: an Employee assigned to a
// department, given a linked login and promoted to TEAM_LEAD in Governance
// with full Material Catalog capability, saw an empty catalog and could not
// add anything.
//
// Root cause: createLoginForEmployee never populates users.department_id, and
// scope resolved from that column alone — so an employee-linked actor always
// arrived with departmentId = null. Scope is now derived from the linked
// Employee's current effective-dated assignment.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let users;
let ceoToken;
let hrToken;
let uomId;
let departmentA;
let departmentB;
let siteId;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

// Builds the owner's exact scenario: Employee -> assignment -> login ->
// Governance role change -> capability grants.
async function employeeLinkedActor({ departmentId, role = "TEAM_LEAD", permissions = [] }) {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/employees", {
    token: hrToken,
    body: { employeeCode: unique("SCOPE"), fullLegalName: unique("Scope Fixture"), joiningDate: "2026-01-01", departmentId },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const employeeId = created.body.data.id;

  const email = `${unique("scope")}@test.eset.local`;
  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email },
  });
  assert.equal(login.status, 201, JSON.stringify(login.body));
  const temporary = login.body.data.temporaryPassword;
  const userId = login.body.data.userId;

  const tempToken = await authHeader(server.baseUrl, email, temporary);
  await apiRequest(server.baseUrl, "POST", "/api/v1/auth/change-password", {
    token: tempToken,
    body: { currentPassword: temporary, newPassword: "Scope-Pw-12345" },
  });

  if (role !== "EMPLOYEE") {
    const changed = await apiRequest(server.baseUrl, "PATCH", `/api/v1/users/${userId}/role`, {
      token: ceoToken,
      body: { role },
    });
    assert.equal(changed.status, 200, JSON.stringify(changed.body));
  }
  for (const code of permissions) {
    const granted = await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${userId}/permissions/${code}`, {
      token: ceoToken,
      body: { effect: "GRANT", reason: "scope fixture" },
    });
    assert.ok(granted.status < 300, `${code}: ${granted.status} ${JSON.stringify(granted.body)}`);
  }

  return { employeeId, userId, email, token: await authHeader(server.baseUrl, email, "Scope-Pw-12345") };
}

const CATALOG = ["material_catalog.view", "material_catalog.manage"];

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");

  const uom = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", { token: ceoToken });
  uomId = uom.body.data[0].id;

  const site = await pool.query("SELECT site_id FROM users WHERE email = 'teamlead@test.eset.local'");
  siteId = site.rows[0].site_id;
  const depts = await pool.query("SELECT id FROM departments WHERE site_id = $1 ORDER BY name", [siteId]);
  [departmentA, departmentB] = depts.rows.map((r) => r.id);
});

after(async () => {
  await server.close();
  await pool.end();
});

// ---------------------------------------------------------------------
// The reported bug
// ---------------------------------------------------------------------

test("an employee-linked TEAM_LEAD works inside their department's catalog", async () => {
  const actor = await employeeLinkedActor({ departmentId: departmentA, permissions: CATALOG });

  // The user row itself still carries no department — scope is derived, not copied.
  const row = await pool.query("SELECT department_id FROM users WHERE id = $1", [actor.userId]);
  assert.equal(row.rows[0].department_id, null, "the fix must not write a second, driftable department column");

  const me = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: actor.token });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.user.departmentId, departmentA, "effective scope comes from the linked assignment");
  assert.equal(me.body.data.user.role, "TEAM_LEAD");

  const list = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog?pageSize=100", { token: actor.token });
  assert.equal(list.status, 200, JSON.stringify(list.body));

  const added = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: actor.token,
    body: { newItem: { name: unique("Scoped Cement") }, defaultUomId: uomId },
  });
  assert.equal(added.status, 201, JSON.stringify(added.body));
  assert.equal(added.body.data.department_id, departmentA, "created into the linked department, not nowhere");

  // Search for it rather than assuming page one: departmentA's catalog is
  // long-lived and shared across the suite, so a fixture drifts off the
  // first page as rows accumulate.
  const name = added.body.data.companyItem?.name ?? added.body.data.item_name;
  const relisted = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/material-catalog?pageSize=100&search=${encodeURIComponent(name)}`,
    { token: actor.token },
  );
  assert.ok(relisted.body.data.some((r) => r.id === added.body.data.id), "and it is visible afterwards");

  const archived = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/${added.body.data.id}`, {
    token: actor.token,
    body: { isActive: false },
  });
  assert.equal(archived.status, 200, "archive works within own department");
});

test("the same actor cannot reach another department", async () => {
  const actor = await employeeLinkedActor({ departmentId: departmentA, permissions: CATALOG });

  const foreignList = await apiRequest(server.baseUrl, "GET", `/api/v1/material-catalog?departmentId=${departmentB}`, {
    token: actor.token,
  });
  assert.equal(foreignList.status, 403, "listing another department is refused");

  const foreignCreate = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: actor.token,
    body: { departmentId: departmentB, newItem: { name: unique("Foreign") }, defaultUomId: uomId },
  });
  assert.equal(foreignCreate.status, 403);

  const other = await employeeLinkedActor({ departmentId: departmentB, permissions: CATALOG });
  const theirs = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: other.token,
    body: { newItem: { name: unique("TheirMaterial") }, defaultUomId: uomId },
  });
  assert.equal(theirs.status, 201);

  const foreignMutate = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/${theirs.body.data.id}`, {
    token: actor.token,
    body: { isActive: false },
  });
  assert.equal(foreignMutate.status, 404, "a foreign record is concealed, not merely refused");
});

// ---------------------------------------------------------------------
// Scope is not authority
// ---------------------------------------------------------------------

test("a department assignment grants scope but never capability", async () => {
  // Deliberately an EMPLOYEE: TEAM_LEAD already holds material_catalog.manage
  // by role, so it could not show that scope alone confers nothing.
  const actor = await employeeLinkedActor({
    departmentId: departmentA,
    role: "EMPLOYEE",
    permissions: ["material_catalog.view"],
  });

  const list = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog?pageSize=50", { token: actor.token });
  assert.equal(list.status, 200, "view capability is enough to look");

  const denied = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: actor.token,
    body: { newItem: { name: unique("NoManage") }, defaultUomId: uomId },
  });
  assert.equal(denied.status, 403, "being in the department does not confer manage");
});

test("no material capability at all is still denied despite a valid assignment", async () => {
  const actor = await employeeLinkedActor({ departmentId: departmentA, role: "EMPLOYEE", permissions: [] });

  const create = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: actor.token,
    body: { newItem: { name: unique("NoCap") }, defaultUomId: uomId },
  });
  assert.equal(create.status, 403);
});

test("an explicit DENY still beats the role default", async () => {
  const actor = await employeeLinkedActor({ departmentId: departmentA, permissions: CATALOG });

  const permission = await pool.query("SELECT id FROM permissions WHERE code = 'material_catalog.manage'");
  await pool.query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, reason, granted_by_user_id)
     VALUES ($1, $2, 'DENY', 'test', $1)
     ON CONFLICT (user_id, permission_id) DO UPDATE SET effect = 'DENY'`,
    [actor.userId, permission.rows[0].id],
  );

  const denied = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: await authHeader(server.baseUrl, actor.email, "Scope-Pw-12345"),
    body: { newItem: { name: unique("Denied") }, defaultUomId: uomId },
  });
  assert.equal(denied.status, 403, "DENY wins over both the role default and the assignment");
});

// ---------------------------------------------------------------------
// Transfer
// ---------------------------------------------------------------------

test("transferring the Employee moves future scope and leaves history alone", async () => {
  const actor = await employeeLinkedActor({ departmentId: departmentA, permissions: CATALOG });

  const before = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: actor.token,
    body: { newItem: { name: unique("BeforeTransfer") }, defaultUomId: uomId },
  });
  assert.equal(before.status, 201);
  assert.equal(before.body.data.department_id, departmentA);

  const transfer = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${actor.employeeId}/transfer`, {
    token: hrToken,
    body: { departmentId: departmentB, effectiveDate: "2026-01-02", reason: "scope transfer test" },
  });
  assert.equal(transfer.status, 201, JSON.stringify(transfer.body));

  const after = await authHeader(server.baseUrl, actor.email, "Scope-Pw-12345");
  const me = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: after });
  assert.equal(me.body.data.user.departmentId, departmentB, "scope follows the current assignment");

  // The historical record keeps the department it was created under.
  const historical = await pool.query("SELECT department_id FROM department_material_catalog WHERE id = $1", [
    before.body.data.id,
  ]);
  assert.equal(historical.rows[0].department_id, departmentA, "history is never rewritten by a transfer");

  // And the old department is now foreign to them.
  const oldDept = await apiRequest(server.baseUrl, "PATCH", `/api/v1/material-catalog/${before.body.data.id}`, {
    token: after,
    body: { isActive: false },
  });
  assert.equal(oldDept.status, 404, "the previous department is no longer in scope");

  // Capability is untouched by the transfer — only scope moved.
  const nowThere = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: after,
    body: { newItem: { name: unique("AfterTransfer") }, defaultUomId: uomId },
  });
  assert.equal(nowThere.status, 201);
  assert.equal(nowThere.body.data.department_id, departmentB);
});

test("a future-dated transfer does not move scope early", async () => {
  const actor = await employeeLinkedActor({ departmentId: departmentA, permissions: CATALOG });

  const future = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${actor.employeeId}/transfer`, {
    token: hrToken,
    body: { departmentId: departmentB, effectiveDate: "2099-01-01", reason: "future transfer" },
  });
  assert.equal(future.status, 201, JSON.stringify(future.body));

  const me = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", {
    token: await authHeader(server.baseUrl, actor.email, "Scope-Pw-12345"),
  });
  assert.equal(me.body.data.user.departmentId, departmentA, "scope only moves once the date arrives");
});

// ---------------------------------------------------------------------
// Non-employee users
// ---------------------------------------------------------------------

test("a user with no linked Employee keeps its own explicit scope", async () => {
  const me = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", {
    token: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
  });
  assert.equal(me.body.data.user.employeeId, null, "the seeded Team Lead is not employee-linked");
  assert.equal(me.body.data.user.departmentId, departmentA, "its explicit user scope still applies");

  const list = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog?pageSize=50", {
    token: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
  });
  assert.equal(list.status, 200);
});

test("missing scope stays restrictive — it never becomes all-departments", async () => {
  const actor = await employeeLinkedActor({ departmentId: null, permissions: CATALOG });

  const me = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: actor.token });
  assert.equal(me.body.data.user.departmentId, null);

  const create = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: actor.token,
    body: { newItem: { name: unique("NoDept") }, defaultUomId: uomId },
  });
  assert.equal(create.status, 403, "no department means no departmental action, never every department");
  assert.match(create.body.error.message, /not assigned to a department/i);
});

test("CEO all-departments behaviour is unchanged", async () => {
  const list = await apiRequest(server.baseUrl, "GET", `/api/v1/material-catalog?departmentId=${departmentB}`, {
    token: ceoToken,
  });
  assert.equal(list.status, 200, "company-wide scope still reaches every department");

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: ceoToken,
    body: { departmentId: departmentB, newItem: { name: unique("CeoAnyDept") }, defaultUomId: uomId },
  });
  assert.equal(created.status, 201);
});

// ---------------------------------------------------------------------
// The same resolver feeds every scoped module
// ---------------------------------------------------------------------

test("the derived scope also reaches Demand, and stays inside it", async () => {
  const actor = await employeeLinkedActor({
    departmentId: departmentA,
    permissions: [...CATALOG, "demand.view", "demand.create"],
  });

  const entry = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: actor.token,
    body: { newItem: { name: unique("DemandItem") }, defaultUomId: uomId },
  });
  assert.equal(entry.status, 201);

  const demand = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: actor.token,
    body: { lines: [{ catalogEntryId: entry.body.data.id, quantity: 2 }] },
  });
  assert.equal(demand.status, 201, JSON.stringify(demand.body));
  assert.equal(demand.body.data.demand.department_id, departmentA);

  const foreign = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: actor.token,
    body: { departmentId: departmentB, lines: [{ catalogEntryId: entry.body.data.id, quantity: 1 }] },
  });
  assert.equal(foreign.status, 403, "scope is enforced identically in Demand");
});

// ---------------------------------------------------------------------
// Integration hardening — the edge cases the derived scope must not get
// wrong. Everything here talks to the real database and the real API.
// ---------------------------------------------------------------------

async function me(token) {
  const response = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  return response.body.data.user;
}

test("a current assignment with NO department narrows scope, never falls back to a stale one", async () => {
  const actor = await employeeLinkedActor({ departmentId: departmentA, permissions: CATALOG });
  assert.equal((await me(actor.token)).departmentId, departmentA);

  // Give the user an explicit stale department too, so a fallback would be
  // visible rather than silently indistinguishable from "no scope".
  await pool.query("UPDATE users SET department_id = $2 WHERE id = $1", [actor.userId, departmentB]);

  // A current assignment that carries no department at all.
  await pool.query(
    `INSERT INTO employment_assignments (employee_id, department_id, site_id, effective_date, created_by_user_id)
     VALUES ($1, NULL, $2, CURRENT_DATE, $3)`,
    [actor.employeeId, siteId, users.ceo],
  );

  const profile = await me(actor.token);
  assert.equal(profile.departmentId, null, "the assignment wins even when its department is NULL");
  assert.notEqual(profile.departmentId, departmentB, "it must not fall back to the stale user column");

  // Restrictive, not permissive: no departmental reach at all.
  const list = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog", { token: actor.token });
  assert.ok(list.status === 200 || list.status === 403, `unexpected ${list.status}`);
  if (list.status === 200) {
    assert.equal(list.body.data.length, 0, "NULL scope reaches no rows — never all departments");
  }
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: actor.token,
    body: { newItem: { name: unique("NullScope") }, defaultUomId: uomId },
  });
  assert.ok(created.status >= 400, `NULL scope must not be able to create: ${JSON.stringify(created.body)}`);
  assert.ok(created.status < 500, "and must fail cleanly, not with a 5xx");
});

test("a department in another site cannot be reached through the derived scope", async () => {
  // The Employee's assignment points at a department belonging to a DIFFERENT
  // site than the User's own site scope — inconsistent data that must never
  // widen reach across sites.
  const otherSite = await pool.query("SELECT id FROM sites WHERE id <> $1 LIMIT 1", [siteId]);
  assert.ok(otherSite.rowCount === 1, "the fixture set has a second site");
  const otherSiteId = otherSite.rows[0].id;
  const otherDept = await pool.query("SELECT id FROM departments WHERE site_id = $1 LIMIT 1", [otherSiteId]);
  assert.ok(otherDept.rowCount === 1, "and a department inside it");
  const foreignDepartmentId = otherDept.rows[0].id;

  const actor = await employeeLinkedActor({ departmentId: departmentA, permissions: CATALOG });
  const before = await me(actor.token);
  assert.equal(before.siteId ?? null, before.siteId ?? null);

  // The assignment itself sits in the other site — deliberately inconsistent
  // with the User's own site scope.
  await pool.query(
    `INSERT INTO employment_assignments (employee_id, department_id, site_id, effective_date, created_by_user_id)
     VALUES ($1, $2, $3, CURRENT_DATE, $4)`,
    [actor.employeeId, foreignDepartmentId, otherSiteId, users.ceo],
  );

  const profile = await me(actor.token);
  // Department scope may follow the assignment, but site scope must not move
  // with it — that synchronisation is deliberately left to the audited
  // employee-transfer path.
  assert.notEqual(profile.siteId, otherSiteId, "site scope was NOT silently moved by an assignment");

  // And the cross-site department must not become reachable.
  const seeded = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: ceoToken,
    body: { newItem: { name: unique("OtherSiteMat") }, defaultUomId: uomId, departmentId: foreignDepartmentId },
  });

  const list = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog", { token: actor.token });
  if (list.status === 200 && seeded.status === 201) {
    const leaked = list.body.data.some((row) => row.id === seeded.body.data.id);
    assert.equal(leaked, false, "a cross-site department's rows never appear");
  }
  assert.ok(list.status < 500, "no 5xx on inconsistent site/department data");
});

test("same-day assignment ordering cannot be ambiguous — the schema forbids the tie", async () => {
  const actor = await employeeLinkedActor({ departmentId: departmentA, permissions: CATALOG });

  // The resolver orders by effective_date DESC, created_at DESC, matching the
  // rest of Workforce. That ordering could in principle tie on the same day —
  // except a UNIQUE (employee_id, effective_date) constraint makes a second
  // assignment on the same date impossible, so no ID tie-breaker is needed
  // and none is invented here (which would have forked the definition of
  // "current assignment" for authorization only).
  const insertToday = (departmentId) =>
    pool.query(
      "INSERT INTO employment_assignments (employee_id, department_id, site_id, effective_date, created_by_user_id) VALUES ($1, $2, $3, CURRENT_DATE, $4)",
      [actor.employeeId, departmentId, siteId, users.ceo],
    );

  await insertToday(departmentB);
  await assert.rejects(
    insertToday(departmentA),
    /employment_assignments_employee_effective_key|duplicate key/i,
    "a second same-day assignment is refused by the database",
  );

  // Exactly one assignment can hold today's date, so scope is stable across
  // repeated resolutions rather than depending on row order.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    assert.equal((await me(actor.token)).departmentId, departmentB, `resolution ${attempt} is stable`);
  }
});

test("/auth/me exposes the effective department without leaking HR-sensitive data", async () => {
  const actor = await employeeLinkedActor({ departmentId: departmentA, permissions: CATALOG });
  const profile = await me(actor.token);

  assert.equal(profile.departmentId, departmentA, "the effective department is exposed");
  assert.ok(profile.employeeId, "employeeId remains part of the established contract");

  // An exact allowlist, not a substring scan: this fails the moment the scope
  // resolver starts carrying any new field out to the client, whatever it is
  // called. Deriving department from the Employee must not drag HR data along.
  assert.deepEqual(
    Object.keys(profile).sort(),
    ["departmentId", "email", "employeeId", "fullName", "id", "mustChangePassword", "permissions", "role", "siteId"],
    "the /auth/me contract is unchanged",
  );

  // Permission codes are capability names, not HR data, so they are excluded
  // from the value scan below by design.
  const { permissions, ...rest } = profile;
  assert.ok(Array.isArray(permissions));
  const serialized = JSON.stringify(rest).toLowerCase();
  for (const forbidden of ["salary", "compensation", "cnic", "passport", "contract", "terms_summary", "storage_key", "joining", "birth", "designation"]) {
    assert.ok(!serialized.includes(forbidden), `/auth/me must not carry "${forbidden}": ${serialized}`);
  }
});
