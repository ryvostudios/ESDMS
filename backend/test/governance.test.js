import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

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

function uniqueEmail(label) {
  return `gov-test-${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}@test.eset.local`;
}

async function latestAuditRow(action, targetUserId) {
  const result = await pool.query(
    `SELECT * FROM governance_audit_log
     WHERE action = $1 AND target_user_id = $2
     ORDER BY created_at DESC LIMIT 1`,
    [action, targetUserId],
  );
  return result.rows[0] || null;
}

// ---------------------------------------------------------------------
// A. Governance-created users get a temporary password, not a caller-
// supplied permanent one (ESDMS-001).
// ---------------------------------------------------------------------

test("a governance-created user gets a server-generated temporary password shown only once, and must change it before any permission-gated action", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const email = uniqueEmail("temp-pw");

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
    token: ceoToken,
    // No password field is even accepted — the caller cannot establish a
    // permanent shared credential through this endpoint.
    body: { email, fullName: "Temp Password User", role: "EMPLOYEE", password: "Caller-Supplied-Pw-123" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const temporaryPassword = created.body.data.temporaryPassword;
  assert.ok(temporaryPassword, "a one-time temporary credential is returned");
  assert.notEqual(temporaryPassword, "Caller-Supplied-Pw-123", "a caller-supplied password is ignored, not honored");

  const roleCheck = await pool.query(
    "SELECT must_change_password, password_hash FROM users WHERE id = $1",
    [created.body.data.id],
  );
  assert.equal(roleCheck.rows[0].must_change_password, true);
  assert.ok(!roleCheck.rows[0].password_hash.includes(temporaryPassword), "never stored/exposed as plaintext");

  const loginResponse = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
    body: { email, password: temporaryPassword },
  });
  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.body.data.user.mustChangePassword, true);

  const targetToken = await authHeader(server.baseUrl, email, temporaryPassword);

  const blocked = await apiRequest(server.baseUrl, "GET", "/api/v1/employees/me", { token: targetToken });
  assert.equal(blocked.status, 403, "permission-gated operational actions are blocked before the password is changed");

  const changed = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/change-password", {
    token: targetToken,
    body: { currentPassword: temporaryPassword, newPassword: "Brand-New-Governance-Pw-123" },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
});

test("ESDMS-020: a successful password change revokes every previously issued session, not just the one used to change it", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const email = uniqueEmail("pw-revoke");

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
    token: ceoToken,
    body: { email, fullName: "Password Revocation User", role: "EMPLOYEE" },
  });
  const temporaryPassword = created.body.data.temporaryPassword;

  // Two independently issued sessions for the same account.
  const sessionA = await authHeader(server.baseUrl, email, temporaryPassword);
  const sessionB = await authHeader(server.baseUrl, email, temporaryPassword);

  const changed = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/change-password", {
    token: sessionA,
    body: { currentPassword: temporaryPassword, newPassword: "Revocation-New-Pw-123" },
  });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));

  const sessionAAfter = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: sessionA });
  assert.equal(sessionAAfter.status, 401, "the session used to change the password is itself revoked");

  const sessionBAfter = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: sessionB });
  assert.equal(sessionBAfter.status, 401, "a second, unrelated pre-existing session is also revoked");

  const loginWithOldPassword = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
    body: { email, password: temporaryPassword },
  });
  assert.equal(loginWithOldPassword.status, 401, "the old password no longer authenticates");

  const loginWithNewPassword = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
    body: { email, password: "Revocation-New-Pw-123" },
  });
  assert.equal(loginWithNewPassword.status, 200, "the new password authenticates immediately");
});

// ---------------------------------------------------------------------
// B. Hierarchy
// ---------------------------------------------------------------------

