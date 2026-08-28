import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer } from "./setup.js";

let server;

before(async () => {
  server = await startTestServer();
});

after(async () => {
  await server.close();
  await pool.end();
});

test("malformed JSON is a safe 400", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: '{"email":',
  });
  const body = await response.json();
  assert.equal(response.status, 400);
  assert.equal(body.error.code, "MALFORMED_JSON");
  assert.doesNotMatch(JSON.stringify(body), /SyntaxError|stack|node_modules|\/private\//i);
});

test("a null invalid body is a 400", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: "null",
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).error.code, "VALIDATION_ERROR");
});

test("an oversized JSON body is a safe 413", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ email: "a@example.com", password: "x".repeat(1024 * 1024) }),
  });
  const body = await response.json();
  assert.equal(response.status, 413);
  assert.equal(body.error.code, "PAYLOAD_TOO_LARGE");
  assert.doesNotMatch(JSON.stringify(body), /stack|node_modules|\/private\//i);
});
