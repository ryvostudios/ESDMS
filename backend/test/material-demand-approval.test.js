import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let users;
let teamLeadToken; // TEAM_LEAD, departmentA, mainSite — creator, no review/approve authority
let adminToken; // ADMIN, mainSite, no department — NEITHER demand.review NOR procurement.pricing by default (ADMIN is system administration, not line management)
let siteManagerToken; // SITE_MANAGER, mainSite, no department — demand.review by default
let upperManagementToken; // UPPER_MANAGEMENT, mainSite, no department — demand.review by default
let hrToken; // HR — neither by default; used as an ad hoc "delegated CFO" via override
let ceoToken; // CEO — everything, every site
let otherSiteAdminToken; // ADMIN at otherSite — used with explicit grants to verify site scope
let guardToken;
let employeeToken; // EMPLOYEE, departmentA — used for a GRANT-override eligibility test
let uomId;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

async function addCatalogEntry(token) {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token,
    body: { newItem: { name: unique("Cement") }, defaultUomId: uomId },
  });
  assert.equal(response.status, 201);
  return response.body.data.id;
}

async function createSubmittedDemand(catalogEntryId) {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: { lines: [{ catalogEntryId, quantity: 10 }] },
  });
  assert.equal(created.status, 201);
  const id = created.body.data.demand.id;
  const submitted = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/submit`, { token: teamLeadToken });
  assert.equal(submitted.status, 200);
  return id;
}

async function permissionId(code) {
  const result = await pool.query("SELECT id FROM permissions WHERE code = $1", [code]);
  return result.rows[0].id;
}

async function setOverride(userId, code, effect) {
  await pool.query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, permission_id) DO UPDATE SET effect = $3`,
    [userId, await permissionId(code), effect, users.admin],
  );
}

async function clearOverride(userId, code) {
  await pool.query("DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission_id = $2", [
    userId,
    await permissionId(code),
  ]);
}

async function setActive(userId, isActive) {
  await pool.query("UPDATE users SET is_active = $2 WHERE id = $1", [userId, isActive]);
}

async function notificationCountFor(demandId, revision, event, userId) {
  const result = await pool.query("SELECT count(*)::int AS n FROM notification_outbox WHERE idempotency_key = $1", [
    `demand:${demandId}:rev:${revision}:${event}:${userId}`,
  ]);
  return result.rows[0].n;
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  teamLeadToken = await authHeader(server.baseUrl, "teamlead@test.eset.local");
  adminToken = await authHeader(server.baseUrl, "admin@test.eset.local");
  siteManagerToken = await authHeader(server.baseUrl, "manager@test.eset.local");
  upperManagementToken = await authHeader(server.baseUrl, "um@test.eset.local");
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  otherSiteAdminToken = await authHeader(server.baseUrl, "admin-othersite@test.eset.local");
  guardToken = await authHeader(server.baseUrl, "guard@test.eset.local");
  employeeToken = await authHeader(server.baseUrl, "employee@test.eset.local");

  const uomResponse = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: ceoToken,
  });
  uomId = uomResponse.body.data[0].id;
});

after(async () => {
  await server.close();
});

// --- Capability separation ---------------------------------------------

test("a Management Review holder can review but cannot formally approve", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: siteManagerToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(review.status, 200);

  const approve = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: siteManagerToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(approve.status, 403);
});

test("a Formal Approval holder (delegated, not a default role grant) can approve but cannot review", async () => {
  await setOverride(users.hr, "demand.approve", "GRANT");
  try {
    const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

    const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: hrToken,
      body: { decision: "APPROVED" },
    });
    assert.equal(review.status, 403);

    const approve = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
      token: hrToken,
      body: { decision: "APPROVED" },
    });
    assert.equal(approve.status, 200);
  } finally {
    await clearOverride(users.hr, "demand.approve");
  }
});

test("the Demand creator cannot review or approve their own Demand merely by ownership", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: teamLeadToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(review.status, 403);

  const approve = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: teamLeadToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(approve.status, 403);
});

