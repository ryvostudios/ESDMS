import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let users;
let tokens;
let uomId;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

async function permissionId(code) {
  const result = await pool.query("SELECT id FROM permissions WHERE code = $1", [code]);
  return result.rows[0].id;
}

async function setOverride(userId, code, effect) {
  await pool.query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, permission_id) DO UPDATE SET effect = EXCLUDED.effect`,
    [userId, await permissionId(code), effect, users.ceo],
  );
}

async function clearOverride(userId, code) {
  await pool.query(
    "DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission_id = $2",
    [userId, await permissionId(code)],
  );
}

async function addCatalogEntry() {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: tokens.teamLead,
    body: { newItem: { name: unique("Final approval material") }, defaultUomId: uomId },
  });
  assert.equal(response.status, 201);
  return response.body.data.id;
}

async function createPendingFinal({ prices = ["100.00", "25.00"] } = {}) {
  const entries = [await addCatalogEntry(), await addCatalogEntry()];
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: tokens.teamLead,
    body: {
      lines: entries.map((catalogEntryId, index) => ({
        catalogEntryId,
        quantity: index === 0 ? 50 : 4,
      })),
    },
  });
  assert.equal(created.status, 201);
  const id = created.body.data.demand.id;

  assert.equal((await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/submit`, {
    token: tokens.teamLead,
  })).status, 200);
  assert.equal((await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: tokens.siteManager,
    body: { decision: "APPROVED" },
  })).status, 200);
  assert.equal((await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: tokens.ceo,
    body: { decision: "APPROVED" },
  })).status, 200);

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/procurement/pricing/${id}`, {
    token: tokens.ceo,
  });
  assert.equal(detail.status, 200);
  const saved = await apiRequest(server.baseUrl, "PUT", `/api/v1/procurement/pricing/${id}`, {
    token: tokens.ceo,
    body: {
      revision: 1,
      pricingVersion: 1,
      currency: "PKR",
      lines: detail.body.data.lines.map((line, index) => ({
        demandLineId: line.demand_line_id,
        estimatedUnitPrice: prices[index],
        procurementNote: index === 0 ? "Protected estimate" : null,
      })),
    },
  });
  assert.equal(saved.status, 200);
  const submitted = await apiRequest(server.baseUrl, "POST", `/api/v1/procurement/pricing/${id}/submit`, {
    token: tokens.ceo,
    body: { revision: 1, pricingVersion: 1 },
  });
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.data.demand.status, "PENDING_FINAL_APPROVAL");
  return submitted.body.data;
}

async function finalDecision(id, kind, token, pricingId, decision = "APPROVED", reason) {
  return apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/${kind}`, {
    token,
    body: { pricingId, decision, ...(reason ? { reason } : {}) },
  });
}

async function currentPricing(id, token = tokens.ceo, version) {
  const suffix = version ? `?version=${version}` : "";
  return apiRequest(server.baseUrl, "GET", `/api/v1/procurement/pricing/${id}${suffix}`, { token });
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    upperManagement: await authHeader(server.baseUrl, "um@test.eset.local"),
    hr: await authHeader(server.baseUrl, "hr@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    guard: await authHeader(server.baseUrl, "guard@test.eset.local"),
    otherSiteAdmin: await authHeader(server.baseUrl, "admin-othersite@test.eset.local"),
  };
  const uoms = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: tokens.ceo,
  });
  uomId = uoms.body.data[0].id;
});

after(async () => {
  await server.close();
});

test("INITIAL history is preserved and distinct FINAL actors approve the exact Pricing version", async () => {
  await setOverride(users.hr, "demand.approve", "GRANT");
  await setOverride(users.hr, "procurement.view_prices", "GRANT");
  try {
    const detail = await createPendingFinal();
    const pricingId = detail.pricing.id;

    const review = await finalDecision(detail.demand.id, "final-reviews", tokens.siteManager, pricingId);
    assert.equal(review.status, 200);
    assert.equal(review.body.data.demand.status, "PENDING_FINAL_APPROVAL");
    const approval = await finalDecision(detail.demand.id, "final-approvals", tokens.hr, pricingId);
    assert.equal(approval.status, 200);
    // Completing the final gate now also generates the official IPO in the
    // same transaction, so READY_FOR_IPO is an audited boundary rather than a
    // resting state (docs/PROCUREMENT_RECEIVING_SPEC.md §15).
    assert.equal(approval.body.data.demand.status, "IPO_GENERATED");
    const generated = await pool.query(
      "SELECT ipo_number, status, demand_revision, pricing_id FROM ipos WHERE demand_id = $1",
      [detail.demand.id],
    );
    assert.equal(generated.rowCount, 1);
    assert.equal(generated.rows[0].status, "GENERATED");
    assert.equal(generated.rows[0].pricing_id, pricingId);
    assert.match(generated.rows[0].ipo_number, /^ESET\/\d{4}\/\d+$/);

    const rows = await pool.query(
      `SELECT approval_stage, approval_type, pricing_id, decision
       FROM material_demand_approvals WHERE demand_id = $1
       ORDER BY approval_stage, approval_type`,
      [detail.demand.id],
    );
    assert.equal(rows.rowCount, 4);
    assert.equal(rows.rows.filter((row) => row.approval_stage === "INITIAL").length, 2);
    assert.ok(rows.rows.filter((row) => row.approval_stage === "INITIAL").every((row) => row.pricing_id === null));
    assert.ok(rows.rows.filter((row) => row.approval_stage === "FINAL").every((row) => row.pricing_id === pricingId));

    const readyAudit = await pool.query(
      "SELECT count(*)::int AS n FROM material_demand_audit_log WHERE demand_id = $1 AND action = 'READY_FOR_IPO'",
      [detail.demand.id],
    );
    assert.equal(readyAudit.rows[0].n, 1);
  } finally {
    await clearOverride(users.hr, "demand.approve");
    await clearOverride(users.hr, "procurement.view_prices");
  }
});

