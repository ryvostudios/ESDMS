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

test("valid login sets the session cookie and returns the user profile, with NO token field", async () => {
  const { status, body, cookie } = await login(server.baseUrl, "admin@test.eset.local");

  assert.equal(status, 200);
  assert.equal(body.success, true);
  assert.equal(body.data.token, undefined, "the JWT must never appear in the login JSON response");
  assert.equal(body.data.user.role, "ADMIN");
  assert.ok(cookie, "expected a session cookie to be set");
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

test("/auth/me without a session is rejected", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
    headers: { Origin: "http://localhost:5173" },
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHORIZED");
});

test("/auth/me with a malformed session cookie is rejected", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
    headers: { Cookie: "esdms_session=not-a-real-token", Origin: "http://localhost:5173" },
  });
  const body = await response.json();

  assert.equal(response.status, 401);
  assert.equal(body.error.code, "UNAUTHORIZED");
});

test("/auth/me with a valid session returns the authenticated user", async () => {
  const { cookie } = await login(server.baseUrl, "admin@test.eset.local");

  const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
    headers: { Cookie: cookie, Origin: "http://localhost:5173" },
  });
  const body = await response.json();

  assert.equal(response.status, 200);
  assert.equal(body.data.user.id, users.admin);
  // Login and /auth/me must return the same user shape — the frontend's
  // AuthContext relies on this to survive a page reload without losing
  // fields the login response had.
  assert.equal(body.data.user.email, "admin@test.eset.local");
});

test("a session stays rejected when the user is deactivated after login", async () => {
  const { cookie } = await login(server.baseUrl, "teamlead@test.eset.local");

  await pool.query("UPDATE users SET is_active = false WHERE id = $1", [users.teamLead]);

  const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
    headers: { Cookie: cookie, Origin: "http://localhost:5173" },
  });

  assert.equal(response.status, 401);

  await pool.query("UPDATE users SET is_active = true WHERE id = $1", [users.teamLead]);
});

test("a session stays rejected when its ROLE is deactivated, even though the user account itself is still active", async () => {
  const { cookie } = await login(server.baseUrl, "teamlead@test.eset.local");

  await pool.query(
    "UPDATE roles SET is_active = false WHERE id = (SELECT role_id FROM users WHERE id = $1)",
    [users.teamLead],
  );

  try {
    const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
      headers: { Cookie: cookie, Origin: "http://localhost:5173" },
    });

    assert.equal(response.status, 401);

    const loginAttempt = await login(server.baseUrl, "teamlead@test.eset.local");
    assert.equal(loginAttempt.status, 401);
  } finally {
    await pool.query(
      "UPDATE roles SET is_active = true WHERE id = (SELECT role_id FROM users WHERE id = $1)",
      [users.teamLead],
    );
  }
});

test("a session stays rejected when its SITE is deactivated, even though user and role are still active", async () => {
  const { cookie } = await login(server.baseUrl, "teamlead@test.eset.local");

  await pool.query("UPDATE sites SET is_active = false WHERE id = (SELECT site_id FROM users WHERE id = $1)", [
    users.teamLead,
  ]);

  try {
    const response = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
      headers: { Cookie: cookie, Origin: "http://localhost:5173" },
    });
    assert.equal(response.status, 401);

    const loginAttempt = await login(server.baseUrl, "teamlead@test.eset.local");
    assert.equal(loginAttempt.status, 401);
  } finally {
    await pool.query(
      "UPDATE sites SET is_active = true WHERE id = (SELECT site_id FROM users WHERE id = $1)",
      [users.teamLead],
    );
  }
});

test("login sets an HttpOnly, SameSite=Lax session cookie that /auth/me accepts on its own", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ email: "admin@test.eset.local", password: TEST_PASSWORD }),
  });

  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie, "expected login to set a session cookie");
  assert.match(setCookie, /esdms_session=/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Lax/i);

  const cookiePair = setCookie.split(";")[0];

  const meResponse = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
    headers: { Origin: "http://localhost:5173", Cookie: cookiePair },
  });
  const meBody = await meResponse.json();

  assert.equal(meResponse.status, 200);
  assert.equal(meBody.data.user.email, "admin@test.eset.local");
});

test("logout clears the session cookie AND revokes it — a replayed pre-logout session is rejected", async () => {
  const { cookie } = await login(server.baseUrl, "admin@test.eset.local");

  const logoutResponse = await fetch(`${server.baseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: { Origin: "http://localhost:5173", Cookie: cookie },
  });

  const clearedCookie = logoutResponse.headers.get("set-cookie");
  assert.equal(logoutResponse.status, 200);
  assert.match(clearedCookie, /esdms_session=;/);
  assert.match(clearedCookie, /Expires=Thu, 01 Jan 1970/i);

  // The old cookie value itself — captured before logout, exactly as a
  // thief who stole it earlier would have it — must no longer work, even
  // though its signature and expiry are both still perfectly valid.
  const replay = await fetch(`${server.baseUrl}/api/v1/auth/me`, {
    headers: { Origin: "http://localhost:5173", Cookie: cookie },
  });
  assert.equal(replay.status, 401);
});

test("logout with no session (already logged out, or never logged in) still succeeds", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/auth/logout`, {
    method: "POST",
    headers: { Origin: "http://localhost:5173" },
  });

  assert.equal(response.status, 200);
});

test("CORS rejects an unrecognized origin", async () => {
  const response = await fetch(`${server.baseUrl}/api/v1/health`, {
    headers: { Origin: "http://evil.example" },
  });

  assert.equal(response.status, 403);
});

// Placed last: intentionally exhausts the login rate limit for the rest of
// this process, which would break earlier 401-expecting tests if it ran
// before them.
test("repeated failed logins are rate-limited, but successful logins never count against that budget", async () => {
  // Several people can share one IP behind a site/office NAT — a shared
  // budget across successful logins would let one person's normal sign-ins
  // lock out everyone else at the same gate. Prove real successes here
  // don't consume the failed-attempt budget, regardless of how many.
  for (let i = 0; i < 5; i++) {
    const { status } = await login(server.baseUrl, "admin@test.eset.local");
    assert.equal(status, 200);
  }

  let sawTooManyRequests = false;

  for (let i = 0; i < 10; i++) {
    const { status, body } = await login(server.baseUrl, "admin@test.eset.local", "wrong-password");

    if (status === 429) {
      sawTooManyRequests = true;
      assert.equal(body.error.code, "TOO_MANY_REQUESTS");
      break;
    }

    assert.equal(status, 401);
  }

  assert.ok(sawTooManyRequests, "expected repeated failed logins to eventually be rate-limited");
});
