import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { getUserProfileById } from "../src/shared/users/user-profile.repository.js";
let server, users, ceo;
const call = (token, method, path, body) => apiRequest(server.baseUrl, method, `/api/v1${path}`, { token, body });
const override = (token, id, code, effect = "GRANT") => call(token, "PUT", `/users/${id}/permissions/${code}`, { effect });
before(async () => {
  server = await startTestServer(); users = await seedUsers();
  ceo = await authHeader(server.baseUrl, "ceo@test.eset.local");
});
after(async () => {
  await pool.query("DELETE FROM user_permission_overrides WHERE user_id = ANY($1::uuid[])", [[users.hr, users.upperManagement, users.employee, users.teamLead]]);
  await server.close(); await pool.end();
});
for (const [key, email] of [["hr", "hr@test.eset.local"], ["upperManagement", "um@test.eset.local"]]) {
  test(`${key}: delegated governance is bounded, scoped and cannot defeat CEO restrictions`, async () => {
    const token = await authHeader(server.baseUrl, email);
    for (const code of ["users.view", "users.create", "users.update", "users.activate", "users.deactivate", "permission_overrides.view", "permission_overrides.manage", "employees.view"]) {
      assert.equal((await override(ceo, users[key], code)).status, 200);
    }
    const created = await call(token, "POST", "/users", {
      email: `aligned-${key}-${Date.now()}@test.eset.local`, fullName: "Ordinary employee", role: "EMPLOYEE", departmentId: users.departmentA,
    });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const id = created.body.data.id;
    for (const action of ["deactivate", "activate"]) assert.equal((await call(token, "POST", `/users/${id}/${action}`, {})).status, 200);
    assert.equal((await override(token, id, "employees.view")).status, 200);
    assert.equal((await override(token, id, "employees.view", "DENY")).status, 200);
    assert.ok(!(await getUserProfileById(id)).permissions.includes("employees.view"));
    assert.equal((await call(token, "DELETE", `/users/${id}/permissions/employees.view`)).status, 200);
    for (const code of ["users.manage_um", "users.create_um", "permission_overrides.manage", "workforce.all_sites", "demand.all_departments", "procurement.purchase"]) {
      assert.equal((await override(token, id, code)).status, 403, code);
    }
    for (const [role, status] of [["ADMIN", 403], ["CEO", 400], ["UPPER_MANAGEMENT", 403]]) {
      assert.equal((await call(token, "PATCH", `/users/${id}/role`, { role })).status, status);
    }
    assert.equal((await call(token, "PUT", `/users/${id}/bundles/PROCUREMENT_STAFF`, {})).status, 403);
    assert.equal((await call(token, "POST", `/users/${users.ceo}/deactivate`, {})).status, 403);
    assert.equal((await override(token, users[key], "employees.view")).status, 403);
    assert.equal((await call(token, "POST", `/users/${users.otherSiteTeamLead}/deactivate`, {})).status, 404);
    assert.equal((await call(token, "POST", "/users", { email: `foreign-${key}@test.eset.local`, fullName: "Foreign", role: "EMPLOYEE", siteId: users.otherSite })).status, 403);
    assert.equal((await override(ceo, id, "employees.view", "DENY")).status, 200);
    assert.equal((await override(token, id, "employees.view")).status, 403);
    assert.equal((await call(token, "DELETE", `/users/${id}/permissions/employees.view`)).status, 403);
    assert.ok(!(await getUserProfileById(id)).permissions.includes("employees.view"));
    assert.equal((await override(ceo, users[key], "users.create", "DENY")).status, 200);
    assert.equal((await call(token, "POST", "/users", { email: `denied-${key}@test.eset.local`, fullName: "Denied", role: "EMPLOYEE" })).status, 403);
  });
}
test("UM peer authority is explicit; delegated governors remain CEO-controlled", async () => {
  const hr = await authHeader(server.baseUrl, "hr@test.eset.local");
  assert.equal((await call(hr, "POST", `/users/${users.upperManagement}/deactivate`, {})).status, 403);
  assert.equal((await override(ceo, users.hr, "users.manage_um")).status, 200);
  assert.equal((await call(hr, "POST", `/users/${users.upperManagement}/deactivate`, {})).status, 403);
});
test("reference data preserves history and department membership grants no authority", async () => {
  const departments = await pool.query("SELECT name FROM departments WHERE site_id = $1", [users.mainSite]);
  for (const name of ["Administration", "Civil", "WTG", "HSE", "Procurement", "HR", "Electrical", "Mechanical", "Warehouse"]) assert.ok(departments.rows.some(row => row.name === name), name);
  const positions = await pool.query("SELECT code FROM positions WHERE site_id = $1", [users.mainSite]);
  for (const code of ["ADMINISTRATION_TL", "WTG_TL", "WTG_ASSISTANT_TL", "WTG_TECHNICIAN", "PROCUREMENT_STAFF"]) assert.ok(positions.rows.some(row => row.code === code), code);
  const original = await getUserProfileById(users.employee);
  for (const department of ["Administration", "WTG", "Procurement"]) {
    await pool.query("UPDATE users SET department_id = (SELECT id FROM departments WHERE site_id = $2 AND name = $3) WHERE id = $1", [users.employee, users.mainSite, department]);
    const profile = await getUserProfileById(users.employee);
    assert.equal(profile.role, "EMPLOYEE"); assert.deepEqual(profile.permissions, original.permissions);
    assert.ok(!profile.permissions.includes("procurement.pricing"));
  }
  assert.equal((await call(ceo, "PATCH", `/users/${users.employee}/role`, { role: "UPPER_MANAGEMENT" })).status, 200);
  assert.equal((await getUserProfileById(users.employee)).role, "UPPER_MANAGEMENT");
  await call(ceo, "PATCH", `/users/${users.employee}/role`, { role: "EMPLOYEE" });
});
test("bundle delegation requires every effective permission and preserves DENY", async () => {
  const hr = await authHeader(server.baseUrl, "hr@test.eset.local");
  const overview = await call(ceo, "GET", `/users/${users.teamLead}/permissions`);
  const bundle = overview.body.data.availableBundles.find(row => row.code === "PROCUREMENT_STAFF");
  for (const code of bundle.permissionCodes) assert.equal((await override(ceo, users.hr, code)).status, 200);
  assert.equal((await call(hr, "PUT", `/users/${users.teamLead}/bundles/PROCUREMENT_STAFF`, {})).status, 200);
  await override(ceo, users.teamLead, "procurement.pricing", "DENY");
  assert.ok(!(await getUserProfileById(users.teamLead)).permissions.includes("procurement.pricing"));
  assert.equal((await call(hr, "DELETE", `/users/${users.teamLead}/bundles/PROCUREMENT_STAFF`)).status, 200);
});

