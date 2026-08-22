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
});
