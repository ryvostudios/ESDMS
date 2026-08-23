import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers, login } from "./setup.js";

let server;
let users;

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
});

after(async () => {
  await server.close();
  await pool.end();
});

// user_permission_overrides has no repository/API yet (that's future
// Workforce governance work) — tests exercise it directly, the same way
// schema.test.js exercises other tables' invariants directly.
afterEach(async () => {
  await pool.query("DELETE FROM user_permission_overrides");
});

async function permissionsFor(email) {
  const { cookie } = await login(server.baseUrl, email);
  const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
    headers: { Cookie: cookie, Origin: "http://localhost:5173" },
  });
  const body = await response.json();
  return new Set(body.data.user.permissions);
}

async function permissionId(code) {
  const result = await pool.query("SELECT id FROM permissions WHERE code = $1", [code]);
  return result.rows[0].id;
}

async function addOverride(userId, code, effect) {
  await pool.query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by_user_id)
     VALUES ($1, $2, $3, $4)`,
    [userId, await permissionId(code), effect, users.admin],
  );
}

test("a user with no overrides has exactly their role's permissions", async () => {
  const permissions = await permissionsFor("teamlead@test.eset.local");

  assert.deepEqual(
    [...permissions].sort(),
    ["gate_pass.create", "gate_pass.edit_draft", "gate_pass.submit", "gate_pass.view_own"],
  );
});

test("an individual GRANT adds a permission the user's role does not hold", async () => {
  await addOverride(users.teamLead, "gate_pass.approve", "GRANT");

  const permissions = await permissionsFor("teamlead@test.eset.local");

  assert.ok(permissions.has("gate_pass.approve"));
  assert.ok(permissions.has("gate_pass.create"), "role permissions are still present alongside the grant");
});

test("an individual DENY removes a permission the user's role would otherwise grant", async () => {
  await addOverride(users.siteManager, "gate_pass.approve", "DENY");

  const permissions = await permissionsFor("manager@test.eset.local");

  assert.ok(!permissions.has("gate_pass.approve"));
  assert.ok(permissions.has("gate_pass.view_site"), "unrelated role permissions are unaffected");
});

test("DENY wins even when the same permission is granted by role and the user also holds an unrelated grant", async () => {
  await addOverride(users.siteManager, "gate_pass.approve", "DENY");
  await addOverride(users.siteManager, "gate_pass.verify", "GRANT");

  const permissions = await permissionsFor("manager@test.eset.local");

  assert.ok(!permissions.has("gate_pass.approve"));
  assert.ok(permissions.has("gate_pass.verify"));
});
