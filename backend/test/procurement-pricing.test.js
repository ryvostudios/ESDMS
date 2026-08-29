import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers, login } from "./setup.js";
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

async function addCatalogEntry(name = "Pricing material") {
  const response = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: tokens.teamLead,
    body: { newItem: { name: unique(name) }, defaultUomId: uomId },
  });
  assert.equal(response.status, 201);
  return response.body.data.id;
}

async function createDemand({ quantities = [50, 20], ready = true } = {}) {
  const catalogEntryIds = [];
  for (let index = 0; index < quantities.length; index += 1) {
    catalogEntryIds.push(await addCatalogEntry(`Pricing item ${index + 1}`));
  }

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: tokens.teamLead,
    body: {
      lines: catalogEntryIds.map((catalogEntryId, index) => ({
        catalogEntryId,
        quantity: quantities[index],
      })),
    },
  });
  assert.equal(created.status, 201);
  const id = created.body.data.demand.id;

  if (!ready) return created.body.data;

  const submitted = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/submit`, {
    token: tokens.teamLead,
  });
  assert.equal(submitted.status, 200);
  const review = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/reviews`, {
    token: tokens.siteManager,
    body: { decision: "APPROVED" },
  });
  assert.equal(review.status, 200);
  const approval = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${id}/approvals`, {
    token: tokens.ceo,
    body: { decision: "APPROVED" },
  });
  assert.equal(approval.status, 200);
  assert.equal(approval.body.data.demand.status, "READY_FOR_PRICING");
  return approval.body.data;
}

function pricingBody(detail, prices = ["100.00", "2.50"]) {
  return {
    revision: detail.demand.revision,
    pricingVersion: detail.pricing?.version || 1,
    currency: "PKR",
    lines: detail.lines.map((line, index) => ({
      demandLineId: line.id || line.demand_line_id,
      estimatedUnitPrice: prices[index],
      procurementNote: index === 0 ? "Current market estimate" : null,
    })),
  };
}

async function getPricing(demandId, token = tokens.ceo) {
  return apiRequest(server.baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, { token });
}

async function savePricing(detail, token = tokens.ceo, prices) {
  return apiRequest(server.baseUrl, "PUT", `/api/v1/procurement/pricing/${detail.demand.id}`, {
    token,
    body: pricingBody(detail, prices),
  });
}

async function submitPricing(detail, token = tokens.ceo) {
  return apiRequest(server.baseUrl, "POST", `/api/v1/procurement/pricing/${detail.demand.id}/submit`, {
    token,
    body: { revision: detail.demand.revision, pricingVersion: detail.pricing?.version || 1 },
  });
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    upperManagement: await authHeader(server.baseUrl, "um@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    guard: await authHeader(server.baseUrl, "guard@test.eset.local"),
    otherSiteAdmin: await authHeader(server.baseUrl, "admin-othersite@test.eset.local"),
  };

  const uomResponse = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: tokens.ceo,
  });
  uomId = uomResponse.body.data[0].id;
});

after(async () => {
  await server.close();
});

test("procurement queue is capability-gated, site-scoped, status-filtered, and paginated", async () => {
  const ready = await createDemand();
  await createDemand({ ready: false });
  await setOverride(users.admin, "procurement.pricing", "GRANT");
  await setOverride(users.otherSiteAdmin, "procurement.pricing", "GRANT");
  try {
    // Without procurement.site_scope the queue must not advertise another
    // department's Demand: the detail route would refuse it as 404, and a
    // queue that lists what its detail route denies is the defect this
    // guards. procurement.pricing alone answers WHAT, never WHERE.
    const unscopedQueue = await apiRequest(
      server.baseUrl,
      "GET",
      `/api/v1/procurement/pricing?search=${encodeURIComponent(ready.demand.demand_number)}`,
      { token: tokens.admin },
    );
    assert.equal(unscopedQueue.status, 200);
    assert.equal(unscopedQueue.body.data.some((row) => row.id === ready.demand.id), false);

    await setOverride(users.admin, "procurement.site_scope", "GRANT");
    await setOverride(users.otherSiteAdmin, "procurement.site_scope", "GRANT");

    const queue = await apiRequest(
      server.baseUrl,
      "GET",
      `/api/v1/procurement/pricing?page=1&pageSize=1&search=${encodeURIComponent(ready.demand.demand_number)}`,
      {
      token: tokens.admin,
      },
    );
    assert.equal(queue.status, 200);
    assert.equal(queue.body.data.length, 1);
    assert.equal(queue.body.meta.pageSize, 1);
    assert.equal(queue.body.meta.total, 1);
    assert.equal(queue.body.data.some((row) => row.id === ready.demand.id), true);

    const wrongSiteQueue = await apiRequest(server.baseUrl, "GET", "/api/v1/procurement/pricing?search=DL-", {
      token: tokens.otherSiteAdmin,
    });
    assert.equal(wrongSiteQueue.status, 200);
    assert.equal(wrongSiteQueue.body.data.some((row) => row.id === ready.demand.id), false);
  } finally {
    await clearOverride(users.admin, "procurement.pricing");
    await clearOverride(users.admin, "procurement.site_scope");
    await clearOverride(users.otherSiteAdmin, "procurement.pricing");
    await clearOverride(users.otherSiteAdmin, "procurement.site_scope");
  }
});

test("explicitly granted Procurement can price its site across departments but not another site", async () => {
  const detail = await createDemand();
  // Two separate grants by design: the action capability says WHAT this actor
  // may do, procurement.site_scope says WHERE. Cross-department reach is
  // never inferred from holding procurement.pricing alone.
  await setOverride(users.admin, "procurement.pricing", "GRANT");
  await setOverride(users.admin, "procurement.site_scope", "GRANT");
  await setOverride(users.otherSiteAdmin, "procurement.pricing", "GRANT");
  await setOverride(users.otherSiteAdmin, "procurement.site_scope", "GRANT");
  try {
    const saved = await savePricing(detail, tokens.admin);
    assert.equal(saved.status, 200);
    assert.equal(saved.body.data.pricing.status, "DRAFT");

    const wrongSite = await getPricing(detail.demand.id, tokens.otherSiteAdmin);
    assert.equal(wrongSite.status, 404);
  } finally {
    await clearOverride(users.admin, "procurement.pricing");
    await clearOverride(users.admin, "procurement.site_scope");
    await clearOverride(users.otherSiteAdmin, "procurement.pricing");
    await clearOverride(users.otherSiteAdmin, "procurement.site_scope");
  }
});

test("ADMIN, TEAM_LEAD, and GATE_GUARD have no pricing or price-view authority by default", async () => {
  const detail = await createDemand();
  for (const token of [tokens.admin, tokens.teamLead, tokens.guard]) {
    const queue = await apiRequest(server.baseUrl, "GET", "/api/v1/procurement/pricing", { token });
    assert.equal(queue.status, 403);
    const direct = await getPricing(detail.demand.id, token);
    assert.equal(direct.status, 403);
  }
});

test("CEO can price company-wide; an explicit DENY still wins", async () => {
  const detail = await createDemand();
  const visible = await getPricing(detail.demand.id, tokens.ceo);
  assert.equal(visible.status, 200);

  await setOverride(users.ceo, "procurement.pricing", "DENY");
  try {
    const denied = await savePricing(detail, tokens.ceo);
    assert.equal(denied.status, 403);
  } finally {
    await clearOverride(users.ceo, "procurement.pricing");
  }
});

test("an inactive explicitly granted Procurement account is rejected at authentication", async () => {
  await pool.query("UPDATE users SET is_active = true WHERE id = $1", [users.inactive]);
  await setOverride(users.inactive, "procurement.pricing", "GRANT");
  const activeLogin = await login(server.baseUrl, "inactive@test.eset.local");
  assert.equal(activeLogin.status, 200);
  await pool.query("UPDATE users SET is_active = false WHERE id = $1", [users.inactive]);
  try {
    const response = await apiRequest(server.baseUrl, "GET", "/api/v1/procurement/pricing", {
      token: activeLogin.cookie,
    });
    assert.equal(response.status, 401);
  } finally {
    await clearOverride(users.inactive, "procurement.pricing");
  }
});

test("management price viewers cannot retrieve a draft but can retrieve submitted pricing", async () => {
  const detail = await createDemand();
  await savePricing(detail);

  const draft = await getPricing(detail.demand.id, tokens.upperManagement);
  assert.equal(draft.status, 404);

  await submitPricing(detail);
  const submitted = await getPricing(detail.demand.id, tokens.upperManagement);
  assert.equal(submitted.status, 200);
  assert.equal(submitted.body.data.pricing.status, "SUBMITTED");
  assert.equal(submitted.body.data.canEdit, false);
  assert.equal(submitted.body.data.estimatedTotal, "5050.00");
});

test("ordinary Demand GET never leaks protected price fields or totals", async () => {
  const detail = await createDemand();
  await savePricing(detail);
  await submitPricing(detail);

  const operational = await apiRequest(server.baseUrl, "GET", `/api/v1/demands/${detail.demand.id}`, {
    token: tokens.teamLead,
  });
  assert.equal(operational.status, 200);
  assert.equal(operational.body.data.demand.status, "PENDING_FINAL_APPROVAL");
  for (const line of operational.body.data.lines) {
    assert.equal("estimated_unit_price" in line, false);
    assert.equal("line_total" in line, false);
    assert.equal("procurement_note" in line, false);
  }
  assert.equal("pricing" in operational.body.data, false);
  assert.equal("estimatedTotal" in operational.body.data, false);
});

test("price validation rejects zero, negative, malformed, numeric, oversized, and client-total input", async () => {
  const detail = await createDemand({ quantities: [1] });
  const lineId = detail.lines[0].id;
  const invalidBodies = [
    { estimatedUnitPrice: "0" },
    { estimatedUnitPrice: "-1.00" },
    { estimatedUnitPrice: "NaN" },
    { estimatedUnitPrice: "Infinity" },
    { estimatedUnitPrice: "1.001" },
    { estimatedUnitPrice: 100 },
    { estimatedUnitPrice: "1000000000000.00" },
    { estimatedUnitPrice: "100.00", claimedTotal: "1.00" },
  ];

  for (const line of invalidBodies) {
    const response = await apiRequest(server.baseUrl, "PUT", `/api/v1/procurement/pricing/${detail.demand.id}`, {
      token: tokens.ceo,
      body: { revision: 1, pricingVersion: 1, currency: "PKR", lines: [{ demandLineId: lineId, ...line }] },
    });
    assert.equal(response.status, 400);
  }

  const pricingId = await pool.query(
    `INSERT INTO material_demand_pricing
       (demand_id, demand_revision, currency, created_by_user_id)
     VALUES ($1, 1, 'PKR', $2)
     RETURNING id`,
    [detail.demand.id, users.ceo],
  );
  for (const nonFinite of ["NaN", "Infinity", "-Infinity"]) {
    await assert.rejects(
      pool.query(
        `INSERT INTO material_demand_pricing_lines
           (pricing_id, demand_id, demand_line_id, estimated_unit_price)
         VALUES ($1, $2, $3, $4::numeric)`,
        [pricingId.rows[0].id, detail.demand.id, lineId, nonFinite],
      ),
      /price_check|numeric field overflow/,
    );
  }
});

test("unrelated and duplicate Demand lines are rejected", async () => {
  const first = await createDemand({ quantities: [1] });
  const second = await createDemand({ quantities: [1] });
  const unrelated = await apiRequest(server.baseUrl, "PUT", `/api/v1/procurement/pricing/${first.demand.id}`, {
    token: tokens.ceo,
    body: {
      revision: 1,
      pricingVersion: 1,
      currency: "PKR",
      lines: [{ demandLineId: second.lines[0].id, estimatedUnitPrice: "10.00" }],
    },
  });
  assert.equal(unrelated.status, 400);

  const duplicateLine = { demandLineId: first.lines[0].id, estimatedUnitPrice: "10.00" };
  const duplicate = await apiRequest(server.baseUrl, "PUT", `/api/v1/procurement/pricing/${first.demand.id}`, {
    token: tokens.ceo,
    body: { revision: 1, pricingVersion: 1, currency: "PKR", lines: [duplicateLine, duplicateLine] },
  });
  assert.equal(duplicate.status, 400);
});

test("a non-ready Demand cannot be priced and a stale revision is rejected", async () => {
  const draft = await createDemand({ ready: false, quantities: [1] });
  const nonReady = await savePricing(draft, tokens.ceo, ["10.00"]);
  assert.equal(nonReady.status, 409);

  const ready = await createDemand({ quantities: [1] });
  const stale = await apiRequest(server.baseUrl, "PUT", `/api/v1/procurement/pricing/${ready.demand.id}`, {
    token: tokens.ceo,
    body: {
      revision: ready.demand.revision + 1,
      pricingVersion: 1,
      currency: "PKR",
      lines: [{ demandLineId: ready.lines[0].id, estimatedUnitPrice: "10.00" }],
    },
  });
  assert.equal(stale.status, 409);
});

test("draft saves leave Demand READY_FOR_PRICING and only audit meaningful saves", async () => {
  const detail = await createDemand();
  const first = await savePricing(detail);
  assert.equal(first.status, 200);
  assert.equal(first.body.data.demand.status, "READY_FOR_PRICING");

  await savePricing(detail);
  await savePricing(detail, tokens.ceo, ["101.00", "2.50"]);
  const audit = await pool.query(
    `SELECT action, count(*)::int AS n
     FROM material_demand_audit_log
     WHERE demand_id = $1 AND action LIKE 'PRICING_DRAFT_%'
     GROUP BY action`,
    [detail.demand.id],
  );
  const counts = Object.fromEntries(audit.rows.map((row) => [row.action, row.n]));
  assert.equal(counts.PRICING_DRAFT_CREATED, 1);
  assert.equal(counts.PRICING_DRAFT_SAVED, 1);
});

test("incomplete pricing cannot submit", async () => {
  const detail = await createDemand();
  await savePricing({ ...detail, lines: [detail.lines[0]] }, tokens.ceo, ["10.00"]);
  const response = await submitPricing(detail);
  assert.equal(response.status, 400);
});

test("server computes exact line and multi-line totals and ignores no client totals", async () => {
  const detail = await createDemand();
  const saved = await savePricing(detail);
  assert.equal(saved.status, 200);
  assert.equal(saved.body.data.lines[0].line_total, "5000.00");
  assert.equal(saved.body.data.lines[1].line_total, "50.00");
  assert.equal(saved.body.data.estimatedTotal, "5050.00");
});

test("submission transitions exactly once, notifies final-gate actors once, and replay is idempotent", async () => {
  const detail = await createDemand();
  await savePricing(detail);

  const responses = await Promise.all([submitPricing(detail), submitPricing(detail)]);
  assert.deepEqual(responses.map((response) => response.status), [200, 200]);
  assert.ok(responses.every((response) => response.body.data.demand.status === "PENDING_FINAL_APPROVAL"));

  const audit = await pool.query(
    `SELECT action, count(*)::int AS n
     FROM material_demand_audit_log
     WHERE demand_id = $1 AND action IN ('PRICING_SUBMITTED', 'PENDING_FINAL_APPROVAL')
     GROUP BY action`,
    [detail.demand.id],
  );
  assert.deepEqual(
    Object.fromEntries(audit.rows.map((row) => [row.action, row.n])),
    { PENDING_FINAL_APPROVAL: 1, PRICING_SUBMITTED: 1 },
  );

  for (const userId of [users.ceo, users.siteManager, users.upperManagement]) {
    const notification = await pool.query(
      `SELECT payload FROM notification_outbox
       WHERE idempotency_key = $1`,
      [`demand:${detail.demand.id}:rev:1:pricing:1:final-review:${userId}`],
    );
    assert.equal(notification.rowCount, 1);
    assert.equal(JSON.stringify(notification.rows[0].payload).includes("estimated"), false);
  }
});

test("final-gate notification resolver honors explicit GRANT, DENY, inactivity, and site scope", async () => {
  await setOverride(users.hr, "demand.approve", "GRANT");
  await setOverride(users.hr, "procurement.view_prices", "GRANT");
  await setOverride(users.upperManagement, "demand.review", "DENY");
  await setOverride(users.otherSiteAdmin, "demand.review", "GRANT");
  try {
    const detail = await createDemand();
    await savePricing(detail);
    await submitPricing(detail);

    const keys = await pool.query(
      `SELECT recipient_user_id FROM notification_outbox
       WHERE idempotency_key LIKE $1`,
      [`demand:${detail.demand.id}:rev:1:pricing:1:final-review:%`],
    );
    const recipients = new Set(keys.rows.map((row) => row.recipient_user_id));
    assert.equal(recipients.has(users.hr), true, "explicit Formal Approval GRANT is eligible");
    assert.equal(recipients.has(users.upperManagement), false, "explicit review DENY wins");
    assert.equal(recipients.has(users.otherSiteAdmin), false, "wrong-site reviewer is excluded");
  } finally {
    await clearOverride(users.hr, "demand.approve");
    await clearOverride(users.hr, "procurement.view_prices");
    await clearOverride(users.upperManagement, "demand.review");
    await clearOverride(users.otherSiteAdmin, "demand.review");
  }
});

test("submitted pricing cannot be edited through API or changed/deleted directly in the database", async () => {
  const detail = await createDemand();
  const saved = await savePricing(detail);
  await submitPricing(detail);

  const edit = await savePricing(detail, tokens.ceo, ["999.00", "999.00"]);
  assert.equal(edit.status, 409);

  const pricingId = saved.body.data.pricing.id;
  const lineId = saved.body.data.lines[0].demand_line_id;
  await assert.rejects(
    pool.query("UPDATE material_demand_pricing_lines SET estimated_unit_price = 999 WHERE demand_line_id = $1", [lineId]),
    /immutable/,
  );
  await assert.rejects(
    pool.query("DELETE FROM material_demand_pricing_lines WHERE demand_line_id = $1", [lineId]),
    /immutable/,
  );
  await assert.rejects(
    pool.query("UPDATE material_demand_pricing SET currency = 'PKR' WHERE id = $1", [pricingId]),
    /immutable/,
  );
  await assert.rejects(pool.query("DELETE FROM material_demand_pricing WHERE id = $1", [pricingId]), /immutable/);
});

test("a concurrent draft edit cannot land after submission", async () => {
  const detail = await createDemand();
  await savePricing(detail);

  const [edit, submit] = await Promise.all([
    savePricing(detail, tokens.ceo, ["125.00", "3.00"]),
    submitPricing(detail),
  ]);
  assert.equal(submit.status, 200);
  assert.ok([200, 409].includes(edit.status));

  const final = await getPricing(detail.demand.id);
  assert.equal(final.status, 200);
  assert.equal(final.body.data.pricing.status, "SUBMITTED");
  const frozenPrice = final.body.data.lines[0].estimated_unit_price;
  assert.ok(["100.00", "125.00"].includes(frozenPrice));

  const laterEdit = await savePricing(detail, tokens.ceo, ["130.00", "4.00"]);
  assert.equal(laterEdit.status, 409);
  const unchanged = await getPricing(detail.demand.id);
  assert.equal(unchanged.body.data.lines[0].estimated_unit_price, frozenPrice);
});

test("submission fails safely when Demand state changed after draft save", async () => {
  const detail = await createDemand();
  await savePricing(detail);
  await pool.query("UPDATE material_demands SET status = 'PENDING_FINAL_APPROVAL' WHERE id = $1", [detail.demand.id]);

  const response = await submitPricing(detail);
  assert.equal(response.status, 409);
  const pricing = await pool.query("SELECT status FROM material_demand_pricing WHERE demand_id = $1", [detail.demand.id]);
  assert.equal(pricing.rows[0].status, "DRAFT");
});

test("database composite foreign keys reject a pricing line from another Demand", async () => {
  const first = await createDemand({ quantities: [1] });
  const second = await createDemand({ quantities: [1] });
  const saved = await savePricing(first, tokens.ceo, ["10.00"]);

  await assert.rejects(
    pool.query(
      `INSERT INTO material_demand_pricing_lines
         (pricing_id, demand_id, demand_line_id, estimated_unit_price)
       VALUES ($1, $2, $3, 10)`,
      [saved.body.data.pricing.id, first.demand.id, second.lines[0].id],
    ),
    /foreign key constraint/,
  );
});

test("database uniqueness prevents competing pricing headers for one Demand revision", async () => {
  const detail = await createDemand({ quantities: [1] });
  await savePricing(detail, tokens.ceo, ["10.00"]);

  await assert.rejects(
    pool.query(
      `INSERT INTO material_demand_pricing
         (demand_id, demand_revision, currency, created_by_user_id)
       VALUES ($1, $2, 'PKR', $3)`,
      [detail.demand.id, detail.demand.revision, users.ceo],
    ),
    /material_demand_pricing_demand_revision_version_key/,
  );
});
