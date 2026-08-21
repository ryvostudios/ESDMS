import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers, login, TEST_PASSWORD } from "./setup.js";

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

test("valid login returns a token and user profile", async () => {
  const { status, body } = await login(server.baseUrl, "admin@test.eset.local");

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.ok(body.data.token);
  assert.equal(body.data.user.role, "ADMIN");
});

test("invalid password is rejected without leaking which part was wrong", async () => {
  const { status, body } = await login(server.baseUrl, "admin@test.eset.local", "wrong-password");

  assert.equal(status, 401);
  assert.equal(body.error.code, "UNAUTHORIZED");
  assert.equal(body.error.message, "Invalid email or password.");
});

test("unknown email returns the identical response as wrong password", async () => {
  const { status, body } = await login(server.baseUrl, "nobody@test.eset.local", TEST_PASSWORD);

  assert.equal(status, 401);
  assert.equal(body.error.message, "Invalid email or password.");
});

test("inactive user cannot log in", async () => {
  const { status, body } = await login(server.baseUrl, "inactive@test.eset.local");

  assert.equal(status, 401);
  assert.equal(body.error.message, "Invalid email or password.");
});

test("/auth/me without a token is rejected", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
    headers: { Origin: "http://localhost:5173" },
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHORIZED");
});

test("/auth/me with a malformed token is rejected", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
    headers: { Authorization: "Bearer not-a-real-token", Origin: "http://localhost:5173" },
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHORIZED");
});

test("/auth/me with a valid token returns the authenticated user", async () => {
  const { body: loginBody } = await login(server.baseUrl, "admin@test.eset.local");

  const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${loginBody.data.token}`, Origin: "http://localhost:5173" },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.user.id, users.admin);
  // Login and /auth/me must return the same user shape — the frontend's
  // AuthContext relies on this to survive a page reload without losing
  // fields the login response had.
  assert.equal(body.data.user.email, "admin@test.eset.local");
});

test("a token for a user who is deactivated after login is rejected on next use", async () => {
  const { body: loginBody } = await login(server.baseUrl, "teamlead@test.eset.local");

  await pool.query("UPDATE users SET is_active = false WHERE id = $1", [users.teamLead]);

  const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
    headers: { Authorization: `Bearer ${loginBody.data.token}`, Origin: "http://localhost:5173" },
  });

  assert.equal(response.status, 401);

  await pool.query("UPDATE users SET is_active = true WHERE id = $1", [users.teamLead]);
});

test("CORS rejects an unrecognized origin", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/health`, {
    headers: { Origin: "http://evil.example" },
  });

  assert.equal(response.status, 403);
});