test("real WTG/Admin positions remain organizational; explicit UM promotion preserves assignment; delegated EMPLOYEE credentials are protected", async () => {
  const hr = await authHeader(server.baseUrl, "hr@test.eset.local");
  for (const [department, position] of [["Administration", "ADMINISTRATION_TL"], ["WTG", "WTG_TL"], ["Procurement", "PROCUREMENT_STAFF"]]) {
    const ref = (await pool.query(`SELECT p.id, p.department_id FROM positions p WHERE p.site_id = $1 AND p.code = $2`, [users.mainSite, position])).rows[0];
    const employee = await call(hr, "POST", "/employees", { employeeCode: `ORG_${position}_${Date.now()}`.slice(-30), fullLegalName: `${department} alignment`, joiningDate: "2026-01-01", departmentId: ref.department_id, positionId: ref.id });
    assert.equal(employee.status, 201, JSON.stringify(employee.body));
    const id = employee.body.data.id;
    assert.equal((await pool.query("SELECT user_id FROM employees WHERE id = $1", [id])).rows[0].user_id, null);
    const login = await call(hr, "POST", `/employees/${id}/login`, { email: `org-${position}-${Date.now()}@test.eset.local` });
    assert.equal(login.status, 201, JSON.stringify(login.body));
    const userId = login.body.data.userId;
    const profile = await getUserProfileById(userId);
    assert.equal(profile.role, "EMPLOYEE");
    assert.equal(profile.department_id, ref.department_id);
    assert.ok(!profile.permissions.includes("procurement.pricing"));
    assert.ok(!profile.permissions.includes("users.update"));
    if (department === "WTG") {
      assert.equal((await call(ceo, "PATCH", `/users/${userId}/role`, { role: "UPPER_MANAGEMENT" })).status, 200);
      assert.equal((await getUserProfileById(userId)).role, "UPPER_MANAGEMENT");
      const assignment = await pool.query("SELECT position_id FROM employment_assignments WHERE employee_id = $1", [id]);
      assert.equal(assignment.rows[0].position_id, ref.id);
    } else {
      assert.equal((await override(ceo, userId, "users.update")).status, 200);
      assert.equal((await call(hr, "POST", `/employees/${id}/login/reset`, {})).status, 403);
      assert.equal((await call(hr, "POST", `/employees/${id}/status`, { status: "INACTIVE" })).status, 403);
    }
  }
});

