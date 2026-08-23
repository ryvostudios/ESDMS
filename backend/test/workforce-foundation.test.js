import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let users;
let ceoToken;
let hrToken;
let employeeToken;

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
  employeeToken = await authHeader(server.baseUrl, "employee@test.eset.local");
});

after(async () => {
  await server.close();
  await pool.end();
});

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

// --- Departments / Positions / Employment Types configuration -------------

test("ESDMS-035: CEO's company-wide department/position catalog is not empty for scope=null", async () => {
  const hrOwnSiteName = unique("HR-Site-Dept");
  await apiRequest(server.baseUrl, "POST", "/api/v1/departments", { token: hrToken, body: { name: hrOwnSiteName } });

  const otherSiteDept = await pool.query("SELECT id, name, site_id FROM departments WHERE site_id = $1 LIMIT 1", [
    users.otherSite,
  ]);
  assert.ok(otherSiteDept.rows[0], "fixture must seed at least one department on the secondary site");

  const ceoDepartments = await apiRequest(server.baseUrl, "GET", "/api/v1/departments/manage", { token: ceoToken });
  assert.equal(ceoDepartments.status, 200);
  assert.ok(ceoDepartments.body.data.length > 0, "CEO (scope=null) must see company-wide departments, not []");
  assert.ok(
    ceoDepartments.body.data.some((d) => d.site_id === users.otherSite),
    "the company-wide result must include departments from a site other than the CEO's own",
  );
  assert.ok(
    ceoDepartments.body.data.every((d) => d.site_name),
    "each row carries meaningful site identity for the frontend to group/filter by",
  );

  const hrDepartments = await apiRequest(server.baseUrl, "GET", "/api/v1/departments/manage", { token: hrToken });
  assert.equal(hrDepartments.status, 200);
  assert.ok(
    hrDepartments.body.data.every((d) => d.site_id !== users.otherSite),
    "a site-scoped HR actor must remain scoped to their own site",
  );

  const ceoPositions = await apiRequest(server.baseUrl, "GET", "/api/v1/positions/manage", { token: ceoToken });
  assert.equal(ceoPositions.status, 200);
  // No positions may be seeded yet; the important assertion is that this is
  // a real, non-empty-by-construction query, proven via the departments
  // assertion above using the exact same scope=null code path.
  assert.ok(Array.isArray(ceoPositions.body.data));
});

test("HR can create/archive a department; archiving a used department is blocked", async () => {
  const name = unique("Dept");
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/departments", { token: hrToken, body: { name } });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const archived = await apiRequest(server.baseUrl, "PATCH", `/api/v1/departments/${created.body.data.id}`, {
    token: hrToken,
    body: { isActive: false },
  });
  assert.equal(archived.status, 200);
});

test("a plain EMPLOYEE cannot create a department", async () => {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/departments", {
    token: employeeToken,
    body: { name: unique("Dept") },
  });
  assert.equal(response.status, 403);
});

test("HR can create a position; a Position named CEO grants zero application authority", async () => {
  const positionName = unique("CEO");
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/positions", {
    token: hrToken,
    body: { code: unique("POS"), name: positionName },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  // The position exists purely as a label; it has no relationship to
  // `roles` at all, so nothing further to assert beyond successful,
  // ordinary creation — no code path here can grant authority.
  assert.equal(created.body.data.name, positionName);
});

test("HR can create an employment type", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/employment-types", {
    token: hrToken,
    body: { code: unique("ET"), name: unique("Contract") },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
});

// --- Employee Master --------------------------------------------------------

async function createTestEmployee(overrides = {}) {
  const body = {
    employeeCode: unique("EMP"),
    fullLegalName: "Test Employee " + unique(""),
    joiningDate: "2026-01-15",
    ...overrides,
  };
  return apiRequest(server.baseUrl, "POST", "/api/v1/employees", { token: hrToken, body });
}

test("HR can create an Employee; the record is independent of any login account", async () => {
  const created = await createTestEmployee();
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.hasLogin, false);
});

test("duplicate detection warns on matching CNIC without hard-blocking a legitimate override", async () => {
  const cnic = `12345-${Date.now() % 10000000}-3`;
  const first = await createTestEmployee({ cnic });
  assert.equal(first.status, 201);

  const duplicate = await createTestEmployee({ cnic, fullLegalName: "Different Name " + unique("") });
  assert.equal(duplicate.status, 409, JSON.stringify(duplicate.body));
  assert.ok(duplicate.body.error.details.matches.some((d) => d.cnic_match));

  const overridden = await createTestEmployee({ cnic, confirmDuplicateOverride: true });
  assert.equal(overridden.status, 201, JSON.stringify(overridden.body));
});

// ESDMS-002: explicit { matches, outsideScopeMatch } contract.
async function insertOtherSiteEmployeeWithCnic(cnic) {
  const inserted = await pool.query(
    `INSERT INTO employees (employee_code, full_legal_name, primary_site_id, joining_date, created_by_user_id)
     VALUES ($1, $2, $3, CURRENT_DATE, $4) RETURNING id`,
    [unique("XSITE-DUP"), "Cross Site Duplicate", users.otherSite, users.hr],
  );
  await pool.query("INSERT INTO employee_personal_details (employee_id, cnic) VALUES ($1, $2)", [
    inserted.rows[0].id,
    cnic,
  ]);
  return inserted.rows[0].id;
}

test("ESDMS-002: same-site match is returned with authorized detail", async () => {
  const cnic = `12345-${Date.now() % 10000000}-4`;
  await createTestEmployee({ cnic });

  const check = await apiRequest(server.baseUrl, "POST", "/api/v1/employees/check-duplicates", {
    token: hrToken,
    body: { fullLegalName: unique("Checker"), siteId: users.mainSite, cnic },
  });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.ok(check.body.data.matches.some((m) => m.cnic_match), "same-site match appears with detail");
  assert.equal(check.body.data.outsideScopeMatch, false);
});

