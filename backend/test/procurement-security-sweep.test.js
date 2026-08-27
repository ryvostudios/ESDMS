import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { buildApprovedIpo, createFinalizedDc, recordPurchase } from "./procurement-chain-helpers.js";

// Distinctive values that appear nowhere else, so finding any of them in a
// response is unambiguous proof of a leak.
const ESTIMATED = "31337.11";
const ACTUAL = "27182.81";
const PROCUREMENT_NOTE = "SECRET-PROCUREMENT-NOTE-XYZZY";

let ctx;
let users;
let UOM_ID;
let chain;
let dcId;
let receiptId;

before(async () => {
  const server = await startTestServer();
  users = await seedUsers();
  const tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    upperManagement: await authHeader(server.baseUrl, "um@test.eset.local"),
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    teamLeadOtherDept: await authHeader(server.baseUrl, "teamlead2@test.eset.local"),
    employee: await authHeader(server.baseUrl, "employee@test.eset.local"),
    guard: await authHeader(server.baseUrl, "guard@test.eset.local"),
    hr: await authHeader(server.baseUrl, "hr@test.eset.local"),
    otherSiteAdmin: await authHeader(server.baseUrl, "admin-othersite@test.eset.local"),
    otherSiteTeamLead: await authHeader(server.baseUrl, "teamlead-othersite@test.eset.local"),
  };
  const uoms = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: tokens.ceo,
  });
  UOM_ID = uoms.body.data[0].id;
  ctx = { baseUrl: server.baseUrl, tokens, close: server.close };

  chain = await buildApprovedIpo(ctx, {
    uomId: UOM_ID,
    quantities: [10, 5],
    prices: [ESTIMATED, "10.00"],
  });
  await recordPurchase(ctx, chain.ipoId, [
    {
      ipoLineId: chain.ipoLines[0].id,
      quantity: "10",
      actualUnitPrice: ACTUAL,
      procurementNote: PROCUREMENT_NOTE,
    },
  ]);
  const dc = await createFinalizedDc(ctx, chain.ipoId, [{ ipoLineId: chain.ipoLines[0].id, quantity: "10" }]);
  dcId = dc.dcId;
  const received = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/challans/${dcId}/receipts`, {
    token: tokens.teamLead,
    body: { operationId: randomUUID(), lines: [{ dcLineId: dc.lines[0].id, receivedQuantity: "10" }] },
  });
  receiptId = received.body.data.receipt.id;
});

after(async () => {
  await ctx.close();
});

// Every endpoint a price-blind but otherwise fully authorized department user
// can legitimately reach, plus the notification feed and the audit-bearing
// detail views. If a commercial value can escape anywhere, it escapes here.
function priceBlindSurfaces() {
  return [
    `/api/v1/demands/${chain.demandId}`,
    "/api/v1/demands?pageSize=100",
    `/api/v1/ipos/${chain.ipoId}`,
    "/api/v1/ipos?pageSize=100",
    `/api/v1/delivery-challans/${dcId}`,
    "/api/v1/delivery-challans?pageSize=100",
    `/api/v1/receiving/challans/${dcId}`,
    "/api/v1/receiving/challans?pageSize=100",
    `/api/v1/receiving/receipts/${receiptId}`,
    "/api/v1/receiving/receipts?pageSize=100",
    "/api/v1/notifications",
    `/api/v1/ipos/outstanding?catalogEntryIds=${"00000000-0000-0000-0000-000000000000"}`,
  ];
}

test("no commercial value reaches a fully authorized but price-blind department user", async () => {
  for (const path of priceBlindSurfaces()) {
    const response = await apiRequest(ctx.baseUrl, "GET", path, { token: ctx.tokens.teamLead });
    assert.ok([200, 403, 404].includes(response.status), `${path} returned ${response.status}`);

    if (response.status !== 200) continue;
    const body = JSON.stringify(response.body);
    assert.ok(!body.includes(ESTIMATED), `estimated price leaked through ${path}`);
    assert.ok(!body.includes(ACTUAL), `actual purchase price leaked through ${path}`);
    assert.ok(!body.includes(PROCUREMENT_NOTE), `internal Procurement note leaked through ${path}`);
    assert.ok(!/estimated_total|estimated_unit_price|actual_unit_price/.test(body), `a price column leaked through ${path}`);
  }
});

test("no commercial value reaches ADMIN, HR or the Gate Guard", async () => {
  for (const [label, token] of [
    ["admin", ctx.tokens.admin],
    ["hr", ctx.tokens.hr],
    ["guard", ctx.tokens.guard],
  ]) {
    for (const path of priceBlindSurfaces()) {
      const response = await apiRequest(ctx.baseUrl, "GET", path, { token });
      if (response.status !== 200) continue;
      const body = JSON.stringify(response.body);
      assert.ok(!body.includes(ESTIMATED), `estimated price leaked to ${label} through ${path}`);
      assert.ok(!body.includes(ACTUAL), `actual price leaked to ${label} through ${path}`);
      assert.ok(!body.includes(PROCUREMENT_NOTE), `Procurement note leaked to ${label} through ${path}`);
    }
  }
});

test("the Gate Guard gains no Procurement or Receiving surface whatsoever", async () => {
  const denied = [
    `/api/v1/ipos/${chain.ipoId}`,
    `/api/v1/ipos/${chain.ipoId}/pdf`,
    `/api/v1/delivery-challans/${dcId}`,
    `/api/v1/delivery-challans/${dcId}/pdf`,
    `/api/v1/receiving/receipts/${receiptId}`,
    "/api/v1/receiving/challans",
    "/api/v1/reports/procurement/catalog",
    "/api/v1/reports/procurement/ipo-history.xlsx",
    `/api/v1/procurement/pricing/${chain.demandId}`,
  ];

  for (const path of denied) {
    const response = await apiRequest(ctx.baseUrl, "GET", path, { token: ctx.tokens.guard });
    assert.equal(response.status, 403, `${path} should be forbidden for the Gate Guard`);
  }
});

test("every new mutating endpoint refuses an unauthenticated caller", async () => {
  const mutations = [
    ["POST", `/api/v1/ipos/${chain.ipoId}/acknowledge`],
    ["POST", `/api/v1/ipos/${chain.ipoId}/purchases`],
    ["POST", `/api/v1/ipos/${chain.ipoId}/close-purchasing`],
    ["POST", `/api/v1/ipos/${chain.ipoId}/cancel`],
    ["POST", "/api/v1/delivery-challans"],
    ["POST", `/api/v1/delivery-challans/${dcId}/finalize`],
    ["POST", `/api/v1/delivery-challans/${dcId}/cancel`],
    ["POST", `/api/v1/receiving/challans/${dcId}/receipts`],
    ["POST", `/api/v1/receiving/receipts/${receiptId}/handover`],
    ["POST", `/api/v1/receiving/receipts/${receiptId}/confirm`],
    ["PUT", `/api/v1/demands/${chain.demandId}/line-dispositions`],
  ];

  for (const [method, path] of mutations) {
    const response = await apiRequest(ctx.baseUrl, method, path, { body: {} });
    assert.equal(response.status, 401, `${method} ${path} must require authentication`);
  }
});

test("actor, department and site can never be forged through the request body", async () => {
  // A department user supplying another department's id gains nothing: the
  // server derives scope from the authenticated session, never from input.
  const otherDepartmentId = (
    await pool.query("SELECT department_id FROM users WHERE id = $1", [users.teamLeadOtherDept])
  ).rows[0].department_id;

  const forgedList = await apiRequest(
    ctx.baseUrl,
    "GET",
    `/api/v1/ipos?departmentId=${otherDepartmentId}`,
    { token: ctx.tokens.teamLead },
  );
  assert.equal(forgedList.status, 404);

  // The receipt records the authenticated actor, not any client-supplied one.
  const dcLines = await pool.query("SELECT id FROM delivery_challan_lines WHERE dc_id = $1 LIMIT 1", [dcId]);
  const forgedActor = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/challans/${dcId}/receipts`, {
    token: ctx.tokens.employee,
    body: { operationId: randomUUID(),
      receivedByUserId: users.ceo,
      departmentId: otherDepartmentId,
      siteId: users.otherSite,
      lines: [{ dcLineId: dcLines.rows[0].id, receivedQuantity: "0.01" }],
    },
  });
  // Unknown fields are rejected outright by the strict schema.
  assert.equal(forgedActor.status, 400);
});