test("final action requires price-view, respects DENY, and preserves wrong-site isolation", async () => {
  await setOverride(users.hr, "demand.approve", "GRANT");
  await setOverride(users.otherSiteAdmin, "demand.review", "GRANT");
  await setOverride(users.otherSiteAdmin, "procurement.view_prices", "GRANT");
  await setOverride(users.siteManager, "procurement.view_prices", "DENY");
  try {
    const detail = await createPendingFinal();
    const pricingId = detail.pricing.id;

    for (const userId of [users.hr, users.siteManager, users.otherSiteAdmin]) {
      const notice = await pool.query(
        "SELECT count(*)::int AS n FROM notification_outbox WHERE idempotency_key = $1",
        [`demand:${detail.demand.id}:rev:1:pricing:1:final-review:${userId}`],
      );
      assert.equal(notice.rows[0].n, 0, "missing price-view, effective DENY, and wrong site must exclude recipients");
    }

    const missingPriceView = await finalDecision(detail.demand.id, "final-approvals", tokens.hr, pricingId);
    assert.equal(missingPriceView.status, 403);

    const denied = await finalDecision(detail.demand.id, "final-reviews", tokens.siteManager, pricingId);
    assert.equal(denied.status, 403);

    const wrongSite = await finalDecision(detail.demand.id, "final-reviews", tokens.otherSiteAdmin, pricingId);
    assert.equal(wrongSite.status, 404);
  } finally {
    await clearOverride(users.hr, "demand.approve");
    await clearOverride(users.otherSiteAdmin, "demand.review");
    await clearOverride(users.otherSiteAdmin, "procurement.view_prices");
    await clearOverride(users.siteManager, "procurement.view_prices");
  }
});

test("ordinary dual-capability actor cannot fill both FINAL slots, while CEO remains the explicit exception", async () => {
  await setOverride(users.siteManager, "demand.approve", "GRANT");
  try {
    const ordinary = await createPendingFinal();
    const pricingId = ordinary.pricing.id;
    assert.equal((await finalDecision(ordinary.demand.id, "final-reviews", tokens.siteManager, pricingId)).status, 200);
    assert.equal((await finalDecision(ordinary.demand.id, "final-approvals", tokens.siteManager, pricingId)).status, 409);

    const exceptional = await createPendingFinal();
    const ceoPricingId = exceptional.pricing.id;
    assert.equal((await finalDecision(exceptional.demand.id, "final-reviews", tokens.ceo, ceoPricingId)).status, 200);
    const completed = await finalDecision(exceptional.demand.id, "final-approvals", tokens.ceo, ceoPricingId);
    assert.equal(completed.status, 200);
    assert.equal(completed.body.data.demand.status, "IPO_GENERATED");
  } finally {
    await clearOverride(users.siteManager, "demand.approve");
  }
});