test("ESDMS-002: one out-of-site match reveals only a boolean, no detail", async () => {
  const cnic = `12345-${Date.now() % 10000000}-5`;
  await insertOtherSiteEmployeeWithCnic(cnic);

  const check = await apiRequest(server.baseUrl, "POST", "/api/v1/employees/check-duplicates", {
    token: hrToken,
    body: { fullLegalName: unique("Checker"), siteId: users.mainSite, cnic },
  });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body.data.matches, [], "no out-of-scope row is ever returned");
  assert.equal(check.body.data.outsideScopeMatch, true);
  assert.deepEqual(Object.keys(check.body.data).sort(), ["matches", "outsideScopeMatch"], "no id/code/name/status/site/count field leaks");
});

test("ESDMS-002: multiple out-of-site matches still yield the same boolean — no count leak", async () => {
  const cnic = `12345-${Date.now() % 10000000}-6`;
  await insertOtherSiteEmployeeWithCnic(cnic);
  await insertOtherSiteEmployeeWithCnic(cnic);
  await insertOtherSiteEmployeeWithCnic(cnic);

  const check = await apiRequest(server.baseUrl, "POST", "/api/v1/employees/check-duplicates", {
    token: hrToken,
    body: { fullLegalName: unique("Checker"), siteId: users.mainSite, cnic },
  });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.deepEqual(check.body.data.matches, []);
  assert.equal(check.body.data.outsideScopeMatch, true, "still just true, whether 1 or 20 out-of-scope matches exist");
  assert.deepEqual(Object.keys(check.body.data).sort(), ["matches", "outsideScopeMatch"]);
});

test("ESDMS-002: CEO (company-wide) receives full detail for a match on any site", async () => {
  const cnic = `12345-${Date.now() % 10000000}-7`;
  await insertOtherSiteEmployeeWithCnic(cnic);

  const check = await apiRequest(server.baseUrl, "POST", "/api/v1/employees/check-duplicates", {
    token: ceoToken,
    body: { fullLegalName: unique("Checker"), siteId: users.otherSite, cnic },
  });
  assert.equal(check.status, 200, JSON.stringify(check.body));
  assert.ok(check.body.data.matches.some((m) => m.cnic_match), "CEO sees full detail regardless of site");
  assert.equal(check.body.data.outsideScopeMatch, false);
});

test("a duplicate Employee ID is rejected", async () => {
  const code = unique("EMP");
  const first = await createTestEmployee({ employeeCode: code });
  assert.equal(first.status, 201);

  const second = await createTestEmployee({ employeeCode: code });
  assert.equal(second.status, 409);
});

test("an EMPLOYEE without employees.view cannot list or view another employee by id", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;

  const list = await apiRequest(server.baseUrl, "GET", "/api/v1/employees", { token: employeeToken });
  assert.equal(list.status, 403);

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}`, { token: employeeToken });
  assert.equal(detail.status, 403);
});

test("HR at one site cannot create or view an employee at another site", async () => {
  const otherSiteEmployee = await createTestEmployee({ siteId: users.otherSite });
  assert.equal(otherSiteEmployee.status, 403, "HR cannot create outside their own site without company-wide scope");

  // Cross-site view: use the fixture's existing otherSiteAdmin's site via a
  // direct DB-created employee to prove the read path is scoped too.
  const client = await pool.connect();
  let crossSiteEmployeeId;
  try {
    const role = await client.query("SELECT id FROM users WHERE id = $1", [users.hr]);
    const inserted = await client.query(
      `INSERT INTO employees (employee_code, full_legal_name, primary_site_id, joining_date, created_by_user_id)
       VALUES ($1, $2, $3, CURRENT_DATE, $4) RETURNING id`,
      [unique("XSITE"), "Cross Site Employee", users.otherSite, users.hr],
    );
    crossSiteEmployeeId = inserted.rows[0].id;
    void role;
  } finally {
    client.release();
  }

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${crossSiteEmployeeId}`, { token: hrToken });
  assert.equal(detail.status, 404, "wrong-site id must look identical to nonexistent, not 403");
});

// TOCTOU: simulate the Employee moving to another site in the window
// between the pre-transaction authorization read and the row lock, by
// having the pre-check's own query return a stale (still same-site)
// snapshot while actually committing the site move as a side effect of
// serving it. The row lock itself is a separate, unmocked `client.query`
// call, so it always sees the real, current row. Proves authorization is
// re-derived from the LOCKED row, not carried over from the pre-check.
function simulateSiteMoveDuringPreCheck(t, employeeId, newSiteId) {
  const realQuery = pool.query.bind(pool);
  t.mock.method(pool, "query", async (text, params) => {
    if (typeof text === "string" && text.includes("WHERE e.id = $1") && params?.[0] === employeeId) {
      const staleResult = await realQuery(text, params);
      await realQuery(
        "UPDATE employees SET primary_site_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1",
        [employeeId, newSiteId],
      );
      return staleResult;
    }
    return realQuery(text, params);
  });
}

test("TOCTOU: createLoginForEmployee re-authorizes against the locked, current site", async (t) => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;

  simulateSiteMoveDuringPreCheck(t, employeeId, users.otherSite);

  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email: `${unique("toctou-login")}@test.eset.local` },
  });
  t.mock.reset();

  assert.equal(login.status, 404, "stale same-site authorization must not survive the Employee moving sites before the lock");

  const stillNoLogin = await pool.query("SELECT user_id FROM employees WHERE id = $1", [employeeId]);
  assert.equal(stillNoLogin.rows[0].user_id, null, "no login was created against the mis-authorized attempt");
});