test("an explicit DENY on demand.review overrides the SITE_MANAGER role's default grant", async () => {
  await setOverride(users.siteManager, "demand.review", "DENY");
  try {
    const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

    const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: siteManagerToken,
      body: { decision: "APPROVED" },
    });
    assert.equal(review.status, 403);
  } finally {
    await clearOverride(users.siteManager, "demand.review");
  }
});

test("ADMIN has no demand.review authority without an explicit GRANT", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const notificationCount = await notificationCountFor(id, 1, "initial-review", users.admin);
  assert.equal(notificationCount, 0, "ADMIN must not be selected as a reviewer merely from its role");

  const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: adminToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(review.status, 403);
});

test("UPPER_MANAGEMENT can review within its site but cannot formally approve without an explicit GRANT", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: upperManagementToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(review.status, 200);

  const approve = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: upperManagementToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(approve.status, 403);
});

test("Gate Guard has no review or approval authority", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: guardToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(review.status, 403);

  const approve = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: guardToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(approve.status, 403);
});

// --- Scope ----------------------------------------------------------------

test("a Management Reviewer at a different site cannot review across the site boundary", async () => {
  // ADMIN no longer defaults to demand.review — grant it explicitly to
  // isolate the assertion under test (site-boundary enforcement) from the
  // unrelated question of which role holds the capability by default.
  await setOverride(users.otherSiteAdmin, "demand.review", "GRANT");
  try {
    const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

    const response = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: otherSiteAdminToken, // demand.review via explicit GRANT, but at otherSite
      body: { decision: "APPROVED" },
    });
    assert.equal(response.status, 404);
  } finally {
    await clearOverride(users.otherSiteAdmin, "demand.review");
  }
});

test("holding demand.all_departments alone (without demand.review/approve) grants no review/approval action", async () => {
  await setOverride(users.teamLeadOtherDept, "demand.all_departments", "GRANT");
  try {
    const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));
    const otherDeptToken = await authHeader(server.baseUrl, "teamlead2@test.eset.local");

    const response = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: otherDeptToken,
      body: { decision: "APPROVED" },
    });
    assert.equal(response.status, 403);
  } finally {
    await clearOverride(users.teamLeadOtherDept, "demand.all_departments");
  }
});

test("CEO can review AND formally approve the same Demand — a deliberate, documented exception", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: ceoToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(review.status, 200);

  const approve = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: ceoToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.data.demand.status, "READY_FOR_PRICING");
});

// --- Gate completion --------------------------------------------------

test("Management Review alone leaves the Demand pending; both slots together complete the gate, order independent", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: siteManagerToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(review.status, 200);
  assert.equal(review.body.data.demand.status, "PENDING_INITIAL_REVIEW");

  const approve = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: ceoToken, // formal approval, order-independent — approve happens second here
    body: { decision: "APPROVED" },
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.data.demand.status, "READY_FOR_PRICING");

  // Order independence: approve-first, review-second also completes it.
  const id2 = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));
  const approveFirst = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id2}/approvals`, {
    token: ceoToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(approveFirst.status, 200);
  assert.equal(approveFirst.body.data.demand.status, "PENDING_INITIAL_REVIEW");

  const reviewSecond = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id2}/reviews`, {
    token: siteManagerToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(reviewSecond.status, 200);
  assert.equal(reviewSecond.body.data.demand.status, "READY_FOR_PRICING");
});

test("Formal Approval alone leaves the Demand pending", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const approve = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: ceoToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(approve.status, 200);
  assert.equal(approve.body.data.demand.status, "PENDING_INITIAL_REVIEW");
});

test("Procurement is notified exactly once when the gate completes", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: siteManagerToken,
    body: { decision: "APPROVED" },
  });
  const approve = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: ceoToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(approve.body.data.demand.status, "READY_FOR_PRICING");

  // CEO holds procurement.pricing by default — guaranteed eligible.
  const count = await notificationCountFor(id, 1, "ready-for-pricing", users.ceo);
  assert.equal(count, 1);
});