test("CEO can create a user with role UPPER_MANAGEMENT", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const email = uniqueEmail("um");

  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
    token: ceoToken,
    body: { email, fullName: "New UM", password: "New-Um-Password-123", role: "UPPER_MANAGEMENT" },
  });

  assert.equal(response.status, 201, JSON.stringify(response.body));
  assert.equal(response.body.data.role, "UPPER_MANAGEMENT");

  const audit = await latestAuditRow("USER_CREATED", response.body.data.id);
  assert.ok(audit);
  assert.equal(audit.metadata.role, "UPPER_MANAGEMENT");
});

test("UPPER_MANAGEMENT does not hold users.create by default and cannot create any user", async () => {
  const umToken = await authHeader(server.baseUrl, "um@test.eset.local");

  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
    token: umToken,
    body: { email: uniqueEmail("blocked"), fullName: "Blocked", password: "Blocked-Password-123", role: "EMPLOYEE" },
  });

  assert.equal(response.status, 403);
});

test("HR granted users.create can create an EMPLOYEE but not UPPER_MANAGEMENT, and never CEO", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");

  const grant = await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.hr}/permissions/users.create`, {
    token: ceoToken,
    body: { effect: "GRANT" },
  });
  assert.equal(grant.status, 200, JSON.stringify(grant.body));

  try {
    const createEmployee = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
      token: hrToken,
      body: {
        email: uniqueEmail("hr-employee"),
        fullName: "HR-created Employee",
        password: "Hr-Employee-Password-123",
        role: "EMPLOYEE",
      },
    });
    assert.equal(createEmployee.status, 201, JSON.stringify(createEmployee.body));

    const createUm = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
      token: hrToken,
      body: {
        email: uniqueEmail("hr-um"),
        fullName: "HR-attempted UM",
        password: "Hr-Attempted-Password-123",
        role: "UPPER_MANAGEMENT",
      },
    });
    assert.equal(createUm.status, 403, JSON.stringify(createUm.body));

    const createCeo = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
      token: hrToken,
      body: {
        email: uniqueEmail("hr-ceo"),
        fullName: "HR-attempted CEO",
        password: "Hr-Attempted-Password-456",
        role: "CEO",
      },
    });
    assert.equal(createCeo.status, 400, "CEO is not a valid role value at all, even for an authorized creator");
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.hr}/permissions/users.create`, {
      token: ceoToken,
    });
  }
});

test("a plain users.deactivate holder cannot touch an Upper Management account without users.manage_um", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");

  const createUm = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
    token: ceoToken,
    body: {
      email: uniqueEmail("um-target"),
      fullName: "UM Target",
      password: "Um-Target-Password-123",
      role: "UPPER_MANAGEMENT",
    },
  });
  const umTargetId = createUm.body.data.id;

  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.admin}/permissions/users.deactivate`, {
    token: ceoToken,
    body: { effect: "GRANT" },
  });

  try {
    const adminToken = await authHeader(server.baseUrl, "admin@test.eset.local");

    const denied = await apiRequest(server.baseUrl, "POST", `/api/v1/users/${umTargetId}/deactivate`, {
      token: adminToken,
    });
    assert.equal(denied.status, 403, JSON.stringify(denied.body));

    await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.admin}/permissions/users.manage_um`, {
      token: ceoToken,
      body: { effect: "GRANT" },
    });

    const allowed = await apiRequest(server.baseUrl, "POST", `/api/v1/users/${umTargetId}/deactivate`, {
      token: adminToken,
    });
    assert.equal(allowed.status, 200, JSON.stringify(allowed.body));
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.admin}/permissions/users.deactivate`, {
      token: ceoToken,
    });
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.admin}/permissions/users.manage_um`, {
      token: ceoToken,
    });
  }
});

