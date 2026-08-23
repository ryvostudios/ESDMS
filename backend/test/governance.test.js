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
    body: { email, fullName: "Role Live", password: "Role-Live-Password-123", role: "EMPLOYEE" },
  });
  const targetId = created.body.data.id;

  const targetToken = await authHeader(server.baseUrl, email, "Role-Live-Password-123");

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
    body: { email, fullName: "Deactivate Live", password: "Deactivate-Live-Pw-123", role: "EMPLOYEE" },
  });
  const targetId = created.body.data.id;
  const targetToken = await authHeader(server.baseUrl, email, "Deactivate-Live-Pw-123");

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