test("supply-chain audit history is append-only for everyone, including Upper Management", async () => {
  const auditRow = await pool.query("SELECT id FROM procurement_audit_log WHERE ipo_id = $1 LIMIT 1", [
    chain.ipoId,
  ]);
  assert.ok(auditRow.rows[0]);

  // No API surface exists to mutate it...
  for (const method of ["PATCH", "DELETE", "PUT"]) {
    const response = await apiRequest(
      ctx.baseUrl,
      method,
      `/api/v1/ipos/${chain.ipoId}/audit/${auditRow.rows[0].id}`,
      { token: ctx.tokens.upperManagement, body: {} },
    );
    assert.ok([401, 403, 404, 405].includes(response.status));
  }

  // ...and the database refuses regardless of who asks.
  await assert.rejects(
    pool.query("UPDATE procurement_audit_log SET action = 'IPO_CANCELLED' WHERE id = $1", [auditRow.rows[0].id]),
    /append-only/i,
  );
  await assert.rejects(
    pool.query("DELETE FROM procurement_audit_log WHERE id = $1", [auditRow.rows[0].id]),
    /append-only/i,
  );
});

test("audit metadata records identifiers and quantities, never prices or internal notes", async () => {
  const rows = await pool.query(
    "SELECT action, metadata FROM procurement_audit_log WHERE ipo_id = $1",
    [chain.ipoId],
  );
  assert.ok(rows.rowCount > 0);

  for (const row of rows.rows) {
    const metadata = JSON.stringify(row.metadata || {});
    assert.ok(!metadata.includes(ESTIMATED), `${row.action} audit metadata leaked an estimated price`);
    assert.ok(!metadata.includes(ACTUAL), `${row.action} audit metadata leaked an actual price`);
    assert.ok(!metadata.includes(PROCUREMENT_NOTE), `${row.action} audit metadata leaked a Procurement note`);
  }

  // The same holds for the operational Demand audit stream.
  const demandAudit = await pool.query(
    "SELECT action, metadata FROM material_demand_audit_log WHERE demand_id = $1",
    [chain.demandId],
  );
  for (const row of demandAudit.rows) {
    const metadata = JSON.stringify(row.metadata || {});
    assert.ok(!metadata.includes(ESTIMATED), `${row.action} demand audit leaked an estimated price`);
    assert.ok(!metadata.includes(ACTUAL), `${row.action} demand audit leaked an actual price`);
  }
});

