import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers, login } from "./setup.js";

let server;

before(async () => {
  server = await startTestServer();
  await seedUsers();
});

after(async () => {
  await server.close();
  await pool.end();
});

async function permissionsFor(email) {
  const { cookie } = await login(server.baseUrl, email);

  const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
    headers: { Cookie: cookie, Origin: "http://localhost:5173" },
  });
  const meBody = await response.json();

  return new Set(meBody.data.user.permissions);
}

test("TEAM_LEAD can create/submit but cannot approve or perform guard actions", async () => {
  const permissions = await permissionsFor("teamlead@test.eset.local");

  assert.ok(permissions.has("gate_pass.create"));
  assert.ok(permissions.has("gate_pass.submit"));
  assert.ok(!permissions.has("gate_pass.approve"));
  assert.ok(!permissions.has("gate_pass.reject"));
  assert.ok(!permissions.has("gate_pass.exit"));
  assert.ok(!permissions.has("gate_pass.return"));
});

test("ADMIN holds both create and approve as distinct permissions", async () => {
  const permissions = await permissionsFor("admin@test.eset.local");

  assert.ok(permissions.has("gate_pass.create"));
  assert.ok(permissions.has("gate_pass.approve"));
  assert.ok(!permissions.has("gate_pass.exit"), "Admin must not receive Guard-only actions");
});

test("SITE_MANAGER can approve site-wide", async () => {
  const permissions = await permissionsFor("manager@test.eset.local");

  assert.ok(permissions.has("gate_pass.approve"));
  assert.ok(permissions.has("gate_pass.view_site"));
});

test("GATE_GUARD is restricted to verify/exit/return only", async () => {
  const permissions = await permissionsFor("guard@test.eset.local");

  assert.deepEqual(
    [...permissions].sort(),
    ["gate_pass.exit", "gate_pass.return", "gate_pass.verify"],
  );
});
