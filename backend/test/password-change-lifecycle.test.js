import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import argon2 from "argon2";
import jwt from "jsonwebtoken";
import pool from "../src/config/database.js";
import config from "../src/config/env.js";
import { startTestServer, seedUsers, login, TEST_PASSWORD } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server, users;
before(async () => { server = await startTestServer(); users = await seedUsers(); });
after(async () => { await server.close(); await pool.end(); });
const request = (method, path, options) => apiRequest(server.baseUrl, method, `/api/v1${path}`, options);

for (const source of ["governance", "workforce"]) {
  test(`${source} temporary password lifecycle: persisted flag, new credentials, revoked sessions and repeated login/me`, async () => {
    const creator = await authHeader(server.baseUrl, source === "governance" ? "ceo@test.eset.local" : "hr@test.eset.local");
    const email = `password-${source}-${Date.now()}@test.eset.local`;
    let userId, temporaryPassword;
    if (source === "governance") {
      const created = await request("POST", "/users", { token: creator, body: { email, fullName: "Password lifecycle", role: "EMPLOYEE" } });
      assert.equal(created.status, 201);
      ({ id: userId, temporaryPassword } = created.body.data);
    } else {
      const employee = await request("POST", "/employees", { token: creator, body: {
        employeeCode: `PW_${Date.now()}`, fullLegalName: "Password lifecycle employee", joiningDate: "2026-01-01",
      } });
      assert.equal(employee.status, 201);
      const created = await request("POST", `/employees/${employee.body.data.id}/login`, { token: creator, body: { email } });
      assert.equal(created.status, 201);
      ({ userId, temporaryPassword } = created.body.data);
    }
    const before = (await pool.query("SELECT must_change_password, session_version FROM users WHERE id = $1", [userId])).rows[0];
    assert.equal(before.must_change_password, true);
    const initial = await login(server.baseUrl, email, temporaryPassword);
    assert.equal(initial.status, 200);
    assert.equal(initial.body.data.user.mustChangePassword, true);
    const initialMe = await request("GET", "/auth/me", { token: initial.cookie });
    assert.equal(initialMe.body.data.user.mustChangePassword, true);
    const otherSession = await authHeader(server.baseUrl, email, temporaryPassword);
    const newPassword = "Changed-Lifecycle-Password-123!";
    const changed = await request("POST", "/auth/change-password", {
      token: initial.cookie, body: { currentPassword: temporaryPassword, newPassword },
    });
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body.data, { requiresLogin: true });
    assert.match(changed.raw.headers.get("set-cookie"), /Expires=Thu, 01 Jan 1970/);
    const saved = (await pool.query("SELECT password_hash, must_change_password, session_version FROM users WHERE id = $1", [userId])).rows[0];
    assert.equal(saved.must_change_password, false);
    assert.equal(saved.session_version, before.session_version + 1);
    assert.equal(await argon2.verify(saved.password_hash, newPassword), true);
    assert.equal(await argon2.verify(saved.password_hash, temporaryPassword), false);
    for (const token of [initial.cookie, otherSession]) assert.equal((await request("GET", "/auth/me", { token })).status, 401);
    assert.equal((await login(server.baseUrl, email, temporaryPassword)).status, 401);
    for (let attempt = 0; attempt < 2; attempt++) {
      const signedIn = await login(server.baseUrl, email, newPassword);
      assert.equal(signedIn.status, 200);
      assert.equal(signedIn.body.data.user.mustChangePassword, false);
      assert.equal(signedIn.body.data.user.password_hash, undefined);
      assert.equal(signedIn.body.data.token, undefined);
      const me = await request("GET", "/auth/me", { token: signedIn.cookie });
      assert.equal(me.status, 200);
      assert.deepEqual(me.body.data.user, signedIn.body.data.user);
      assert.equal((await request("POST", "/auth/logout", { token: signedIn.cookie })).status, 200);
    }
    assert.equal((await pool.query("SELECT must_change_password FROM users WHERE id = $1", [userId])).rows[0].must_change_password, false);
  });
}

test("ordinary account stays unrestricted; invalid and expired sessions cannot change credentials", async () => {
  const signedIn = await login(server.baseUrl, "employee@test.eset.local", TEST_PASSWORD);
  assert.equal(signedIn.status, 200);
  assert.equal(signedIn.body.data.user.mustChangePassword, false);
  assert.equal((await request("GET", "/auth/me", { token: signedIn.cookie })).body.data.user.mustChangePassword, false);
  const before = (await pool.query("SELECT password_hash, session_version, must_change_password FROM users WHERE id = $1", [users.employee])).rows[0];
  const expired = jwt.sign({ sub: users.employee, sv: before.session_version }, config.jwtSecret, {
    expiresIn: -1, issuer: config.jwtIssuer, audience: config.jwtAudience,
  });
  for (const token of [undefined, `${config.sessionCookieName}=invalid`, `${config.sessionCookieName}=${expired}`]) {
    assert.equal((await request("GET", "/auth/me", { token })).status, 401);
    assert.equal((await request("POST", "/auth/change-password", { token, body: { currentPassword: TEST_PASSWORD, newPassword: "Unauthorized-New-Password-123!" } })).status, 401);
  }
  const after = (await pool.query("SELECT password_hash, session_version, must_change_password FROM users WHERE id = $1", [users.employee])).rows[0];
  assert.deepEqual(after, before);
});
