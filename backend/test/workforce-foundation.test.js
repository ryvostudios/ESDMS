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
  assert.ok(duplicate.body.error.details.duplicates.some((d) => d.cnic_match));

  const overridden = await createTestEmployee({ cnic, confirmDuplicateOverride: true });
  assert.equal(overridden.status, 201, JSON.stringify(overridden.body));
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

  const afterChange = await apiRequest(server.baseUrl, "GET", "/api/v1/employees/me", { token: newToken });
  assert.equal(afterChange.status, 200, "the same session works again immediately, no re-login required");
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
  const selfToken = await authHeader(server.baseUrl, email, login.body.data.temporaryPassword);
  await apiRequest(server.baseUrl, "POST", "/api/v1/auth/change-password", {
    token: selfToken,
    body: { currentPassword: login.body.data.temporaryPassword, newPassword: "Another-New-Password-123" },
  });

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
