import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import jwt from "jsonwebtoken";
import pool from "../src/config/database.js";
import config from "../src/config/env.js";
import { startTestServer, seedUsers, login } from "./setup.js";
import {
  UNAUTHENTICATED_IP_LIMIT,
  AUTHENTICATED_USER_LIMIT,
  AUTHENTICATED_IP_LIMIT,
} from "../src/middleware/rate-limit.js";

function cookieHeader(token) {
  return `${config.sessionCookieName}=${token}`;
}

let server;

before(async () => {
  server = await startTestServer();
  await seedUsers();
});

after(async () => {
  await server.close();
  await pool.end();
});

// ESDMS-017: the exact numeric ceilings are a single source of truth in
// rate-limit.js's own config objects. Fast, exact, unit-level checks
// instead of firing thousands of real HTTP requests to find a boundary.
test("configured limits match the required architecture", () => {
  assert.equal(UNAUTHENTICATED_IP_LIMIT, 3000, "unauthenticated per-IP ceiling");
  assert.equal(AUTHENTICATED_USER_LIMIT, 600, "authenticated per-user quota stays ~600/15min");
  assert.ok(AUTHENTICATED_IP_LIMIT >= 30000, "authenticated per-IP abuse ceiling must be >= 30,000/15min");
});

test("an unauthenticated request is governed by the lower, per-IP ceiling", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/employees`, {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("ratelimit-limit"), "3000");
});

test("an authenticated request is governed by the per-user quota, not the unauthenticated IP ceiling", async () => {
  const { cookie } = await login(server.baseUrl, "hr@test.eset.local");
  const response = await fetch(`${server.baseUrl}/api/v1/employees`, {
    headers: { Origin: "http://localhost:5173", Cookie: cookie },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("ratelimit-limit"), "600", "the authenticated per-user limiter must be the one reporting, not 3000");
});

test("two authenticated users behind the same IP have independent quotas", async () => {
  // Use accounts not already spent by earlier tests in this file (the
  // in-memory limiter store persists per test file/process) — a fresh
  // baseline read establishes each account's own current remaining count
  // rather than assuming a pristine 600.
  const um = await login(server.baseUrl, "um@test.eset.local");
  const admin = await login(server.baseUrl, "admin@test.eset.local");

  const umBaseline = await fetch(`${server.baseUrl}/api/v1/employees`, {
    headers: { Origin: "http://localhost:5173", Cookie: um.cookie },
  });
  const umBaselineRemaining = Number(umBaseline.headers.get("ratelimit-remaining"));

  const umSecond = await fetch(`${server.baseUrl}/api/v1/employees`, {
    headers: { Origin: "http://localhost:5173", Cookie: um.cookie },
  });
  const adminFirst = await fetch(`${server.baseUrl}/api/v1/employees`, {
    headers: { Origin: "http://localhost:5173", Cookie: admin.cookie },
  });

  assert.equal(
    Number(umSecond.headers.get("ratelimit-remaining")),
    umBaselineRemaining - 1,
    "UM's own remaining count decrements by exactly 1 for UM's own 2nd request",
  );
  assert.equal(
    Number(adminFirst.headers.get("ratelimit-remaining")),
    600 - 1,
    "admin's independent bucket reflects only admin's own 1st request, unaffected by UM's usage",
  );
});

test("an unauthenticated caller cannot reach the high authenticated-IP ceiling", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/employees`, {
    headers: { Origin: "http://localhost:5173" },
  });
  assert.notEqual(response.headers.get("ratelimit-limit"), "30000", "the 30,000 ceiling must never be visible to an unauthenticated request");
});

test("no token: governed by the unauthenticated per-IP ceiling", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/employees`, { headers: { Origin: "http://localhost:5173" } });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("ratelimit-limit"), "3000");
});

test("malformed token: still governed by the unauthenticated per-IP ceiling, not zero coverage", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/employees`, {
    headers: { Origin: "http://localhost:5173", Cookie: cookieHeader("not-a-real-jwt") },
  });
  assert.equal(response.status, 401);
  assert.equal(response.headers.get("ratelimit-limit"), "3000");
});

test("expired/invalid-signature token: still governed by the unauthenticated per-IP ceiling", async () => {
  const wrongSignature = jwt.sign({ sub: "x", sv: 0 }, "a-completely-different-secret-not-the-real-one", {
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
    expiresIn: "1h",
  });
  const expired = jwt.sign({ sub: "x", sv: 0 }, config.jwtSecret, {
    issuer: config.jwtIssuer,
    audience: config.jwtAudience,
    expiresIn: "-10s",
  });

  for (const token of [wrongSignature, expired]) {
    const response = await fetch(`${server.baseUrl}/api/v1/employees`, {
      headers: { Origin: "http://localhost:5173", Cookie: cookieHeader(token) },
    });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("ratelimit-limit"), "3000");
  }
});

// THE bypass this fix closes: a token that is cryptographically valid
// (real signature, real issuer/audience, unexpired) but authoritatively
// stale — session_version revoked via logout — used to skip the low
// unauthenticated ceiling (it "looks" authenticated) and then fail
// authenticate.js before ever reaching an authenticated-only limiter,
// landing with NO rate-limit coverage at all. It must now always be
// covered by the global coarse ceiling applied to every request.
test("cryptographically valid but revoked session token is still rate-limited (the closed bypass)", async () => {
  const { cookie } = await login(server.baseUrl, "hr@test.eset.local");

  const revoke = await fetch(`${server.baseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: { Origin: "http://localhost:5173", Cookie: cookie },
  });
  assert.equal(revoke.status, 200);

  // Replay the now-revoked (but signature/expiry/issuer/audience-valid)
  // token — authenticate.js must still reject it...
  const replay = await fetch(`${server.baseUrl}/api/v1/employees`, {
    headers: { Origin: "http://localhost:5173", Cookie: cookie },
  });
  assert.equal(replay.status, 401, "a revoked session must still be rejected");
  // ...but it must be counted against the coarse global ceiling (30,000),
  // never against nothing at all. It "looks" authenticated to the
  // unauthenticated limiter's skip check, so 30000 — not 3000 — proves it
  // landed in a real bucket rather than bypassing both.
  assert.equal(
    replay.headers.get("ratelimit-limit"),
    "30000",
    "a revoked-but-signature-valid token must still consume a real rate-limit bucket, never bypass all limiting",
  );
});

// Login brute-force protection is unchanged by this fix — reconfirmed here
// directly rather than only relying on auth.test.js, since it's the
// invariant this whole redesign must not weaken.
test("login brute-force limiting remains strict and per-IP", async () => {
  const attempts = [];
  for (let i = 0; i < 31; i += 1) {
    attempts.push(
      fetch(`${server.baseUrl}/api/v1/auth/login`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
        body: JSON.stringify({ email: "nobody-ratelimit-test@test.eset.local", password: "wrong-password" }),
      }),
    );
  }
  const statuses = await Promise.all(attempts.map((p) => p.then((r) => r.status)));
  assert.ok(statuses.includes(429), "31 rapid failed login attempts from one IP must eventually be throttled (limit is 30/15min)");
});