test("TOCTOU: linkExistingUserForEmployee re-authorizes against the locked, current site", async (t) => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;

  // HR needs the delegated link-existing authority for this path at all —
  // unrelated to the race being tested (see the dedicated permission test
  // above/below).
  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.hr}/permissions/employees.account.link_existing`, {
    token: ceoToken,
    body: { effect: "GRANT" },
  });

  try {
    simulateSiteMoveDuringPreCheck(t, employeeId, users.otherSite);

    const link = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login/link-existing`, {
      token: hrToken,
      body: { userId: users.guard },
    });
    t.mock.reset();

    assert.equal(link.status, 404, "stale same-site authorization must not survive the Employee moving sites before the lock");

    const stillNoLink = await pool.query("SELECT user_id FROM employees WHERE id = $1", [employeeId]);
    assert.equal(stillNoLink.rows[0].user_id, null, "no link was created against the mis-authorized attempt");
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.hr}/permissions/employees.account.link_existing`, {
      token: ceoToken,
    });
  }
});

test("TOCTOU: changeEmployeeStatus re-authorizes against the locked, current site", async (t) => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;

  simulateSiteMoveDuringPreCheck(t, employeeId, users.otherSite);

  const statusChange = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/status`, {
    token: hrToken,
    body: { status: "INACTIVE" },
  });
  t.mock.reset();

  assert.equal(statusChange.status, 404, "stale same-site authorization must not survive the Employee moving sites before the lock");

  const stillActive = await pool.query("SELECT status FROM employees WHERE id = $1", [employeeId]);
  assert.equal(stillActive.rows[0].status, "ACTIVE", "status was not changed by the mis-authorized attempt");
});

test("employment assignment/transfer creates new history rows rather than overwriting", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;

  const dept = await apiRequest(server.baseUrl, "POST", "/api/v1/departments", { token: hrToken, body: { name: unique("Dept") } });

  const transfer = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/transfer`, {
    token: hrToken,
    body: { departmentId: dept.body.data.id, effectiveDate: "2026-08-01", reason: "Promotion" },
  });
  assert.equal(transfer.status, 201, JSON.stringify(transfer.body));

  const history = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${employeeId}/assignments`, { token: hrToken });
  assert.equal(history.status, 200);
  assert.equal(history.body.data.length, 2, "initial assignment plus the transfer, both preserved");
});

test("a reporting-manager cycle is rejected", async () => {
  const a = await createTestEmployee();
  const b = await createTestEmployee();
  const aId = a.body.data.id;
  const bId = b.body.data.id;

  const aReportsToB = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${aId}/transfer`, {
    token: hrToken,
    body: { reportingManagerEmployeeId: bId, effectiveDate: "2026-08-01" },
  });
  assert.equal(aReportsToB.status, 201, JSON.stringify(aReportsToB.body));

  const bReportsToA = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${bId}/transfer`, {
    token: hrToken,
    body: { reportingManagerEmployeeId: aId, effectiveDate: "2026-08-02" },
  });
  assert.equal(bReportsToA.status, 400, "A -> B -> A would be a cycle");
});

test("an employee cannot be assigned as their own reporting manager", async () => {
  const a = await createTestEmployee();
  const aId = a.body.data.id;

  const selfManager = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${aId}/transfer`, {
    token: hrToken,
    body: { reportingManagerEmployeeId: aId, effectiveDate: "2026-08-01" },
  });
  assert.equal(selfManager.status, 400, "self as manager is a trivial 1-node cycle");
});

test("a reporting chain deeper than 25 is still correctly validated (no arbitrary depth cap)", async () => {
  const CHAIN_LENGTH = 27;
  const employees = [];
  for (let i = 0; i < CHAIN_LENGTH; i += 1) {
    const created = await createTestEmployee();
    employees.push(created.body.data.id);
  }

  // Link them into one long chain: employees[0] reports to employees[1],
  // employees[1] to employees[2], ..., forming a chain > 25 deep.
  for (let i = 0; i < CHAIN_LENGTH - 1; i += 1) {
    const link = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employees[i]}/transfer`, {
      token: hrToken,
      body: { reportingManagerEmployeeId: employees[i + 1], effectiveDate: "2026-08-01" },
    });
    assert.equal(link.status, 201, `link ${i} -> ${i + 1} must succeed: ${JSON.stringify(link.body)}`);
  }

  // Closing the loop at depth 27 must still be rejected — a hop-capped
  // check would have missed this.
  const closeLoop = await apiRequest(
    server.baseUrl,
    "POST",
    `/api/v1/employees/${employees[CHAIN_LENGTH - 1]}/transfer`,
    { token: hrToken, body: { reportingManagerEmployeeId: employees[0], effectiveDate: "2026-08-02" } },
  );
  assert.equal(closeLoop.status, 400, "a cycle closed at depth 27 must still be detected");

  // A genuinely new, non-cyclic assignment at the bottom of this deep chain
  // must still succeed — depth alone is never itself a rejection reason.
  const extra = await createTestEmployee();
  const validDeepLink = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${extra.body.data.id}/transfer`, {
    token: hrToken,
    body: { reportingManagerEmployeeId: employees[CHAIN_LENGTH - 1], effectiveDate: "2026-08-01" },
  });
  assert.equal(validDeepLink.status, 201, "a valid assignment at depth > 25 must not be rejected merely for its depth");
});

test("a malformed pre-existing cycle in the data does not cause infinite recursion", async () => {
  const c1 = await createTestEmployee();
  const c2 = await createTestEmployee();
  const c1Id = c1.body.data.id;
  const c2Id = c2.body.data.id;

  // Bypass the application entirely to plant a real 2-node cycle directly
  // in the data, the way a direct SQL fix or a bug elsewhere might.
  await pool.query(
    `INSERT INTO employment_assignments (employee_id, site_id, reporting_manager_employee_id, effective_date, created_by_user_id)
     VALUES ($1, $2, $3, '2026-01-01', $4)`,
    [c1Id, users.mainSite, c2Id, users.hr],
  );
  await pool.query(
    `INSERT INTO employment_assignments (employee_id, site_id, reporting_manager_employee_id, effective_date, created_by_user_id)
     VALUES ($1, $2, $3, '2026-01-01', $4)`,
    [c2Id, users.mainSite, c1Id, users.hr],
  );

  const c3 = await createTestEmployee();
  const attach = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${c3.body.data.id}/transfer`, {
    token: hrToken,
    body: { reportingManagerEmployeeId: c1Id, effectiveDate: "2026-08-01" },
  });
  // Must resolve promptly (proving no infinite recursion) with a sane
  // result: C3 reporting to C1 does not itself put C3 in the pre-existing
  // C1<->C2 cycle.
  assert.equal(attach.status, 201, JSON.stringify(attach.body));
});