test("no actor can modify a CEO account through the API, including CEO itself", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");

  const selfRoleChange = await apiRequest(server.baseUrl, "PATCH", `/api/v1/users/${users.ceo}/role`, {
    token: ceoToken,
    body: { role: "HR" },
  });
  assert.equal(selfRoleChange.status, 403);

  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.admin}/permissions/users.update`, {
    token: ceoToken,
    body: { effect: "GRANT" },
  });

  try {
    const adminToken = await authHeader(server.baseUrl, "admin@test.eset.local");
    const otherActorAttempt = await apiRequest(server.baseUrl, "PATCH", `/api/v1/users/${users.ceo}/role`, {
      token: adminToken,
      body: { role: "HR" },
    });
    assert.equal(otherActorAttempt.status, 403);

    const escalationAudit = await latestAuditRow("PRIVILEGE_ESCALATION_ATTEMPT", users.ceo);
    assert.ok(escalationAudit);
    assert.ok(escalationAudit.metadata.violations.includes("target_is_ceo"));
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.admin}/permissions/users.update`, {
      token: ceoToken,
    });
  }
});

test("self-escalation through role change is rejected even for an authorized actor", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");

  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.admin}/permissions/users.update`, {
    token: ceoToken,
    body: { effect: "GRANT" },
  });

  try {
    const adminToken = await authHeader(server.baseUrl, "admin@test.eset.local");
    const selfChange = await apiRequest(server.baseUrl, "PATCH", `/api/v1/users/${users.admin}/role`, {
      token: adminToken,
      body: { role: "SITE_MANAGER" },
    });
    assert.equal(selfChange.status, 403);

    const escalationAudit = await latestAuditRow("PRIVILEGE_ESCALATION_ATTEMPT", users.admin);
    assert.ok(escalationAudit);
    assert.ok(escalationAudit.metadata.violations.includes("self_target"));
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.admin}/permissions/users.update`, {
      token: ceoToken,
    });
  }
});

// ---------------------------------------------------------------------
// C. Permission overrides
// ---------------------------------------------------------------------

test("grant adds a permission, deny removes one, and effect is visible via the overview endpoint", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");

  const grant = await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.teamLead}/permissions/gate_pass.approve`, {
    token: ceoToken,
    body: { effect: "GRANT", reason: "temporary delegated approval authority" },
  });
  assert.equal(grant.status, 200);

  const overview = await apiRequest(server.baseUrl, "GET", `/api/v1/users/${users.teamLead}/permissions`, {
    token: ceoToken,
  });
  assert.ok(overview.body.data.effectivePermissions.includes("gate_pass.approve"));
  assert.ok(overview.body.data.overrides.some((o) => o.permissionCode === "gate_pass.approve" && o.effect === "GRANT"));

  const deny = await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.teamLead}/permissions/gate_pass.create`, {
    token: ceoToken,
    body: { effect: "DENY" },
  });
  assert.equal(deny.status, 200);

  const afterDeny = await apiRequest(server.baseUrl, "GET", `/api/v1/users/${users.teamLead}/permissions`, {
    token: ceoToken,
  });
  assert.ok(!afterDeny.body.data.effectivePermissions.includes("gate_pass.create"));

  await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.teamLead}/permissions/gate_pass.approve`, {
    token: ceoToken,
  });
  await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.teamLead}/permissions/gate_pass.create`, {
    token: ceoToken,
  });
});

