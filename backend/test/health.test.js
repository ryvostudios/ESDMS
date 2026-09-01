import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer } from "./setup.js";
import { apiRequest } from "./gate-pass-helpers.js";
import { EXPECTED_MIGRATION } from "../src/shared/db/schema-compatibility.js";
import { EXPECTED_RUNTIME_PROVISIONING } from "../src/shared/db/runtime-compatibility.js";

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
  // The test database is migrated but never provisioned, so this is the exact
  // deployment shape the readiness contract exists to refuse: every table
  // present, yet the runtime privilege boundary unproven. Compared against the
  // exported constants rather than copies of their values, so a future
  // migration does not have to edit this test for no signal.
  assert.equal(status, 503);
  assert.equal(body.data.status, "not_ready");
  assert.equal(body.data.ready, false);
  assert.equal(body.data.schemaCompatible, true);
  assert.equal(body.data.runtimeProvisioningCompatible, false);
  assert.equal(body.data.expectedMigration, EXPECTED_MIGRATION);
  assert.equal(body.data.expectedRuntimeProvisioning, EXPECTED_RUNTIME_PROVISIONING);
  assert.ok(body.data.appliedMigrationCount >= body.data.expectedMigrationCount);
  assert.match(body.data.backendRevision, /^[A-Za-z0-9._-]+$/);
});