test("in-app notification payloads never carry commercial values", async () => {
  const rows = await pool.query(
    `SELECT event_type, payload FROM notification_outbox
     WHERE entity_id IN ($1, $2, $3)`,
    [chain.ipoId, dcId, receiptId],
  );
  assert.ok(rows.rowCount > 0);

  for (const row of rows.rows) {
    const payload = JSON.stringify(row.payload || {});
    assert.ok(!payload.includes(ESTIMATED), `${row.event_type} notification leaked an estimated price`);
    assert.ok(!payload.includes(ACTUAL), `${row.event_type} notification leaked an actual price`);
    assert.ok(!payload.includes(PROCUREMENT_NOTE), `${row.event_type} notification leaked a Procurement note`);
  }
});

test("cross-site direct-id access is refused on every new surface", async () => {
  const surfaces = [
    `/api/v1/ipos/${chain.ipoId}`,
    `/api/v1/delivery-challans/${dcId}`,
    `/api/v1/receiving/challans/${dcId}`,
    `/api/v1/receiving/receipts/${receiptId}`,
  ];

  for (const path of surfaces) {
    for (const token of [ctx.tokens.otherSiteAdmin, ctx.tokens.otherSiteTeamLead]) {
      const response = await apiRequest(ctx.baseUrl, "GET", path, { token });
      assert.ok([403, 404].includes(response.status), `${path} leaked across sites (${response.status})`);
    }
  }
});

