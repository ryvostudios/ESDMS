import { test, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import pool from "../src/config/database.js";
import { startTestServer } from "./setup.js";
import { apiRequest, authHeader } from "./gate-pass-helpers.js";

const scriptPath = path.resolve(import.meta.dirname, "../scripts/create-ceo-user.js");
const envPath = path.resolve(import.meta.dirname, "../.env.test");

const testEmail = `bootstrap-ceo-${Date.now()}@test.eset.local`;
const testEmailVariant = (suffix) => testEmail.replace("@", `-${suffix}@`);

after(async () => {
  await pool.end();
});

function runScript(env) {
  return spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, DOTENV_CONFIG_PATH: envPath, ...env },
    encoding: "utf8",
  });
}

test("scripts/create-ceo-user.js creates a real, working CEO account — no browser registration involved", async () => {
  const created = runScript({
    CEO_EMAIL: testEmail,
    CEO_FULL_NAME: "Bootstrap CEO",
    CEO_PASSWORD: "Bootstrap-CEO-Pw-123",
  });

  assert.equal(created.status, 0, created.stderr);
  assert.match(created.stdout, /CEO user created/);

  const server = await startTestServer();
  try {
    const login = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
      body: { email: testEmail, password: "Bootstrap-CEO-Pw-123" },
    });

    assert.equal(login.status, 200, JSON.stringify(login.body));
    assert.equal(login.body.data.user.role, "CEO");
    assert.equal(login.body.data.token, undefined, "login response must never include a raw token");
  } finally {
    await server.close();
  }
});

test("running it again for a different email while a CEO already exists is allowed and explicit, not silent", () => {
  const secondCeo = runScript({
    CEO_EMAIL: testEmailVariant("second"),
    CEO_FULL_NAME: "Second Bootstrap CEO",
    CEO_PASSWORD: "Bootstrap-CEO-Pw-456",
  });

  assert.equal(secondCeo.status, 0, secondCeo.stderr);
  assert.match(secondCeo.stdout, /active CEO account\(s\) already exist/);
  assert.match(secondCeo.stdout, /CEO user created/);
});

test("running it again for the same email is rejected, not silently re-created", () => {
  const duplicate = runScript({
    CEO_EMAIL: testEmail,
    CEO_FULL_NAME: "Bootstrap CEO",
    CEO_PASSWORD: "Bootstrap-CEO-Pw-123",
  });

  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /already exists/);
});

test("a password under 12 characters is rejected before touching the database", () => {
  const result = runScript({
    CEO_EMAIL: testEmailVariant("short"),
    CEO_FULL_NAME: "Bootstrap CEO",
    CEO_PASSWORD: "short",
  });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /at least 12 characters/);
});

test("a password piped via stdin (no CEO_PASSWORD env var) works — the shell-history-safe path", () => {
  const email = testEmailVariant("stdin");
  const result = spawnSync(process.execPath, [scriptPath], {
    env: { ...process.env, DOTENV_CONFIG_PATH: envPath, CEO_EMAIL: email, CEO_FULL_NAME: "Bootstrap CEO" },
    input: "Bootstrap-CEO-Pw-789",
    encoding: "utf8",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /CEO user created/);
});

test("bootstrapping while the CEO role itself is deactivated is rejected", async () => {
  await pool.query("UPDATE roles SET is_active = false WHERE name = 'CEO'");

  try {
    const result = runScript({
      CEO_EMAIL: testEmailVariant("inactive-role"),
      CEO_FULL_NAME: "Bootstrap CEO",
      CEO_PASSWORD: "Bootstrap-CEO-Pw-123",
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /"CEO" role exists but is deactivated/);
  } finally {
    await pool.query("UPDATE roles SET is_active = true WHERE name = 'CEO'");
  }
});

test("CEO cannot be created through the ordinary user-management API — only via this script", async () => {
  const server = await startTestServer();
  try {
    const ceoToken = await authHeader(server.baseUrl, testEmail, "Bootstrap-CEO-Pw-123");

    const response = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
      token: ceoToken,
      body: {
        email: testEmailVariant("via-api"),
        fullName: "Attempted API CEO",
        password: "Attempted-Api-Ceo-Pw-123",
        role: "CEO",
      },
    });

    assert.equal(response.status, 400, "CEO must not even be a valid role value in the user-management API");
  } finally {
    await server.close();
  }
});
