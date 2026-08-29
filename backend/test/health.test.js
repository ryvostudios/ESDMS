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

test("GET /health/ready fails closed on a migrated but unprovisioned database", async () => {
  const { status, body } = await apiRequest(server.baseUrl, "GET", "/api/v1/health/ready");
  assert.equal(status, 503);
  assert.equal(body.data.status, "not_ready");
  assert.equal(body.data.schemaCompatible, true);
  assert.equal(body.data.runtimeProvisioningCompatible, false);
  assert.equal(
    body.data.expectedRuntimeProvisioning,
    "1787427000000_driver-vehicle-master-and-gate-evidence",
  );
  assert.equal(body.data.expectedMigration, "1787427000000_driver-vehicle-master-and-gate-evidence");
  assert.ok(body.data.appliedMigrationCount >= body.data.expectedMigrationCount);
  assert.match(body.data.backendRevision, /^[A-Za-z0-9._-]+$/);
});