test("rejection preserves v1, creates controlled v2, and v2 resubmission has independent decisions and notifications", async () => {
  const detail = await createPendingFinal();
  const demandId = detail.demand.id;
  const v1Id = detail.pricing.id;

  assert.equal((await finalDecision(demandId, "final-reviews", tokens.siteManager, v1Id)).status, 200);
  const rejected = await finalDecision(
    demandId,
    "final-approvals",
    tokens.ceo,
    v1Id,
    "REJECTED",
    "Refresh the supplier estimate before authorization",
  );
  assert.equal(rejected.status, 200);
  assert.equal(rejected.body.data.demand.status, "PRICING_REVISION_REQUIRED");

  await assert.rejects(
    pool.query("UPDATE material_demand_pricing_lines SET estimated_unit_price = 1 WHERE pricing_id = $1", [v1Id]),
    /immutable/,
  );
  const revisionNotice = await pool.query(
    "SELECT payload FROM notification_outbox WHERE idempotency_key = $1",
    [`demand:${demandId}:rev:1:pricing:1:repricing-required:${users.ceo}`],
  );
  assert.equal(revisionNotice.rowCount, 1);
  assert.equal(JSON.stringify(revisionNotice.rows[0].payload).includes("supplier"), false);

  const started = await apiRequest(server.baseUrl, "POST", `/api/v1/procurement/pricing/${demandId}/repricing`, {
    token: tokens.ceo,
    body: { revision: 1 },
  });
  assert.equal(started.status, 201);
  assert.equal(started.body.data.demand.status, "READY_FOR_PRICING");
  assert.equal(started.body.data.pricing.version, 2);
  assert.equal(started.body.data.pricing.status, "DRAFT");
  assert.equal(started.body.data.lines[0].estimated_unit_price, "100.00");

  const historical = await currentPricing(demandId, tokens.ceo, 1);
  assert.equal(historical.status, 200);
  assert.equal(historical.body.data.pricing.id, v1Id);
  assert.equal(historical.body.data.canEdit, false);
  assert.equal(historical.body.data.finalApprovals.length, 2);

  const v2Id = started.body.data.pricing.id;
  const savedV2 = await apiRequest(server.baseUrl, "PUT", `/api/v1/procurement/pricing/${demandId}`, {
    token: tokens.ceo,
    body: {
      revision: 1,
      pricingVersion: 2,
      currency: "PKR",
      lines: started.body.data.lines.map((line, index) => ({
        demandLineId: line.demand_line_id,
        estimatedUnitPrice: index === 0 ? "90.00" : "20.00",
        procurementNote: null,
      })),
    },
  });
  assert.equal(savedV2.status, 200);
  const resubmitted = await apiRequest(server.baseUrl, "POST", `/api/v1/procurement/pricing/${demandId}/submit`, {
    token: tokens.ceo,
    body: { revision: 1, pricingVersion: 2 },
  });
  assert.equal(resubmitted.status, 200);
  assert.equal(resubmitted.body.data.demand.status, "PENDING_FINAL_APPROVAL");

  const stale = await finalDecision(demandId, "final-reviews", tokens.siteManager, v1Id);
  assert.equal(stale.status, 409);
  assert.equal((await finalDecision(demandId, "final-reviews", tokens.siteManager, v2Id)).status, 200);
  const ready = await finalDecision(demandId, "final-approvals", tokens.ceo, v2Id);
  assert.equal(ready.status, 200);
  assert.equal(ready.body.data.demand.status, "IPO_GENERATED");
  const v2Ipo = await pool.query("SELECT pricing_id FROM ipos WHERE demand_id = $1", [demandId]);
  assert.equal(v2Ipo.rowCount, 1, "exactly one IPO exists, bound to the approved version");
  assert.equal(v2Ipo.rows[0].pricing_id, v2Id);

  const versions = await pool.query(
    "SELECT id, version, status FROM material_demand_pricing WHERE demand_id = $1 ORDER BY version",
    [demandId],
  );
  assert.deepEqual(versions.rows, [
    { id: v1Id, version: 1, status: "SUBMITTED" },
    { id: v2Id, version: 2, status: "SUBMITTED" },
  ]);
  for (const version of [1, 2]) {
    const notice = await pool.query(
      "SELECT count(*)::int AS n FROM notification_outbox WHERE idempotency_key = $1",
      [`demand:${demandId}:rev:1:pricing:${version}:final-review:${users.ceo}`],
    );
    assert.equal(notice.rows[0].n, 1);
  }
});

test("UPPER_MANAGEMENT final review and Formal approval race to exactly one READY_FOR_IPO transition", async () => {
  const detail = await createPendingFinal();
  const pricingId = detail.pricing.id;
  const [review, approval] = await Promise.all([
    finalDecision(detail.demand.id, "final-reviews", tokens.upperManagement, pricingId),
    finalDecision(detail.demand.id, "final-approvals", tokens.ceo, pricingId),
  ]);
  assert.deepEqual([review.status, approval.status], [200, 200]);

  const decisions = await pool.query(
    `SELECT count(*)::int AS n FROM material_demand_approvals
     WHERE demand_id = $1 AND approval_stage = 'FINAL' AND pricing_id = $2`,
    [detail.demand.id, pricingId],
  );
  assert.equal(decisions.rows[0].n, 2);
  const transitions = await pool.query(
    "SELECT count(*)::int AS n FROM material_demand_audit_log WHERE demand_id = $1 AND action = 'READY_FOR_IPO'",
    [detail.demand.id],
  );
  assert.equal(transitions.rows[0].n, 1);
});