test("re-writing the same permission code upserts one row (deny wins over an earlier grant)", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");

  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.teamLead}/permissions/gate_pass.view_site`, {
    token: ceoToken,
    body: { effect: "GRANT" },
  });
  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.teamLead}/permissions/gate_pass.view_site`, {
    token: ceoToken,
    body: { effect: "DENY" },
  });

  const overview = await apiRequest(server.baseUrl, "GET", `/api/v1/users/${users.teamLead}/permissions`, {
    token: ceoToken,
  });
  const rows = overview.body.data.overrides.filter((o) => o.permissionCode === "gate_pass.view_site");
  assert.equal(rows.length, 1);
  assert.equal(rows[0].effect, "DENY");
  assert.ok(!overview.body.data.effectivePermissions.includes("gate_pass.view_site"));

  await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.teamLead}/permissions/gate_pass.view_site`, {
    token: ceoToken,
  });
});

test("removing an override returns the user to their role default", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");

  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.teamLead}/permissions/gate_pass.approve`, {
    token: ceoToken,
    body: { effect: "GRANT" },
  });

  const remove = await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.teamLead}/permissions/gate_pass.approve`, {
    token: ceoToken,
  });
  assert.equal(remove.status, 200);

  const overview = await apiRequest(server.baseUrl, "GET", `/api/v1/users/${users.teamLead}/permissions`, {
    token: ceoToken,
  });
  assert.ok(!overview.body.data.effectivePermissions.includes("gate_pass.approve"));
  assert.ok(!overview.body.data.overrides.some((o) => o.permissionCode === "gate_pass.approve"));

  const auditRow = await latestAuditRow("PERMISSION_OVERRIDE_REMOVED", users.teamLead);
  assert.ok(auditRow);
});

test("an unknown permission code is rejected, not silently created", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");

  const response = await apiRequest(
    server.baseUrl,
    "PUT",
    `/api/v1/users/${users.teamLead}/permissions/not.a.real.permission`,
    { token: ceoToken, body: { effect: "GRANT" } },
  );

  assert.equal(response.status, 400);
});

test("an actor without permission_overrides.manage cannot grant any override", async () => {
  const adminToken = await authHeader(server.baseUrl, "admin@test.eset.local");

  const response = await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.teamLead}/permissions/gate_pass.approve`, {
    token: adminToken,
    body: { effect: "GRANT" },
  });

  assert.equal(response.status, 403);
});

