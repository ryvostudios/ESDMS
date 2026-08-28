import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { apiRequest, authHeader } from "./gate-pass-helpers.js";

let server;
let users;
let token;

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  token = await authHeader(server.baseUrl, "teamlead@test.eset.local");
});

after(async () => {
  await server.close();
  await pool.end();
});

test("optional Demand filters normalize omitted, empty and null placeholders", async () => {
  for (const suffix of [
    "",
    "?departmentId=",
    "?departmentId=null",
    "?status=",
    "?search=",
    "?departmentId=&status=&search=",
  ]) {
    const response = await apiRequest(server.baseUrl, "GET", `/api/v1/demands${suffix}`, { token });
    assert.equal(response.status, 200, `${suffix || "omitted"}: ${JSON.stringify(response.body)}`);
  }
});

test("query validation is strict, accepts pageSize 100, and surfaces a useful top-level error", async () => {
  const unknown = await apiRequest(server.baseUrl, "GET", "/api/v1/demands?surprise=true", { token });
  assert.equal(unknown.status, 400);
  assert.match(unknown.body.error.message, /unrecognized key|surprise/i);
  assert.notEqual(unknown.body.error.message, "Invalid request.");

  const atCap = await apiRequest(server.baseUrl, "GET", "/api/v1/demands?pageSize=100", { token });
  assert.equal(atCap.status, 200);
  assert.equal(atCap.body.meta.pageSize, 100);

  const tooLarge = await apiRequest(server.baseUrl, "GET", "/api/v1/demands?pageSize=101", { token });
  assert.equal(tooLarge.status, 400);
  assert.match(tooLarge.body.error.message, /less than or equal to 100|<=100|too big/i);
});

test("catalog pagination serves more than 100 results without truncation", async () => {
  const uom = await pool.query("SELECT id FROM units_of_measure ORDER BY code LIMIT 1");
  await pool.query(
    `WITH created AS (
       INSERT INTO company_items (name, created_by_user_id)
       SELECT 'Pagination material ' || $1 || '-' || n, $2
       FROM generate_series(1, 105) AS n
       RETURNING id
     )
     INSERT INTO department_material_catalog
       (department_id, company_item_id, default_uom_id, created_by_user_id)
     SELECT $3, id, $4, $2 FROM created`,
    [Date.now(), users.teamLead, users.departmentA, uom.rows[0].id],
  );

  const first = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog?page=1&pageSize=100", { token });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(first.body.data.length, 100);
  assert.ok(first.body.meta.total > 100);

  const second = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog?page=2&pageSize=100", { token });
  assert.equal(second.status, 200);
  assert.ok(second.body.data.length > 0);
  assert.equal(new Set([...first.body.data, ...second.body.data].map((row) => row.id)).size, first.body.data.length + second.body.data.length);
});