test("an ADMIN without an explicit GRANT is not an eligible Procurement pricing recipient", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: siteManagerToken,
    body: { decision: "APPROVED" },
  });
  await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: ceoToken,
    body: { decision: "APPROVED" },
  });

  const count = await notificationCountFor(id, 1, "ready-for-pricing", users.admin);
  assert.equal(count, 0, "ADMIN must not receive a placeholder procurement.pricing grant by default");
});

test("an explicitly procurement.pricing-GRANTed user is resolved as an eligible Procurement recipient", async () => {
  await setOverride(users.admin, "procurement.pricing", "GRANT");
  try {
    const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

    await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: siteManagerToken,
      body: { decision: "APPROVED" },
    });
    await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
      token: ceoToken,
      body: { decision: "APPROVED" },
    });

    const count = await notificationCountFor(id, 1, "ready-for-pricing", users.admin);
    assert.equal(count, 1, "an explicit GRANT is a real path to Procurement recipient eligibility");
  } finally {
    await clearOverride(users.admin, "procurement.pricing");
  }
});

test("an explicit DENY excludes a default Procurement pricing recipient", async () => {
  await setOverride(users.ceo, "procurement.pricing", "DENY");
  try {
    const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

    await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: siteManagerToken,
      body: { decision: "APPROVED" },
    });
    await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
      token: ceoToken,
      body: { decision: "APPROVED" },
    });

    const count = await notificationCountFor(id, 1, "ready-for-pricing", users.ceo);
    assert.equal(count, 0, "an effective DENY must exclude even the CEO role's default pricing grant");
  } finally {
    await clearOverride(users.ceo, "procurement.pricing");
  }
});

test("an inactive explicitly GRANTed Procurement pricing user is excluded", async () => {
  await setOverride(users.admin, "procurement.pricing", "GRANT");
  await setActive(users.admin, false);
  try {
    const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

    await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: siteManagerToken,
      body: { decision: "APPROVED" },
    });
    await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
      token: ceoToken,
      body: { decision: "APPROVED" },
    });

    const count = await notificationCountFor(id, 1, "ready-for-pricing", users.admin);
    assert.equal(count, 0);
  } finally {
    await setActive(users.admin, true);
    await clearOverride(users.admin, "procurement.pricing");
  }
});

test("an explicitly GRANTed Procurement pricing user at another site is excluded", async () => {
  await setOverride(users.otherSiteAdmin, "procurement.pricing", "GRANT");
  try {
    const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

    await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: siteManagerToken,
      body: { decision: "APPROVED" },
    });
    await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
      token: ceoToken,
      body: { decision: "APPROVED" },
    });

    const count = await notificationCountFor(id, 1, "ready-for-pricing", users.otherSiteAdmin);
    assert.equal(count, 0);
  } finally {
    await clearOverride(users.otherSiteAdmin, "procurement.pricing");
  }
});

// --- Concurrency -----------------------------------------------------

test("simultaneous Management Review and Formal Approval race safely to exactly one transition and one notification set", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const [reviewResult, approveResult] = await Promise.all([
    apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: siteManagerToken,
      body: { decision: "APPROVED" },
    }),
    apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
      token: ceoToken,
      body: { decision: "APPROVED" },
    }),
  ]);

  // Both requests target different slots (review vs. approval), so both
  // must succeed — the row lock on material_demands serializes them
  // (whichever arrives second simply waits for the first's transaction to
  // commit before proceeding), it does not reject either. No decision is
  // lost.
  assert.equal(reviewResult.status, 200);
  assert.equal(approveResult.status, 200);

  const finalStatus = await apiRequest(server.baseUrl, "GET", `/api/v1/demands/${id}`, { token: ceoToken });
  assert.equal(finalStatus.body.data.demand.status, "READY_FOR_PRICING");

  const approvals = await pool.query(
    "SELECT approval_type, decision FROM material_demand_approvals WHERE demand_id = $1",
    [id],
  );
  assert.equal(approvals.rowCount, 2, "exactly two approval records — neither decision was lost or duplicated");

  const readyAudit = await pool.query(
    "SELECT count(*)::int AS n FROM material_demand_audit_log WHERE demand_id = $1 AND action = 'READY_FOR_PRICING'",
    [id],
  );
  assert.equal(readyAudit.rows[0].n, 1, "exactly one gate-completion transition, regardless of which request won the race");

  const procurementCount = await notificationCountFor(id, 1, "ready-for-pricing", users.ceo);
  assert.equal(procurementCount, 1, "no duplicate Procurement notification from the race");
});