test("self-escalation via permission override is rejected even for an authorized actor", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");

  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.admin}/permissions/permission_overrides.manage`, {
    token: ceoToken,
    body: { effect: "GRANT" },
  });

  try {
    const adminToken = await authHeader(server.baseUrl, "admin@test.eset.local");
    const selfGrant = await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.admin}/permissions/users.create_um`, {
      token: adminToken,
      body: { effect: "GRANT" },
    });
    assert.equal(selfGrant.status, 403);

    const escalationAudit = await latestAuditRow("PRIVILEGE_ESCALATION_ATTEMPT", users.admin);
    assert.ok(escalationAudit);
    assert.ok(escalationAudit.metadata.violations.includes("self_target"));
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.admin}/permissions/permission_overrides.manage`, {
      token: ceoToken,
    });
  }
});

// ---------------------------------------------------------------------
// D. Session/security — changes take effect on the very next request,
// under the SAME still-valid session cookie, with no new login.
// ---------------------------------------------------------------------

test("a role change is reflected on the next request without a new login", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const email = uniqueEmail("role-live");

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
    token: ceoToken,
    body: { email, fullName: "Role Live", role: "EMPLOYEE" },
  });
  const targetId = created.body.data.id;
  assert.ok(created.body.data.temporaryPassword, "governance-created users get a server-generated temporary password");

  const targetToken = await authHeader(server.baseUrl, email, created.body.data.temporaryPassword);

  const before = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: targetToken });
  assert.equal(before.body.data.user.role, "EMPLOYEE");
  assert.ok(!before.body.data.user.permissions.includes("gate_pass.verify"));

  const roleChange = await apiRequest(server.baseUrl, "PATCH", `/api/v1/users/${targetId}/role`, {
    token: ceoToken,
    body: { role: "GATE_GUARD" },
  });
  assert.equal(roleChange.status, 200);

  const after = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: targetToken });
  assert.equal(after.body.data.user.role, "GATE_GUARD");
  assert.ok(after.body.data.user.permissions.includes("gate_pass.verify"));
});

test("deactivation is rejected on the very next request under the same still-unexpired session", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const email = uniqueEmail("deactivate-live");

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
    token: ceoToken,
    body: { email, fullName: "Deactivate Live", role: "EMPLOYEE" },
  });
  const targetId = created.body.data.id;
  const targetToken = await authHeader(server.baseUrl, email, created.body.data.temporaryPassword);

  const before = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: targetToken });
  assert.equal(before.status, 200);

  const deactivate = await apiRequest(server.baseUrl, "POST", `/api/v1/users/${targetId}/deactivate`, {
    token: ceoToken,
  });
  assert.equal(deactivate.status, 200);

  const after = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: targetToken });
  assert.equal(after.status, 401, "the same session cookie must stop working immediately, without waiting for expiry");
});

test("a permission override is reflected on the next request without a new login", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const teamLeadToken = await authHeader(server.baseUrl, "teamlead@test.eset.local");

  const before = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: teamLeadToken });
  assert.ok(!before.body.data.user.permissions.includes("gate_pass.approve"));

  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${users.teamLead}/permissions/gate_pass.approve`, {
    token: ceoToken,
    body: { effect: "GRANT" },
  });

  try {
    const after = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token: teamLeadToken });
    assert.ok(after.body.data.user.permissions.includes("gate_pass.approve"));
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.teamLead}/permissions/gate_pass.approve`, {
      token: ceoToken,
    });
  }
});

// ---------------------------------------------------------------------
// E. Audit
// ---------------------------------------------------------------------

test("governance actions generate the expected audit events with no secrets in metadata", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const email = uniqueEmail("audit");
  const password = "Audit-Check-Password-123";

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
    token: ceoToken,
    body: { email, fullName: "Audit Check", password, role: "EMPLOYEE" },
  });
  const targetId = created.body.data.id;

  await apiRequest(server.baseUrl, "PATCH", `/api/v1/users/${targetId}/role`, {
    token: ceoToken,
    body: { role: "GATE_GUARD" },
  });
  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${targetId}/permissions/gate_pass.approve`, {
    token: ceoToken,
    body: { effect: "GRANT" },
  });
  await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${targetId}/permissions/gate_pass.approve`, {
    token: ceoToken,
    body: { effect: "DENY" },
  });
  await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${targetId}/permissions/gate_pass.approve`, {
    token: ceoToken,
  });
  await apiRequest(server.baseUrl, "POST", `/api/v1/users/${targetId}/deactivate`, { token: ceoToken });
  await apiRequest(server.baseUrl, "POST", `/api/v1/users/${targetId}/activate`, { token: ceoToken });

  const rows = await pool.query(
    "SELECT action, metadata FROM governance_audit_log WHERE target_user_id = $1 ORDER BY created_at",
    [targetId],
  );

  const actions = rows.rows.map((r) => r.action);
  assert.deepEqual(actions, [
    "USER_CREATED",
    "USER_ROLE_CHANGED",
    "PERMISSION_GRANTED",
    "PERMISSION_DENIED",
    "PERMISSION_OVERRIDE_REMOVED",
    "USER_DEACTIVATED",
    "USER_ACTIVATED",
  ]);

  const metadataText = JSON.stringify(rows.rows.map((r) => r.metadata));
  assert.ok(!metadataText.includes(password), "audit metadata must never contain the plaintext password");
  assert.ok(!metadataText.toLowerCase().includes("password"), "audit metadata must never carry a password field");
});

test("governance_audit_log is append-only: UPDATE and DELETE are rejected", async () => {
  const inserted = await pool.query(
    `INSERT INTO governance_audit_log (actor_user_id, target_user_id, action)
     VALUES ($1, $1, 'USER_CREATED') RETURNING id`,
    [users.ceo],
  );
  const id = inserted.rows[0].id;

  await assert.rejects(
    pool.query("UPDATE governance_audit_log SET action = 'USER_ACTIVATED' WHERE id = $1", [id]),
    /append-only/,
  );
  await assert.rejects(pool.query("DELETE FROM governance_audit_log WHERE id = $1", [id]), /append-only/);
});

// ---------------------------------------------------------------------
// F. Temporary password regeneration — recovery only for a
// must_change_password=true account, never a general password reset.
// ---------------------------------------------------------------------

async function createFirstLoginUser(ceoToken, label) {
  const email = uniqueEmail(label);
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/users", {
    token: ceoToken,
    body: { email, fullName: "Regen Test User", role: "EMPLOYEE" },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  return { id: created.body.data.id, email, temporaryPassword: created.body.data.temporaryPassword };
}