test("an override mutation waits for the target lock and rechecks a concurrent promotion to CEO", async () => {
  const hr = await authHeader(server.baseUrl, "hr@test.eset.local");
  const created = await call(ceo, "POST", "/users", { email: `race-${Date.now()}@test.eset.local`, fullName: "Race target", role: "EMPLOYEE" });
  const id = created.body.data.id;
  const client = await pool.connect();
  let request;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [id]);
    request = override(hr, id, "employees.view");
    // Verify an actual waiting database lock, not an assumed scheduling delay.
    let waiting = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      const result = await pool.query("SELECT 1 FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND query LIKE '%FROM users WHERE id = $1 FOR UPDATE%'");
      if (result.rowCount) { waiting = true; break; }
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    assert.ok(waiting, "governance mutation locks its target");
    await client.query("UPDATE users SET role_id = (SELECT id FROM roles WHERE name = 'CEO') WHERE id = $1", [id]);
    await client.query("COMMIT");
    assert.equal((await request).status, 403);
    assert.equal((await pool.query("SELECT 1 FROM user_permission_overrides WHERE user_id = $1", [id])).rowCount, 0);
  } finally { await client.query("ROLLBACK"); client.release(); if (request) await request; }
});

test("temporary credential recovery cannot give a delegate authority they do not hold", async () => {
  const hr = await authHeader(server.baseUrl, "hr@test.eset.local");
  await override(ceo, users.hr, "users.regenerate_temp_password");
  const created = await call(ceo, "POST", "/users", { email: `credential-${Date.now()}@test.eset.local`, fullName: "Protected credential", role: "ADMIN" });
  assert.equal(created.status, 201);
  const id = created.body.data.id;
  assert.equal((await call(hr, "POST", `/users/${id}/regenerate-temp-password`, {})).status, 403);
  const audit = await pool.query("SELECT 1 FROM governance_audit_log WHERE target_user_id = $1 AND action = 'PRIVILEGE_ESCALATION_ATTEMPT'", [id]);
  assert.equal(audit.rowCount, 1);
});

test("reference migration reapplication and rollback preserve records and assignments", async () => {
  const migration = await import("../migrations/1787432000000_company-organization-reference.js");
  const before = await pool.query("SELECT id, name, is_active FROM positions ORDER BY id");
  const queries = [];
  await migration.up({ sql: sql => queries.push(sql) });
  for (const sql of queries) await pool.query(sql);
  await migration.down();
  assert.deepEqual((await pool.query("SELECT id, name, is_active FROM positions ORDER BY id")).rows, before.rows);
});