test("simultaneous decisions for the same approval slot produce exactly one winner", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const responses = await Promise.all([
    apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: siteManagerToken,
      body: { decision: "APPROVED" },
    }),
    apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: upperManagementToken,
      body: { decision: "APPROVED" },
    }),
  ]);

  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409],
  );

  const approvals = await pool.query(
    "SELECT count(*)::int AS n FROM material_demand_approvals WHERE demand_id = $1 AND approval_type = 'MANAGEMENT_REVIEW'",
    [id],
  );
  assert.equal(approvals.rows[0].n, 1);
});

// --- Replay / idempotency ------------------------------------------------

test("recording the same slot twice is rejected — first writer wins", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const first = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: siteManagerToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(first.status, 200);

  const second = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: upperManagementToken, // a different, also-eligible reviewer
    body: { decision: "APPROVED" },
  });
  assert.equal(second.status, 409);
});

test("a decision cannot be recorded once the Demand is no longer PENDING_INITIAL_REVIEW", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: siteManagerToken,
    body: { decision: "REJECTED", reason: "Not needed" },
  });

  const lateApproval = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: ceoToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(lateApproval.status, 409);
});

// --- Same-actor-both-slots guard ---------------------------------------

test("an ordinary user holding both capabilities cannot fill both slots on the same Demand", async () => {
  // siteManager already has demand.review by default; grant demand.approve
  // on top of it so this ordinary (non-CEO) actor holds both capabilities.
  await setOverride(users.siteManager, "demand.approve", "GRANT");
  try {
    const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

    const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: siteManagerToken,
      body: { decision: "APPROVED" },
    });
    assert.equal(review.status, 200);

    const approve = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
      token: siteManagerToken,
      body: { decision: "APPROVED" },
    });
    assert.equal(approve.status, 409);
  } finally {
    await clearOverride(users.siteManager, "demand.approve");
  }
});

// --- Rejection -----------------------------------------------------------

test("a rejection reason is required", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const response = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: siteManagerToken,
    body: { decision: "REJECTED" },
  });
  assert.equal(response.status, 400);
});

test("Formal Approval rejection blocks progression, is audited, and preserves a prior positive review", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: siteManagerToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(review.status, 200);

  const reject = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: ceoToken,
    body: { decision: "REJECTED", reason: "Budget not available" },
  });
  assert.equal(reject.status, 200);
  assert.equal(reject.body.data.demand.status, "REJECTED");

  const approvals = reject.body.data.approvals;
  const managementReview = approvals.find((a) => a.approval_type === "MANAGEMENT_REVIEW");
  const formalApproval = approvals.find((a) => a.approval_type === "FORMAL_APPROVAL");
  assert.equal(managementReview.decision, "APPROVED", "the prior positive review must not be erased by the later rejection");
  assert.equal(formalApproval.decision, "REJECTED");
  assert.equal(formalApproval.reason, "Budget not available");

  const procurementCount = await notificationCountFor(id, 1, "ready-for-pricing", users.ceo);
  assert.equal(procurementCount, 0, "Procurement must never be notified after a rejection");

  const auditActions = reject.body.data.auditLog.map((entry) => entry.action);
  assert.ok(auditActions.includes("FORMAL_APPROVAL_REJECTED"));
  assert.ok(!auditActions.includes("READY_FOR_PRICING"));
});