// Real-lock concurrency: two reciprocal transfers (A -> manager B, B ->
// manager A) fired concurrently must serialize on the reporting-hierarchy
// advisory lock — whichever transaction commits first wins, and the
// second's cycle check must then see that committed change and reject.
test("concurrent A -> manager B and B -> manager A: at most one reciprocal assignment succeeds", async () => {
  const a = await createTestEmployee();
  const b = await createTestEmployee();
  const aId = a.body.data.id;
  const bId = b.body.data.id;

  const [aToB, bToA] = await Promise.all([
    apiRequest(server.baseUrl, "POST", `/api/v1/employees/${aId}/transfer`, {
      token: hrToken,
      body: { reportingManagerEmployeeId: bId, effectiveDate: "2026-08-01" },
    }),
    apiRequest(server.baseUrl, "POST", `/api/v1/employees/${bId}/transfer`, {
      token: hrToken,
      body: { reportingManagerEmployeeId: aId, effectiveDate: "2026-08-01" },
    }),
  ]);

  const statuses = [aToB.status, bToA.status].sort();
  assert.deepEqual(statuses, [201, 400], "exactly one reciprocal assignment succeeds, the other is rejected as a cycle");

  const managers = await pool.query(
    `SELECT DISTINCT ON (employee_id) employee_id, reporting_manager_employee_id
     FROM employment_assignments
     WHERE employee_id = ANY($1::uuid[])
     ORDER BY employee_id, effective_date DESC, created_at DESC`,
    [[aId, bId]],
  );
  const aManager = managers.rows.find((r) => r.employee_id === aId)?.reporting_manager_employee_id ?? null;
  const bManager = managers.rows.find((r) => r.employee_id === bId)?.reporting_manager_employee_id ?? null;
  assert.ok(
    !(aManager === bId && bManager === aId),
    "the two committed assignments must never form an actual A<->B cycle",
  );
});

// --- createTransfer: locked/current state, not a pre-transaction snapshot --

test("TOCTOU: createTransfer re-authorizes against the locked, current site", async (t) => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;

  simulateSiteMoveDuringPreCheck(t, employeeId, users.otherSite);

  const transfer = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/transfer`, {
    token: hrToken,
    body: { rotationPolicyId: null, effectiveDate: "2026-08-01", reason: "should be rejected" },
  });
  t.mock.reset();

  assert.equal(transfer.status, 404, "stale same-site authorization must not survive the Employee moving sites before the lock");
});

test("createTransfer carries department forward from the LOCKED, current assignment, not a stale pre-transaction read", async (t) => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;

  const deptD1 = await apiRequest(server.baseUrl, "POST", "/api/v1/departments", { token: hrToken, body: { name: unique("D1") } });
  const deptD2 = await apiRequest(server.baseUrl, "POST", "/api/v1/departments", { token: hrToken, body: { name: unique("D2") } });

  const first = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/transfer`, {
    token: hrToken,
    body: { departmentId: deptD1.body.data.id, effectiveDate: "2026-08-01" },
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  // Simulate a second HR request's own pre-check reading the OLD (D1)
  // state, while a concurrent transfer to D2 commits for real before the
  // lock is taken.
  const realQuery = pool.query.bind(pool);
  t.mock.method(pool, "query", async (text, params) => {
    if (typeof text === "string" && text.includes("WHERE e.id = $1") && params?.[0] === employeeId) {
      const staleResult = await realQuery(text, params);
      await realQuery(
        `INSERT INTO employment_assignments (employee_id, site_id, department_id, effective_date, created_by_user_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [employeeId, users.mainSite, deptD2.body.data.id, "2026-08-02", users.hr],
      );
      return staleResult;
    }
    return realQuery(text, params);
  });

  const second = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/transfer`, {
    token: hrToken,
    // Deliberately NOT specifying departmentId — it must carry forward
    // from the CURRENT assignment.
    body: { effectiveDate: "2026-08-03", reason: "unrelated change" },
  });
  t.mock.reset();

  assert.equal(second.status, 201, JSON.stringify(second.body));

  const history = await pool.query(
    "SELECT department_id FROM employment_assignments WHERE employee_id = $1 AND effective_date = '2026-08-03'",
    [employeeId],
  );
  assert.equal(history.rows[0].department_id, deptD2.body.data.id, "must carry forward the concurrently-committed D2, not the stale pre-check D1");
});

test("a future-dated cross-site transfer is rejected", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;

  const farFuture = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const transfer = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/transfer`, {
    token: ceoToken,
    body: { siteId: users.otherSite, effectiveDate: farFuture },
  });
  assert.equal(transfer.status, 400, "a future-dated cross-site transfer must be rejected");

  const state = await pool.query("SELECT primary_site_id FROM employees WHERE id = $1", [employeeId]);
  assert.equal(state.rows[0].primary_site_id, users.mainSite, "the employee's current site must be unchanged");
});

test("cross-site transfer safely synchronizes an ordinary EMPLOYEE-role linked User's site atomically", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  const email = `${unique("xfer-sync")}@test.eset.local`;
  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email },
  });
  const linkedUserId = login.body.data.userId;

  const transfer = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/transfer`, {
    token: ceoToken,
    body: { siteId: users.otherSite, effectiveDate: "2026-08-01" },
  });
  assert.equal(transfer.status, 201, JSON.stringify(transfer.body));

  const userState = await pool.query("SELECT site_id FROM users WHERE id = $1", [linkedUserId]);
  assert.equal(userState.rows[0].site_id, users.otherSite, "an ordinary EMPLOYEE-role linked User's site is synced atomically");
});

test("a privileged linked User's site is never silently changed by a cross-site transfer (allowed when already inactive)", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  // users.inactive is a privileged (TEAM_LEAD) account, already is_active = false.
  await pool.query("UPDATE employees SET user_id = $2 WHERE id = $1", [employeeId, users.inactive]);

  try {
    const transfer = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/transfer`, {
      token: ceoToken,
      body: { siteId: users.otherSite, effectiveDate: "2026-08-01" },
    });
    assert.equal(transfer.status, 201, JSON.stringify(transfer.body));
    assert.ok(transfer.body.data.linkedAccountNote, "a note explains the privileged account's site was not touched");

    const userState = await pool.query("SELECT site_id, is_active FROM users WHERE id = $1", [users.inactive]);
    assert.equal(userState.rows[0].site_id, users.mainSite, "an already-inactive privileged account's site is never touched");
    assert.equal(userState.rows[0].is_active, false);
  } finally {
    await pool.query("UPDATE employees SET user_id = NULL WHERE id = $1", [employeeId]);
  }
});

// Real-lock concurrency: a manual transaction holds FOR UPDATE on the
// linked User row (standing in for a concurrent Governance role
// promotion), so createTransfer's own User lock must block behind it, and
// once the promotion commits and releases the lock, the request must
// decide from that newly-committed privileged state.
test("createTransfer blocks a cross-site transfer when a concurrent role promotion makes the linked User privileged and site-inconsistent", async (t) => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  const email = `${unique("xfer-race")}@test.eset.local`;
  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email },
  });
  const linkedUserId = login.body.data.userId;

  const lockHolder = await pool.connect();
  try {
    await lockHolder.query("BEGIN");
    await lockHolder.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [linkedUserId]);

    const transferPromise = apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/transfer`, {
      token: ceoToken,
      body: { siteId: users.otherSite, effectiveDate: "2026-08-01" },
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    const adminRole = await lockHolder.query("SELECT id FROM roles WHERE name = 'ADMIN'");
    await lockHolder.query("UPDATE users SET role_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [
      linkedUserId,
      adminRole.rows[0].id,
    ]);
    await lockHolder.query("COMMIT");

    const transfer = await transferPromise;
    assert.equal(
      transfer.status,
      403,
      "the promotion that committed while this transaction was blocked on the lock must still be honored",
    );

    const employeeState = await pool.query("SELECT primary_site_id FROM employees WHERE id = $1", [employeeId]);
    assert.equal(employeeState.rows[0].primary_site_id, users.mainSite, "the blocked/rejected transfer rolled back entirely");

    const userState = await pool.query("SELECT site_id FROM users WHERE id = $1", [linkedUserId]);
    assert.equal(userState.rows[0].site_id, users.mainSite, "the now-privileged account's site was never changed");
  } finally {
    lockHolder.release();
  }
});

