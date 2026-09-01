import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

// The FORMAL_APPROVER bundle granted only `demand.approve`, but the final
// approval gate requires `demand.approve` AND `procurement.view_prices`. A
// user assigned exactly that bundle therefore passed the INITIAL gate and
// dead-ended at the FINAL one with a bare 403 and no UI affordance, stalling
// every Demand at PENDING_FINAL_APPROVAL.
//
// The load-bearing test is the first one: it drives the bundle holder through
// BOTH gates to IPO_GENERATED. Nothing in the previous suite did that, which
// is why the gap shipped.

let server;
let users;
let ceoToken;
let teamLeadToken;
let approverToken;
let uomId;

// A dedicated account whose ONLY authority is the bundle, so nothing else can
// mask a missing permission.
const APPROVER_EMAIL = "formal-approver@test.eset.local";
const APPROVER_PASSWORD = "Formal-Approver-123!";
let approverId;

async function assignBundle(code) {
  const response = await apiRequest(server.baseUrl, "PUT", `/api/v1/users/${approverId}/bundles/${code}`, {
    token: ceoToken,
  });
  // Re-assignment is a deliberate conflict, so tests that each ensure the
  // bundle is present accept "already assigned" as the same end state.
  assert.ok([200, 409].includes(response.status), JSON.stringify(response.body));
  // Effective permissions are recomputed per request, but the session cookie
  // is re-issued here so the test reads them the way a real sign-in would.
  approverToken = await authHeader(server.baseUrl, APPROVER_EMAIL, APPROVER_PASSWORD);
}

async function permissionsOf(token) {
  const response = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me", { token });
  assert.equal(response.status, 200);
  return new Set(response.body.data.user.permissions);
}

// Drives a fresh Demand as far as PENDING_FINAL_APPROVAL, which is where the
// dead end used to be.
async function demandAwaitingFinalApproval() {
  const catalog = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: {
      newItem: { name: `Formal Approver ${crypto.randomBytes(4).toString("hex")}` },
      defaultUomId: uomId,
    },
  });
  assert.equal(catalog.status, 201, JSON.stringify(catalog.body));

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: { lines: [{ catalogEntryId: catalog.body.data.id, quantity: 4 }] },
  });
  const demandId = created.body.data.demand.id;

  await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${demandId}/submit`, { token: teamLeadToken });
  await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${demandId}/reviews`, {
    token: ceoToken,
    body: { decision: "APPROVED" },
  });
  await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${demandId}/approvals`, {
    token: ceoToken,
    body: { decision: "APPROVED" },
  });

  const lines = await pool.query("SELECT id FROM material_demand_lines WHERE demand_id = $1", [demandId]);
  const save = await apiRequest(server.baseUrl, "PUT", `/api/v1/procurement/pricing/${demandId}`, {
    token: ceoToken,
    body: {
      revision: 1,
      pricingVersion: 1,
      currency: "PKR",
      lines: [{ demandLineId: lines.rows[0].id, estimatedUnitPrice: "1250.50" }],
    },
  });
  assert.equal(save.status, 200, JSON.stringify(save.body));
  await apiRequest(server.baseUrl, "POST", `/api/v1/procurement/pricing/${demandId}/submit`, {
    token: ceoToken,
    body: { revision: 1, pricingVersion: 1 },
  });

  const pricing = await pool.query("SELECT id FROM material_demand_pricing WHERE demand_id = $1", [demandId]);
  return { demandId, pricingId: pricing.rows[0].id };
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  teamLeadToken = await authHeader(server.baseUrl, "teamlead@test.eset.local");

  const uom = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", { token: ceoToken });
  uomId = uom.body.data[0].id;

  const argon2 = (await import("argon2")).default;
  const inserted = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role_id, site_id)
     VALUES ($1, $2, 'Formal Approver', (SELECT id FROM roles WHERE name = 'EMPLOYEE'), $3)
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash, site_id = EXCLUDED.site_id
     RETURNING id`,
    [APPROVER_EMAIL, await argon2.hash(APPROVER_PASSWORD), users.mainSite],
  );
  approverId = inserted.rows[0].id;
});

after(async () => {
  await pool.query("DELETE FROM user_permission_bundle_assignments WHERE user_id = $1", [approverId]);
  await server.close();
  await pool.end();
});

test("a FORMAL_APPROVER completes BOTH approval gates and the IPO is generated", async () => {
  await assignBundle("FORMAL_APPROVER");

  const { demandId, pricingId } = await demandAwaitingFinalApproval();

  // The bundle holder must be able to see the Demand they are asked to decide.
  const visible = await apiRequest(server.baseUrl, "GET", `/api/v1/demands/${demandId}`, { token: approverToken });
  assert.equal(visible.status, 200, "the approver must be able to open the Demand awaiting them");

  // And to see the priced version the decision is about.
  const pricingDetail = await apiRequest(server.baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, {
    token: approverToken,
  });
  assert.equal(pricingDetail.status, 200, "the approver must be able to see the amount they are approving");

  // The final stage has two slots. The management review is performed by a
  // different actor because an approver may not also review their own
  // decision (see recordFinalApprovalDecision's self-approval rule).
  const finalReview = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${demandId}/final-reviews`, {
    token: ceoToken,
    body: { decision: "APPROVED", pricingId },
  });
  assert.equal(finalReview.status, 200, JSON.stringify(finalReview.body));

  // The gate that used to 403.
  const finalApproval = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${demandId}/final-approvals`, {
    token: approverToken,
    body: { decision: "APPROVED", pricingId },
  });
  assert.equal(finalApproval.status, 200, JSON.stringify(finalApproval.body));

  const demand = await pool.query("SELECT status FROM material_demands WHERE id = $1", [demandId]);
  assert.equal(demand.rows[0].status, "IPO_GENERATED", "the workflow must actually complete");

  const ipo = await pool.query("SELECT ipo_number FROM ipos WHERE demand_id = $1", [demandId]);
  assert.equal(ipo.rowCount, 1, "an IPO must be generated by the approval");
});

