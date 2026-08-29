import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer } from "./setup.js";
import { apiRequest } from "./gate-pass-helpers.js";

let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
  await pool.end();
});

test("GET /health is a liveness check — no dependency checks", async () => {
  const { status, body } = await apiRequest(server.baseUrl, "GET", "/api/v1/health");
  assert.equal(status, 200);
  assert.equal(body.data.status, "ok");
});

test("GET /health/ready is a readiness check that actually queries the database", async () => {
  const { status, body } = await apiRequest(server.baseUrl, "GET", "/api/v1/health/ready");
  assert.equal(status, 200);
  assert.equal(body.data.status, "ready");
  assert.equal(body.data.schemaCompatible, true);
  assert.equal(body.data.expectedMigration, "1787426000000_governance-capability-bundles");
  assert.ok(body.data.appliedMigrationCount >= body.data.expectedMigrationCount);
  assert.match(body.data.backendRevision, /^[A-Za-z0-9._-]+$/);
});