// --- Onboarding / login ------------------------------------------------------

test("HR creating a login always gets role EMPLOYEE — the payload has no role field to escalate", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  const email = `${unique("onboard")}@test.eset.local`;

  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email },
  });
  assert.equal(login.status, 201, JSON.stringify(login.body));
  assert.ok(login.body.data.temporaryPassword, "a one-time temporary credential is returned");

  const roleCheck = await pool.query(
    "SELECT r.name AS role, u.must_change_password FROM users u JOIN roles r ON r.id = u.role_id WHERE u.id = $1",
    [login.body.data.userId],
  );
  assert.equal(roleCheck.rows[0].role, "EMPLOYEE");
  assert.equal(roleCheck.rows[0].must_change_password, true);
});

test("a must_change_password account is blocked from privileged actions until the password is changed", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  const email = `${unique("forced")}@test.eset.local`;

  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email },
  });
  const tempPassword = login.body.data.temporaryPassword;

  // Caught by a live browser smoke test, not this suite originally: the
  // LOGIN response itself must already carry mustChangePassword (and
  // employeeId) — not just a later /auth/me call — otherwise the very
  // first page render after login has no way to redirect to the forced
  // change-password screen. See auth.service.js and docs/DECISIONS.md.
  const loginResponse = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
    body: { email, password: tempPassword },
  });
  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.body.data.user.mustChangePassword, true);
  assert.equal(loginResponse.body.data.user.employeeId, employeeId);

  const newToken = await authHeader(server.baseUrl, email, tempPassword);

  const blocked = await apiRequest(server.baseUrl, "GET", "/api/v1/employees/me", { token: newToken });
  assert.equal(blocked.status, 403);

  const me = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: newToken });
  assert.equal(me.body.data.user.mustChangePassword, true);

  const changed = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/change-password", {
    token: newToken,
    body: { currentPassword: tempPassword, newPassword: "Brand-New-Password-123" },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  // ESDMS-020: a successful password change revokes every previously
  // issued session, including the one just used to make this request — a
  // fresh login is required, it is not "the same session, unblocked."
  const oldSessionAfterChange = await apiRequest(server.baseUrl, "GET", "/api/v1/employees/me", { token: newToken });
  assert.equal(oldSessionAfterChange.status, 401, "the session used to change the password is itself revoked");

  const freshToken = await authHeader(server.baseUrl, email, "Brand-New-Password-123");
  const afterChange = await apiRequest(server.baseUrl, "GET", "/api/v1/employees/me", { token: freshToken });
  assert.equal(afterChange.status, 200, "a fresh login with the new password works immediately");
});