test("CEO can regenerate a temporary password for a must_change_password=true account, and the new plaintext authenticates while the old one no longer does", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const target = await createFirstLoginUser(ceoToken, "regen-ok");

  const before = await pool.query("SELECT session_version FROM users WHERE id = $1", [target.id]);

  const response = await apiRequest(server.baseUrl, "POST", `/api/v1/users/${target.id}/regenerate-temp-password`, {
    token: ceoToken,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const newTemporaryPassword = response.body.data.temporaryPassword;
  assert.ok(newTemporaryPassword, "a new one-time temporary credential is returned");
  assert.notEqual(newTemporaryPassword, target.temporaryPassword);

  const row = await pool.query(
    "SELECT must_change_password, session_version FROM users WHERE id = $1",
    [target.id],
  );
  assert.equal(row.rows[0].must_change_password, true, "still must_change_password — not a general reset");
  assert.equal(
    row.rows[0].session_version,
    before.rows[0].session_version + 1,
    "session_version increments to invalidate any prior session",
  );

  const loginWithNew = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
    body: { email: target.email, password: newTemporaryPassword },
  });
  assert.equal(loginWithNew.status, 200, "the returned plaintext authenticates");

  const loginWithOld = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
    body: { email: target.email, password: target.temporaryPassword },
  });
  assert.equal(loginWithOld.status, 401, "the lost/old temporary password no longer authenticates");
});

test("regenerating a temporary password is rejected for an account that already completed first login (must_change_password=false)", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");

  // users.employee is a seeded fixture with must_change_password=false.
  const response = await apiRequest(server.baseUrl, "POST", `/api/v1/users/${users.employee}/regenerate-temp-password`, {
    token: ceoToken,
  });
  assert.equal(response.status, 400, JSON.stringify(response.body));
});

test("an actor without users.regenerate_temp_password cannot regenerate a temporary password", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
  const target = await createFirstLoginUser(ceoToken, "regen-unauthorized");

  const response = await apiRequest(server.baseUrl, "POST", `/api/v1/users/${target.id}/regenerate-temp-password`, {
    token: hrToken,
  });
  assert.equal(response.status, 403);
});

test("temporary password regeneration preserves CEO-target protection and Upper Management authority rules", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");

  const onCeo = await apiRequest(server.baseUrl, "POST", `/api/v1/users/${users.ceo}/regenerate-temp-password`, {
    token: ceoToken,
  });
  assert.equal(onCeo.status, 403, "CEO accounts can never be targeted through this API, even by another CEO");

  const hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
  const grant = await apiRequest(
    server.baseUrl,
    "PUT",
    `/api/v1/users/${users.hr}/permissions/users.regenerate_temp_password`,
    { token: ceoToken, body: { effect: "GRANT" } },
  );
  assert.equal(grant.status, 200, JSON.stringify(grant.body));

  try {
    const onUm = await apiRequest(server.baseUrl, "POST", `/api/v1/users/${users.upperManagement}/regenerate-temp-password`, {
      token: hrToken,
    });
    assert.equal(onUm.status, 403, "an actor without users.manage_um cannot regenerate a UM account's credential");
  } finally {
    await apiRequest(server.baseUrl, "DELETE", `/api/v1/users/${users.hr}/permissions/users.regenerate_temp_password`, {
      token: ceoToken,
    });
  }
});

test("temporary password regeneration audit record identifies actor/target/action only — the plaintext credential never appears in the audit log", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const target = await createFirstLoginUser(ceoToken, "regen-audit");

  const response = await apiRequest(server.baseUrl, "POST", `/api/v1/users/${target.id}/regenerate-temp-password`, {
    token: ceoToken,
  });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  const newTemporaryPassword = response.body.data.temporaryPassword;

  const audit = await latestAuditRow("USER_TEMP_PASSWORD_REGENERATED", target.id);
  assert.ok(audit, "a safe audit record is created for the regeneration");
  assert.equal(audit.actor_user_id, users.ceo, "audit identifies the acting user");
  assert.equal(audit.target_user_id, target.id, "audit identifies the target user");

  const metadataText = JSON.stringify(audit.metadata || {});
  assert.ok(!metadataText.includes(newTemporaryPassword), "the plaintext credential must never appear in audit metadata");
  assert.ok(
    !metadataText.toLowerCase().includes("password"),
    "audit metadata for this action must not carry any password-shaped field",
  );
});