test("concurrent rejection and approval can never produce READY_FOR_IPO after rejection", async () => {
  const detail = await createPendingFinal();
  const pricingId = detail.pricing.id;
  const responses = await Promise.all([
    finalDecision(detail.demand.id, "final-reviews", tokens.siteManager, pricingId, "REJECTED", "Reprice"),
    finalDecision(detail.demand.id, "final-approvals", tokens.ceo, pricingId),
  ]);
  assert.ok(responses.every((response) => [200, 409].includes(response.status)));
  assert.ok(responses.some((response) => response.status === 200));

  const demand = await pool.query("SELECT status FROM material_demands WHERE id = $1", [detail.demand.id]);
  assert.equal(demand.rows[0].status, "PRICING_REVISION_REQUIRED");
  const ready = await pool.query(
    "SELECT count(*)::int AS n FROM material_demand_audit_log WHERE demand_id = $1 AND action = 'READY_FOR_IPO'",
    [detail.demand.id],
  );
  assert.equal(ready.rows[0].n, 0);
});

test("duplicate, late, and stale-version FINAL decisions fail without duplicate history", async () => {
  const detail = await createPendingFinal();
  const pricingId = detail.pricing.id;
  assert.equal((await finalDecision(detail.demand.id, "final-reviews", tokens.siteManager, pricingId)).status, 200);
  assert.equal((await finalDecision(detail.demand.id, "final-reviews", tokens.siteManager, pricingId)).status, 409);
  assert.equal((await finalDecision(detail.demand.id, "final-approvals", tokens.ceo, pricingId)).status, 200);
  assert.equal((await finalDecision(detail.demand.id, "final-approvals", tokens.ceo, pricingId)).status, 409);

  const rows = await pool.query(
    `SELECT count(*)::int AS n FROM material_demand_approvals
     WHERE demand_id = $1 AND approval_stage = 'FINAL'`,
    [detail.demand.id],
  );
  assert.equal(rows.rows[0].n, 2);
});

test("department users see safe workflow state but no FINAL rejection reason or price payload", async () => {
  const detail = await createPendingFinal();
  await finalDecision(
    detail.demand.id,
    "final-reviews",
    tokens.siteManager,
    detail.pricing.id,
    "REJECTED",
    "Quoted rate exceeds the confidential budget ceiling",
  );

  const operational = await apiRequest(server.baseUrl, "GET", `/api/v1/demands/${detail.demand.id}`, {
    token: tokens.teamLead,
  });
  assert.equal(operational.status, 200);
  assert.equal(operational.body.data.demand.status, "PRICING_REVISION_REQUIRED");
  const finalReview = operational.body.data.approvals.find((approval) => approval.approval_stage === "FINAL");
  assert.equal(finalReview.reason, null);
  assert.equal(JSON.stringify(operational.body.data).includes("confidential budget"), false);

  for (const token of [tokens.teamLead, tokens.admin, tokens.guard]) {
    assert.equal((await currentPricing(detail.demand.id, token)).status, 403);
  }
});

test("FINAL decisions stay append-only and the database enforces pricing-version binding", async () => {
  const first = await createPendingFinal();
  const second = await createPendingFinal();
  await finalDecision(first.demand.id, "final-reviews", tokens.siteManager, first.pricing.id);
  const approval = await pool.query(
    `SELECT id FROM material_demand_approvals
     WHERE demand_id = $1 AND approval_stage = 'FINAL'`,
    [first.demand.id],
  );
  await assert.rejects(
    pool.query("UPDATE material_demand_approvals SET reason = 'tampered' WHERE id = $1", [approval.rows[0].id]),
    /append-only/i,
  );
  // A FINAL decision must name the exact purchasing set it approved, so one
  // recorded without a fingerprint is refused outright.
  await assert.rejects(
    pool.query(
      `INSERT INTO material_demand_approvals
         (demand_id, revision, approval_stage, approval_type, pricing_id,
          decision, actor_user_id)
       VALUES ($1, 1, 'FINAL', 'FORMAL_APPROVAL', $2, 'APPROVED', $3)`,
      [first.demand.id, first.pricing.id, users.ceo],
    ),
    /fingerprint_check/,
  );

  // With a well-formed fingerprint, the composite binding is still what
  // prevents a decision claiming another Demand's Pricing version.
  const fingerprint = "a".repeat(64);
  await assert.rejects(
    pool.query(
      `INSERT INTO material_demand_approvals
         (demand_id, revision, approval_stage, approval_type, pricing_id,
          disposition_fingerprint, decision, actor_user_id)
       VALUES ($1, 1, 'FINAL', 'FORMAL_APPROVAL', $2, $3, 'APPROVED', $4)`,
      [first.demand.id, second.pricing.id, fingerprint, users.ceo],
    ),
    /pricing_binding_fkey|foreign key constraint/,
  );
});