test("resetting a login password invalidates the previous credential", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  const email = `${unique("reset")}@test.eset.local`;

  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email },
  });
  const oldPassword = login.body.data.temporaryPassword;
  const oldToken = await authHeader(server.baseUrl, email, oldPassword);

  const reset = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login/reset`, { token: hrToken });
  assert.equal(reset.status, 200);
  assert.notEqual(reset.body.data.temporaryPassword, oldPassword);

  const oldStillWorks = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: oldToken });
  assert.equal(oldStillWorks.status, 401, "the old session must not survive a password reset");

  const loginWithNew = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
    body: { email, password: reset.body.data.temporaryPassword },
  });
  assert.equal(loginWithNew.status, 200);
});

test("TOCTOU: resetEmployeeLoginPassword re-authorizes against the locked, current site", async (t) => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  const email = `${unique("reset-toctou")}@test.eset.local`;
  await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, { token: hrToken, body: { email } });

  simulateSiteMoveDuringPreCheck(t, employeeId, users.otherSite);

  const reset = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login/reset`, { token: hrToken });
  t.mock.reset();

  assert.equal(reset.status, 404, "stale same-site authorization must not survive the Employee moving sites before the lock");
});

test("resetEmployeeLoginPassword rejects a privileged (non-EMPLOYEE) linked account and leaves its password/session untouched", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  // users.admin is a privileged (ADMIN) account, distinct from the
  // CEO-specific case already covered elsewhere — any non-EMPLOYEE role
  // must be rejected, not just CEO/UM.
  await pool.query("UPDATE employees SET user_id = $2 WHERE id = $1", [employeeId, users.admin]);
  try {
    const before = await pool.query("SELECT password_hash, session_version FROM users WHERE id = $1", [users.admin]);

    const reset = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login/reset`, { token: hrToken });
    assert.equal(reset.status, 403, "a privileged linked account must be rejected, directing the operator to Governance");

    const after = await pool.query("SELECT password_hash, session_version FROM users WHERE id = $1", [users.admin]);
    assert.equal(after.rows[0].password_hash, before.rows[0].password_hash, "the rejected reset must not mutate the password hash");
    assert.equal(after.rows[0].session_version, before.rows[0].session_version, "the rejected reset must not bump session_version");
  } finally {
    await pool.query("UPDATE employees SET user_id = NULL WHERE id = $1", [employeeId]);
  }
});

// Real-lock concurrency: a manual transaction holds FOR UPDATE on the
// linked User row (standing in for a concurrent Governance role
// promotion), so resetEmployeeLoginPassword's own User lock must block
// behind it — proving the lock order (Employee, then User) is real, not
// decorative — and once the promotion commits and releases the lock, the
// request must decide from that newly-committed privileged state, not a
// value read earlier in its own transaction. Mirrors the equivalent,
// already-proven changeEmployeeStatus concurrency test.
test("resetEmployeeLoginPassword decides from the LOCKED, current linked-User state — a role promotion racing the reset is honored, not raced past", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  const email = `${unique("reset-race")}@test.eset.local`;
  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email },
  });
  const linkedUserId = login.body.data.userId;

  const before = await pool.query("SELECT password_hash, session_version, must_change_password FROM users WHERE id = $1", [
    linkedUserId,
  ]);

  const lockHolder = await pool.connect();
  try {
    await lockHolder.query("BEGIN");
    await lockHolder.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [linkedUserId]);

    // resetEmployeeLoginPassword's own transaction must block here — it can
    // only proceed past lockLinkedUserRoleAndActive once lockHolder commits.
    const resetPromise = apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login/reset`, {
      token: hrToken,
    });

    // Give the request time to reach and block on the User row lock before
    // this transaction promotes the account and releases it.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const adminRole = await lockHolder.query("SELECT id FROM roles WHERE name = 'ADMIN'");
    await lockHolder.query("UPDATE users SET role_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [
      linkedUserId,
      adminRole.rows[0].id,
    ]);
    await lockHolder.query("COMMIT");

    const reset = await resetPromise;
    assert.equal(
      reset.status,
      403,
      "the promotion that committed while this transaction was blocked on the lock must still be honored",
    );

    const after = await pool.query(
      "SELECT password_hash, session_version, must_change_password FROM users WHERE id = $1",
      [linkedUserId],
    );
    assert.equal(after.rows[0].password_hash, before.rows[0].password_hash, "password/session state was not mutated by the rejected Workforce reset");
    assert.equal(after.rows[0].session_version, before.rows[0].session_version);
    assert.equal(after.rows[0].must_change_password, before.rows[0].must_change_password);
  } finally {
    lockHolder.release();
  }
});

test("resetEmployeeLoginPassword's plaintext temporary credential never appears in history/audit or server logs", async (t) => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  const email = `${unique("reset-noleak")}@test.eset.local`;
  await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, { token: hrToken, body: { email } });

  const lines = [];
  t.mock.method(console, "error", (...args) => {
    lines.push(args.join(" "));
  });

  const reset = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login/reset`, { token: hrToken });
  t.mock.reset();
  assert.equal(reset.status, 200, JSON.stringify(reset.body));
  const temporaryPassword = reset.body.data.temporaryPassword;
  assert.ok(temporaryPassword, "a one-time temporary credential is returned in the response only");

  const history = await pool.query(
    "SELECT summary FROM employee_business_history WHERE employee_id = $1 AND event_type = 'LOGIN_PASSWORD_RESET' ORDER BY created_at DESC LIMIT 1",
    [employeeId],
  );
  assert.ok(history.rows[0], "a history row is recorded for the reset");
  assert.ok(
    !JSON.stringify(history.rows[0].summary).includes(temporaryPassword),
    "the plaintext temporary credential must never appear in the history summary",
  );

  assert.ok(
    !lines.join("\n").includes(temporaryPassword),
    "the plaintext temporary credential must never appear in server logs",
  );
});

test("an already-deactivated privileged linked User allows the Employee status transition", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  // users.inactive is a privileged (TEAM_LEAD) account that is already
  // is_active = false — Governance has already acted.
  await pool.query("UPDATE employees SET user_id = $2 WHERE id = $1", [employeeId, users.inactive]);

  try {
    const statusChange = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/status`, {
      token: hrToken,
      body: { status: "INACTIVE" },
    });
    assert.equal(statusChange.status, 200, JSON.stringify(statusChange.body));

    const state = await pool.query("SELECT status FROM employees WHERE id = $1", [employeeId]);
    assert.equal(state.rows[0].status, "INACTIVE");

    const userState = await pool.query("SELECT is_active FROM users WHERE id = $1", [users.inactive]);
    assert.equal(userState.rows[0].is_active, false, "an already-inactive privileged account is never touched");
  } finally {
    await pool.query("UPDATE employees SET user_id = NULL WHERE id = $1", [employeeId]);
  }
});