test("a sensitive cancellation reason is withheld from an operational viewer", async () => {
  const cancelled = await buildApprovedIpo(ctx, { uomId: UOM_ID, quantities: [5], prices: ["10.00"] });
  const SENSITIVE = "Supplier raised the price from 10,000 to 18,000";

  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${cancelled.ipoId}/cancel`, {
      token: ctx.tokens.ceo,
      body: { category: "BUDGET_WITHDRAWN", reason: SENSITIVE },
    })).status,
    200,
  );

  // The operational viewer learns THAT it was cancelled and broadly why, but
  // not the commercial detail.
  const operational = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${cancelled.ipoId}`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(operational.status, 200);
  assert.equal(operational.body.data.ipo.cancellation_category, "BUDGET_WITHDRAWN");
  assert.equal(operational.body.data.ipo.cancellation_reason, null);
  assert.ok(!JSON.stringify(operational.body).includes("18,000"));

  // A commercially authorized viewer sees it.
  const management = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${cancelled.ipoId}`, {
    token: ctx.tokens.siteManager,
  });
  assert.equal(management.body.data.ipo.cancellation_reason, SENSITIVE);

  // And it never reaches the broadly-readable audit metadata or notifications.
  const audit = await pool.query(
    "SELECT metadata FROM procurement_audit_log WHERE ipo_id = $1 AND action = 'IPO_CANCELLED'",
    [cancelled.ipoId],
  );
  assert.equal(audit.rows[0].metadata.category, "BUDGET_WITHDRAWN");
  assert.ok(!JSON.stringify(audit.rows[0].metadata).includes("18,000"));

  const notifications = await pool.query(
    "SELECT payload FROM notification_outbox WHERE entity_id = $1 AND event_type = 'IPO_CANCELLED'",
    [cancelled.ipoId],
  );
  for (const row of notifications.rows) {
    assert.ok(!JSON.stringify(row.payload).includes("18,000"));
  }
});

test("site coherence is enforced by the database, not merely by the service", async () => {
  const otherSite = (await pool.query("SELECT id FROM sites WHERE code = 'TEST-SECONDARY'")).rows[0].id;

  // An IPO cannot claim a site other than its Demand's.
  await assert.rejects(
    pool.query("UPDATE ipos SET site_id = $2 WHERE id = $1", [chain.ipoId, otherSite]),
    /immutable|violates foreign key/i,
  );

  // A Delivery Challan cannot claim a site other than its IPO's.
  await assert.rejects(
    pool.query("UPDATE delivery_challans SET site_id = $2 WHERE id = $1", [dcId, otherSite]),
    /immutable|violates foreign key/i,
  );

  // A receipt cannot claim a site other than its challan's.
  await assert.rejects(
    pool.query("UPDATE material_receipts SET site_id = $2 WHERE id = $1", [receiptId, otherSite]),
    /immutable|violates foreign key/i,
  );
});

test("completed receiving custody and confirmation cannot be rewritten", async () => {
  await pool.query("UPDATE material_receipts SET status = status WHERE id = $1", [receiptId]);

  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/confirm`, {
      token: ctx.tokens.teamLead,
    })).status,
    200,
  );

  await assert.rejects(
    pool.query("UPDATE material_receipts SET confirmed_by_user_id = $2 WHERE id = $1", [receiptId, users.ceo]),
    /completed confirmation cannot be rewritten/,
  );
  await assert.rejects(
    pool.query("UPDATE material_receipts SET confirmed_at = now() WHERE id = $1", [receiptId]),
    /completed confirmation cannot be rewritten/,
  );
  await assert.rejects(
    pool.query("UPDATE material_receipts SET received_by_user_id = $2 WHERE id = $1", [receiptId, users.ceo]),
    /original receipt record is immutable/,
  );
  await assert.rejects(
    pool.query("DELETE FROM material_receipts WHERE id = $1", [receiptId]),
    /cannot be deleted/,
  );
});