test("a concurrent first login (flipping must_change_password to false) that commits while a regeneration is blocked on the row lock is honored, not raced", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const target = await createFirstLoginUser(ceoToken, "regen-race");

  const lockHolder = await pool.connect();
  try {
    await lockHolder.query("BEGIN");
    await lockHolder.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [target.id]);

    const regenPromise = apiRequest(server.baseUrl, "POST", `/api/v1/users/${target.id}/regenerate-temp-password`, {
      token: ceoToken,
    });

    await new Promise((resolve) => setTimeout(resolve, 300));

    // Simulates the user completing first login concurrently, while the
    // regeneration request above is still blocked waiting on this lock.
    await lockHolder.query(
      "UPDATE users SET must_change_password = false, session_version = session_version + 1 WHERE id = $1",
      [target.id],
    );
    await lockHolder.query("COMMIT");

    const regen = await regenPromise;
    assert.equal(
      regen.status,
      400,
      "the eligibility check re-reads the row after acquiring the lock, so the concurrently-committed first login is honored instead of being raced",
    );
  } finally {
    lockHolder.release();
  }
});

// ADV-P1-01: a first-login changePassword that read/verified the OLD
// temporary credential must never be allowed to overwrite a Governance
// regeneration that commits while it's still in flight. Both endpoints are
// driven for real over HTTP — no synthetic row update stands in for
// changePassword. lockHolder forces a deterministic ordering the same way
// the "concurrent first login" test above does: regeneration queues for
// the row lock first, changePassword's conditional UPDATE queues behind
// it, and releasing the lock lets regeneration commit before the stale
// UPDATE is even evaluated.
test("changePassword loses a real concurrency race against Governance regeneration: the regenerated credential remains authoritative, the stale request fails, and nothing leaks", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const target = await createFirstLoginUser(ceoToken, "credential-race");

  // A real login with the (about-to-be-orphaned) old temporary password —
  // this is the credential the stale changePassword request will verify.
  const targetToken = await authHeader(server.baseUrl, target.email, target.temporaryPassword);

  const before = await pool.query("SELECT session_version FROM users WHERE id = $1", [target.id]);

  const lockHolder = await pool.connect();
  try {
    await lockHolder.query("BEGIN");
    await lockHolder.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [target.id]);

    // Regeneration queues for the lock first.
    const regenPromise = apiRequest(server.baseUrl, "POST", `/api/v1/users/${target.id}/regenerate-temp-password`, {
      token: ceoToken,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    // The stale request begins now: its SELECT and argon2 verification of
    // the OLD hash both succeed unblocked (a plain read never contends
    // with the row lock) — only its final conditional UPDATE queues,
    // behind regeneration.
    const stalePromise = apiRequest(server.baseUrl, "POST", "/api/v1/auth/change-password", {
      token: targetToken,
      body: { currentPassword: target.temporaryPassword, newPassword: "Stale-Losing-Pw-123!" },
    });
    await new Promise((resolve) => setTimeout(resolve, 200));

    await lockHolder.query("COMMIT");

    const [regen, stale] = await Promise.all([regenPromise, stalePromise]);

    assert.equal(regen.status, 200, JSON.stringify(regen.body));
    const newTemporaryPassword = regen.body.data.temporaryPassword;
    assert.ok(newTemporaryPassword);

    assert.equal(stale.status, 401, "the stale changePassword request must fail once the credential it verified no longer exists");
    assert.equal(stale.body.error.message, "Current password is incorrect.");
    assert.ok(
      !JSON.stringify(stale.body).includes(newTemporaryPassword),
      "the regenerated credential must never leak through the losing request's response",
    );

    const row = await pool.query(
      "SELECT must_change_password, session_version FROM users WHERE id = $1",
      [target.id],
    );
    assert.equal(row.rows[0].must_change_password, true, "still must_change_password — the stale change never applied");
    assert.equal(
      row.rows[0].session_version,
      before.rows[0].session_version + 1,
      "exactly one bump, from regeneration alone — the stale UPDATE matched zero rows",
    );

    const loginNew = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
      body: { email: target.email, password: newTemporaryPassword },
    });
    assert.equal(loginNew.status, 200, "the regenerated credential is authoritative and authenticates");

    const loginStaleNew = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
      body: { email: target.email, password: "Stale-Losing-Pw-123!" },
    });
    assert.equal(loginStaleNew.status, 401, "the losing request's attempted new password never took effect");

    const loginOld = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
      body: { email: target.email, password: target.temporaryPassword },
    });
    assert.equal(loginOld.status, 401, "the original temporary password is gone too");
  } finally {
    lockHolder.release();
  }
});