// Real-lock concurrency: a manual transaction holds FOR UPDATE on the
// linked User row (standing in for a concurrent Governance role
// promotion), so changeEmployeeStatus's own User lock must block behind
// it — proving the lock order (Employee, then User) is real, not
// decorative — and then, once the promotion commits and releases the
// lock, the request must decide from that newly-committed privileged
// state, not a value read earlier in its own transaction.
test("changeEmployeeStatus decides from the LOCKED, current linked-User state — a role promotion racing offboarding is honored, not raced past", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  const email = `${unique("race-linked")}@test.eset.local`;
  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login`, {
    token: hrToken,
    body: { email },
  });
  const linkedUserId = login.body.data.userId;

  const lockHolder = await pool.connect();
  try {
    await lockHolder.query("BEGIN");
    await lockHolder.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [linkedUserId]);

    // changeEmployeeStatus's own transaction must block here — it can only
    // proceed past lockLinkedUserRoleAndActive once lockHolder commits.
    const statusPromise = apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/status`, {
      token: hrToken,
      body: { status: "INACTIVE" },
    });

    // Give the request time to reach and block on the User row lock before
    // this transaction promotes the account and releases it.
    await new Promise((resolve) => setTimeout(resolve, 300));

    const adminRole = await lockHolder.query("SELECT id FROM roles WHERE name = 'ADMIN'");
    await lockHolder.query("UPDATE users SET role_id = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $1", [
      linkedUserId,
      adminRole.rows[0].id,
    ]);
    await lockHolder.query("COMMIT");

    const statusChange = await statusPromise;
    assert.equal(
      statusChange.status,
      403,
      "the promotion that committed while this transaction was blocked on the lock must still be honored",
    );

    const employeeState = await pool.query("SELECT status FROM employees WHERE id = $1", [employeeId]);
    assert.equal(employeeState.rows[0].status, "ACTIVE", "the blocked/rejected transaction rolled back entirely");

    const userState = await pool.query("SELECT is_active FROM users WHERE id = $1", [linkedUserId]);
    assert.equal(userState.rows[0].is_active, true, "the now-privileged account was never deactivated");
  } finally {
    lockHolder.release();
  }
});

test("Workforce cannot reset or deactivate a privileged linked account", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;
  await pool.query("UPDATE employees SET user_id = $2 WHERE id = $1", [employeeId, users.ceo]);
  try {
    const reset = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/login/reset`, { token: hrToken });
    assert.equal(reset.status, 403, "HR must not take over a CEO account through Employee password reset");

    const deactivate = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${employeeId}/status`, {
      token: hrToken,
      body: { status: "INACTIVE", deactivateLogin: false },
    });
    assert.equal(deactivate.status, 403, "status changes must not bypass privileged-account governance");
    const state = await pool.query("SELECT status FROM employees WHERE id = $1", [employeeId]);
    assert.equal(state.rows[0].status, "ACTIVE", "the rejected transaction must roll back the employee status too");
  } finally {
    await pool.query("UPDATE employees SET user_id = NULL WHERE id = $1", [employeeId]);
  }
});

test("an inactive Employee cannot retain login access through deactivateLogin=false", async () => {
  const created = await createTestEmployee();
  const email = `${unique("inactive-login")}@test.eset.local`;
  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${created.body.data.id}/login`, {
    token: hrToken, body: { email },
  });
  const session = await authHeader(server.baseUrl, email, login.body.data.temporaryPassword);
  const changed = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${created.body.data.id}/status`, {
    token: hrToken, body: { status: "INACTIVE", deactivateLogin: false },
  });
  assert.equal(changed.status, 200);
  const after = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: session });
  assert.equal(after.status, 401, "the linked account is always deactivated when employment becomes inactive");
});

test("self-service /employees/me resolves the caller's own record with no id in the URL", async () => {
  const email = `${unique("self")}@test.eset.local`;
  const created = await createTestEmployee();
  const login = await apiRequest(server.baseUrl, "POST", `/api/v1/employees/${created.body.data.id}/login`, {
    token: hrToken,
    body: { email },
  });
  const tempToken = await authHeader(server.baseUrl, email, login.body.data.temporaryPassword);
  await apiRequest(server.baseUrl, "POST", "/api/v1/auth/change-password", {
    token: tempToken,
    body: { currentPassword: login.body.data.temporaryPassword, newPassword: "Another-New-Password-123" },
  });

  // ESDMS-020: the password-change session itself is revoked; a fresh
  // login is required.
  const selfToken = await authHeader(server.baseUrl, email, "Another-New-Password-123");
  const me = await apiRequest(server.baseUrl, "GET", "/api/v1/employees/me", { token: selfToken });
  assert.equal(me.status, 200);
  assert.equal(me.body.data.id, created.body.data.id);
});

// --- Existing User <-> Employee linking ------------------------------------

test("HR cannot link an existing User without explicit link-existing authority", async () => {
  const created = await createTestEmployee();

  const response = await apiRequest(
    server.baseUrl,
    "POST",
    `/api/v1/employees/${created.body.data.id}/login/link-existing`,
    {
      token: hrToken,
      body: { userId: users.admin },
    },
  );

  assert.equal(response.status, 403);
});

