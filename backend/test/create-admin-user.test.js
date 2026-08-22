import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pool from "../src/config/database.js";
import { startTestServer } from "./setup.js";
import { apiRequest } from "./gate-pass-helpers.js";

const scriptPath = path.resolve(import.meta.dirname, "../scripts/create-admin-user.js");
const envPath = path.resolve(import.meta.dirname, "../.env.test");

const testEmail = `bootstrap-admin-${Date.now()}@test.eset.local`;

after(async () => {
  await pool.query("DELETE FROM users WHERE email = $1", [testEmail]);
  await pool.end();
});

function runScript(env) {
  return spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, DOTENV_CONFIG_PATH: envPath, ...env },
    encoding: "utf8",
  });
}

test("scripts/create-admin-user.js creates a real, working ADMIN account — no browser registration involved", async () => {
  const created = runScript({
    ADMIN_EMAIL: testEmail,
    ADMIN_FULL_NAME: "Bootstrap Admin",
    ADMIN_PASSWORD: "Bootstrap-Admin-Pw-123",
  });

  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /Admin user created/);

  const server = await startTestServer();
  try {
    const login = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
      body: { email: testEmail, password: "Bootstrap-Admin-Pw-123" },
    });

    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.data.user.role, "ADMIN");
    assert.equal(login.body.data.token, undefined, "login response must never include a raw token");
  } finally {
    await server.close();
  }
});

test("running it again for the same email is rejected, not silently re-created", () => {
  const duplicate = runScript({
    ADMIN_EMAIL: testEmail,
    ADMIN_FULL_NAME: "Bootstrap Admin",
    ADMIN_PASSWORD: "Bootstrap-Admin-Pw-123",
  });

  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already exists/);
});

test("a password under 12 characters is rejected before touching the database", () => {
  const result = runScript({
    ADMIN_EMAIL: `${testEmail}-2`,
    ADMIN_FULL_NAME: "Bootstrap Admin",
    ADMIN_PASSWORD: "short",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at least 12 characters/);
});