// ADV-P1-02: getUser() authorizes actor-site-scope against a
// pre-transaction snapshot; a delegated site-scoped actor must not be able
// to regenerate a credential for a User who has since moved out of their
// scope. The locked recheck must use the freshly-locked row, not the
// snapshot read before the transaction began.
test("temporary password regeneration re-checks actor site-scope against the LOCKED row: a concurrent site transfer out of scope is honored, not raced past, and makes zero changes", async () => {
  const ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  const target = await createFirstLoginUser(ceoToken, "site-scope-race"); // created on CEO's (main) site

  const grant = await apiRequest(
    server.baseUrl,
    "PUT",
    `/api/v1/users/${users.admin}/permissions/users.regenerate_temp_password`,
    { token: ceoToken, body: { effect: "GRANT", reason: "test: delegate to a site-scoped actor" } },
  );
  assert.equal(grant.status, 200, JSON.stringify(grant.body));

  // admin@test.eset.local is a mainSite-scoped, non-CEO actor (see setup.js).
  const adminToken = await authHeader(server.baseUrl, "admin@test.eset.local");

  const before = await pool.query(
    "SELECT session_version, must_change_password, password_hash FROM users WHERE id = $1",
    [target.id],
  );

  const lockHolder = await pool.connect();
  try {
    await lockHolder.query("BEGIN");
    await lockHolder.query("SELECT id FROM users WHERE id = $1 FOR UPDATE", [target.id]);

    const regenPromise = apiRequest(server.baseUrl, "POST", `/api/v1/users/${target.id}/regenerate-temp-password`, {
      token: adminToken,
    });
    await new Promise((resolve) => setTimeout(resolve, 300));

    // Simulates the target being transferred to a different site after the
    // actor's pre-transaction site check already passed, but before the
    // locked recheck runs.
    await lockHolder.query("UPDATE users SET site_id = $1 WHERE id = $2", [users.otherSite, target.id]);
    await lockHolder.query("COMMIT");

    const regen = await regenPromise;
    assert.equal(regen.status, 404, JSON.stringify(regen.body));

    const after = await pool.query(
      "SELECT session_version, must_change_password, password_hash FROM users WHERE id = $1",
      [target.id],
    );
    assert.equal(after.rows[0].session_version, before.rows[0].session_version, "zero session changes from the rejected regeneration");
    assert.equal(after.rows[0].must_change_password, before.rows[0].must_change_password);
    assert.equal(after.rows[0].password_hash, before.rows[0].password_hash, "zero credential changes from the rejected regeneration");

    const loginOriginal = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
      body: { email: target.email, password: target.temporaryPassword },
    });
    assert.equal(loginOriginal.status, 200, "the original temporary credential is untouched by the rejected attempt");
  } finally {
    lockHolder.release();
  }
});