test("a FORMAL_APPROVER can also complete the initial gate", async () => {
  await assignBundle("FORMAL_APPROVER");

  const catalog = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: teamLeadToken,
    body: { newItem: { name: `Initial Gate ${crypto.randomBytes(4).toString("hex")}` }, defaultUomId: uomId },
  });
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: teamLeadToken,
    body: { lines: [{ catalogEntryId: catalog.body.data.id, quantity: 1 }] },
  });
  const demandId = created.body.data.demand.id;
  await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${demandId}/submit`, { token: teamLeadToken });

  const approved = await apiRequest(server.baseUrl, "POST", `/api/v1/demands/${demandId}/approvals`, {
    token: approverToken,
    body: { decision: "APPROVED" },
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
});

test("the bundle grants price VISIBILITY and no Procurement operational authority", async () => {
  await assignBundle("FORMAL_APPROVER");
  const held = await permissionsOf(approverToken);

  assert.ok(held.has("demand.approve"), "the formal decision permission");
  assert.ok(held.has("procurement.view_prices"), "the field visibility the final gate requires");

  // Kept separate from Procurement operations, exactly as the bundle's own
  // description says.
  for (const forbidden of ["procurement.pricing", "procurement.purchase", "ipo.cancel", "procurement.site_scope", "dc.manage"]) {
    assert.ok(!held.has(forbidden), `FORMAL_APPROVER must not grant ${forbidden}`);
  }
});

test("price visibility does not widen record scope for a formal approver", async () => {
  await assignBundle("FORMAL_APPROVER");

  // A Demand at another SITE stays invisible: the approver's reach is their
  // own site, from demand.approve, and procurement.view_prices adds nothing.
  const otherSiteLead = await authHeader(server.baseUrl, "teamlead-othersite@test.eset.local");
  const foreignCatalog = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: otherSiteLead,
    body: { newItem: { name: `Foreign Scope ${crypto.randomBytes(4).toString("hex")}` }, defaultUomId: uomId },
  });
  const foreignDemand = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: otherSiteLead,
    body: { lines: [{ catalogEntryId: foreignCatalog.body.data.id, quantity: 1 }] },
  });
  const foreignId = foreignDemand.body.data.demand.id;

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/demands/${foreignId}`, { token: approverToken });
  assert.equal(detail.status, 404, "another site's Demand must stay invisible");

  const list = await apiRequest(server.baseUrl, "GET", "/api/v1/demands", { token: approverToken });
  assert.equal(list.status, 200);
  assert.ok(
    !list.body.data.some((row) => row.id === foreignId),
    "another site's Demand must never appear in the approver's list",
  );

  // And the pricing WORK QUEUE stays gated on procurement.pricing, which the
  // bundle deliberately does not grant.
  const queue = await apiRequest(server.baseUrl, "GET", "/api/v1/procurement/pricing", { token: approverToken });
  assert.equal(queue.status, 403, "seeing prices is not authority to do Procurement's work");
});

test("an explicit DENY on price visibility still wins over the bundle", async () => {
  await assignBundle("FORMAL_APPROVER");

  await pool.query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by_user_id)
     SELECT $1, id, 'DENY', $2 FROM permissions WHERE code = 'procurement.view_prices'
     ON CONFLICT DO NOTHING`,
    [approverId, users.ceo],
  );

  try {
    const held = await permissionsOf(await authHeader(server.baseUrl, APPROVER_EMAIL, APPROVER_PASSWORD));
    assert.ok(!held.has("procurement.view_prices"), "explicit DENY must beat a bundle grant");
  } finally {
    await pool.query("DELETE FROM user_permission_overrides WHERE user_id = $1", [approverId]);
  }
});

test("removing the bundle removes both permissions and leaves nothing behind", async () => {
  await assignBundle("FORMAL_APPROVER");

  const removed = await apiRequest(
    server.baseUrl,
    "DELETE",
    `/api/v1/users/${approverId}/bundles/FORMAL_APPROVER`,
    { token: ceoToken },
  );
  assert.equal(removed.status, 200, JSON.stringify(removed.body));

  const held = await permissionsOf(await authHeader(server.baseUrl, APPROVER_EMAIL, APPROVER_PASSWORD));
  assert.ok(!held.has("demand.approve"));
  assert.ok(!held.has("procurement.view_prices"));
});