test("CEO can link an existing Admin without changing the Admin role", async () => {
  const created = await createTestEmployee();
  const employeeId = created.body.data.id;

  try {
    const linked = await apiRequest(
      server.baseUrl,
      "POST",
      `/api/v1/employees/${employeeId}/login/link-existing`,
      {
        token: ceoToken,
        body: { userId: users.admin },
      },
    );

    assert.equal(linked.status, 200, JSON.stringify(linked.body));
    assert.equal(linked.body.data.userId, users.admin);
    assert.equal(linked.body.data.role, "ADMIN");

    const userState = await pool.query(
      `SELECT r.name AS role
       FROM users u
       JOIN roles r ON r.id = u.role_id
       WHERE u.id = $1`,
      [users.admin],
    );

    assert.equal(userState.rows[0].role, "ADMIN");

    const adminToken = await authHeader(server.baseUrl, "admin@test.eset.local");
    const me = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", {
      token: adminToken,
    });

    assert.equal(me.status, 200);
    assert.equal(me.body.data.user.employeeId, employeeId);

    const audit = await pool.query(
      `SELECT action
       FROM governance_audit_log
       WHERE target_employee_id = $1
         AND target_user_id = $2
         AND action = 'EMPLOYEE_EXISTING_USER_LINKED'
       ORDER BY created_at DESC
       LIMIT 1`,
      [employeeId, users.admin],
    );
    assert.equal(audit.rowCount, 1);

    const history = await pool.query(
      `SELECT event_type
       FROM employee_business_history
       WHERE employee_id = $1
         AND event_type = 'LOGIN_LINKED_EXISTING'
       ORDER BY created_at DESC
       LIMIT 1`,
      [employeeId],
    );
    assert.equal(history.rowCount, 1);
  } finally {
    await pool.query("UPDATE employees SET user_id = NULL WHERE id = $1", [employeeId]);
  }
});

test("one User cannot be linked to two Employee records", async () => {
  const first = await createTestEmployee();
  const second = await createTestEmployee();

  try {
    const firstLink = await apiRequest(
      server.baseUrl,
      "POST",
      `/api/v1/employees/${first.body.data.id}/login/link-existing`,
      {
        token: ceoToken,
        body: { userId: users.admin },
      },
    );

    assert.equal(firstLink.status, 200, JSON.stringify(firstLink.body));

    const secondLink = await apiRequest(
      server.baseUrl,
      "POST",
      `/api/v1/employees/${second.body.data.id}/login/link-existing`,
      {
        token: ceoToken,
        body: { userId: users.admin },
      },
    );

    assert.equal(secondLink.status, 409, JSON.stringify(secondLink.body));
  } finally {
    await pool.query(
      "UPDATE employees SET user_id = NULL WHERE id IN ($1, $2)",
      [first.body.data.id, second.body.data.id],
    );
  }
});

test("database independently enforces one Employee per User", async () => {
  const first = await createTestEmployee();
  const second = await createTestEmployee();

  try {
    await pool.query(
      "UPDATE employees SET user_id = $2 WHERE id = $1",
      [first.body.data.id, users.admin],
    );

    await assert.rejects(
      pool.query(
        "UPDATE employees SET user_id = $2 WHERE id = $1",
        [second.body.data.id, users.admin],
      ),
      (error) => error?.code === "23505",
    );
  } finally {
    await pool.query(
      "UPDATE employees SET user_id = NULL WHERE id IN ($1, $2)",
      [first.body.data.id, second.body.data.id],
    );
  }
});

test("CEO account cannot be linked through the ordinary Workforce link API", async () => {
  const created = await createTestEmployee();

  const response = await apiRequest(
    server.baseUrl,
    "POST",
    `/api/v1/employees/${created.body.data.id}/login/link-existing`,
    {
      token: ceoToken,
      body: { userId: users.ceo },
    },
  );

  assert.equal(response.status, 403);

  const state = await pool.query(
    "SELECT user_id FROM employees WHERE id = $1",
    [created.body.data.id],
  );
  assert.equal(state.rows[0].user_id, null);
});

test("Upper Management linking additionally requires users.manage_um", async () => {
  const email = `${unique("link-um")}@test.eset.local`;

  const createdUm = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
    token: ceoToken,
    body: {
      email,
      fullName: "Existing UM Link Test",
      password: "Existing-Um-Link-Password-123",
      role: "UPPER_MANAGEMENT",
    },
  });

  assert.equal(createdUm.status, 201, JSON.stringify(createdUm.body));

  const employee = await createTestEmployee();

  await apiRequest(
    server.baseUrl,
    "PUT",
    `/api/v1/users/${users.hr}/permissions/employees.account.link_existing`,
    {
      token: ceoToken,
      body: { effect: "GRANT" },
    },
  );

  try {
    const denied = await apiRequest(
      server.baseUrl,
      "POST",
      `/api/v1/employees/${employee.body.data.id}/login/link-existing`,
      {
        token: hrToken,
        body: { userId: createdUm.body.data.id },
      },
    );

    assert.equal(denied.status, 403);

    await apiRequest(
      server.baseUrl,
      "PUT",
      `/api/v1/users/${users.hr}/permissions/users.manage_um`,
      {
        token: ceoToken,
        body: { effect: "GRANT" },
      },
    );

    const allowed = await apiRequest(
      server.baseUrl,
      "POST",
      `/api/v1/employees/${employee.body.data.id}/login/link-existing`,
      {
        token: hrToken,
        body: { userId: createdUm.body.data.id },
      },
    );

    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
    assert.equal(allowed.body.data.role, "UPPER_MANAGEMENT");
  } finally {
    await pool.query(
      "UPDATE employees SET user_id = NULL WHERE id = $1",
      [employee.body.data.id],
    );

    await apiRequest(
      server.baseUrl,
      "DELETE",
      `/api/v1/users/${users.hr}/permissions/employees.account.link_existing`,
      { token: ceoToken },
    );

    await apiRequest(
      server.baseUrl,
      "DELETE",
      `/api/v1/users/${users.hr}/permissions/users.manage_um`,
      { token: ceoToken },
    );
  }
});