test("Management Review rejection blocks progression the same way", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const reject = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: siteManagerToken,
    body: { decision: "REJECTED", reason: "Wrong department catalog item" },
  });
  assert.equal(reject.status, 200);
  assert.equal(reject.body.data.demand.status, "REJECTED");

  const approveAfterReject = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: ceoToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(approveAfterReject.status, 409);
});

// --- Revision binding ------------------------------------------------------

test("an approval record is tied to the Demand's current revision", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));

  const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: siteManagerToken,
    body: { decision: "APPROVED" },
  });

  const stored = review.body.data.approvals.find((a) => a.approval_type === "MANAGEMENT_REVIEW");
  assert.equal(stored.revision, 1);
  assert.equal(review.body.data.demand.revision, 1);
});

test("approval records are immutable at the database boundary", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));
  await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: siteManagerToken,
    body: { decision: "APPROVED" },
  });

  const approval = await pool.query(
    "SELECT id FROM material_demand_approvals WHERE demand_id = $1 AND approval_type = 'MANAGEMENT_REVIEW'",
    [id],
  );
  const approvalId = approval.rows[0].id;

  await assert.rejects(
    pool.query("UPDATE material_demand_approvals SET reason = 'tampered' WHERE id = $1", [approvalId]),
    /append-only/i,
  );
  await assert.rejects(pool.query("DELETE FROM material_demand_approvals WHERE id = $1", [approvalId]), /append-only/i);
});

// --- Notification recipient resolver -------------------------------------

test("recipient resolver: an individual GRANT makes an otherwise-ineligible EMPLOYEE a real recipient", async () => {
  await setOverride(users.employee, "demand.review", "GRANT");
  try {
    const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));
    const count = await notificationCountFor(id, 1, "initial-review", users.employee);
    assert.equal(count, 1);

    const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
      token: employeeToken,
      body: { decision: "APPROVED" },
    });
    assert.equal(review.status, 200, "the granted EMPLOYEE must also be able to actually perform the review");
  } finally {
    await clearOverride(users.employee, "demand.review");
  }
});

test("recipient resolver: an explicit DENY excludes an otherwise-eligible default holder", async () => {
  await setOverride(users.upperManagement, "demand.review", "DENY");
  try {
    const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));
    const count = await notificationCountFor(id, 1, "initial-review", users.upperManagement);
    assert.equal(count, 0);
  } finally {
    await clearOverride(users.upperManagement, "demand.review");
  }
});

test("recipient resolver: a deactivated user is excluded even though their role would otherwise qualify", async () => {
  await setActive(users.siteManager, false);
  try {
    const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));
    const count = await notificationCountFor(id, 1, "initial-review", users.siteManager);
    assert.equal(count, 0);
  } finally {
    await setActive(users.siteManager, true);
  }
});

test("recipient resolver: a user at a different site is excluded", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));
  const count = await notificationCountFor(id, 1, "initial-review", users.otherSiteAdmin);
  assert.equal(count, 0);
});

test("recipient resolver: CEO is always eligible regardless of site", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));
  const count = await notificationCountFor(id, 1, "initial-review", users.ceo);
  assert.equal(count, 1);
});

test("recipient resolver: a user eligible through both demand.review and demand.approve gets exactly one notification", async () => {
  const id = await createSubmittedDemand(await addCatalogEntry(teamLeadToken));
  // CEO holds both by default — must not receive two DEMAND_SUBMITTED rows.
  const result = await pool.query(
    "SELECT count(*)::int AS n FROM notification_outbox WHERE entity_type = 'MATERIAL_DEMAND' AND entity_id = $1 AND recipient_user_id = $2",
    [id, users.ceo],
  );
  assert.equal(result.rows[0].n, 1);
});
