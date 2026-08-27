import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import {
  assertSupplyChainRecordVisible,
  resolveSupplyChainScope,
} from "../src/shared/authorization/supply-chain-scope.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import {
  buildApprovedIpo,
  clearOverride,
  createFinalizedDc,
  recordPurchase,
  setOverride,
} from "./procurement-chain-helpers.js";

// `procurement.view_prices` answers "may this actor see protected pricing
// FIELDS on records they can already reach?". It must never answer "which
// departments may this actor reach?" — granting a department user price
// visibility for a legitimate reason must not hand them every other
// department's purchasing records at their site.
//
// The whole purchasing chain shares one scope resolver, so the unit-level
// assertions below are the comprehensive proof and the HTTP assertions prove
// the defect cannot survive through a real route either.

let ctx;
let users;
let chain;
let dcId;

function actorWith(permissions, overrides = {}) {
  return {
    id: "actor-1",
    role: "TEAM_LEAD",
    siteId: "site-a",
    departmentId: "civil",
    permissions: new Set(permissions),
    ...overrides,
  };
}

before(async () => {
  const server = await startTestServer();
  users = await seedUsers();
  const tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    upperManagement: await authHeader(server.baseUrl, "um@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    teamLeadOtherDept: await authHeader(server.baseUrl, "teamlead2@test.eset.local"),
  };
  const uoms = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: tokens.ceo,
  });
  ctx = { baseUrl: server.baseUrl, tokens, close: server.close };

  // A complete chain owned by department A (the Team Lead's own department).
  chain = await buildApprovedIpo(ctx, { uomId: uoms.body.data[0].id, quantities: [10], prices: ["1234.50"] });
  await recordPurchase(ctx, chain.ipoId, [
    { ipoLineId: chain.ipoLines[0].id, quantity: "10", actualUnitPrice: "1111.25" },
  ]);
  const dc = await createFinalizedDc(ctx, chain.ipoId, [{ ipoLineId: chain.ipoLines[0].id, quantity: "10" }]);
  dcId = dc.dcId;
});

after(async () => {
  await ctx.close();
});

test("price visibility alone never elevates a department actor beyond their own department", () => {
  const withoutGrant = actorWith(["demand.view", "ipo.view", "dc.view", "receiving.view"]);
  const withGrant = actorWith(["demand.view", "ipo.view", "dc.view", "receiving.view", "procurement.view_prices"]);

  // The grant changes nothing about SCOPE.
  assert.deepEqual(resolveSupplyChainScope(withGrant), resolveSupplyChainScope(withoutGrant));
  assert.equal(resolveSupplyChainScope(withGrant).tier, "OWN");
  assert.equal(resolveSupplyChainScope(withGrant).departmentId, "civil");

  // Nor about which records are reachable: a sibling department at the very
  // same site stays out of reach.
  assert.throws(
    () => assertSupplyChainRecordVisible(withGrant, { site_id: "site-a", department_id: "wtg" }),
    /not found/i,
  );
  assert.throws(
    () => assertSupplyChainRecordVisible(withGrant, { site_id: "site-b", department_id: "civil" }),
    /not found/i,
  );
  // Their own department's record remains reachable.
  assertSupplyChainRecordVisible(withGrant, { site_id: "site-a", department_id: "civil" });
});

test("genuine cross-department responsibility still grants site scope", () => {
  // Each of these is an authority to ACT on other departments' records, which
  // is what legitimately earns site-wide reach.
  for (const capability of [
    "procurement.pricing",
    "procurement.purchase",
    "dc.manage",
    "demand.review",
    "demand.approve",
  ]) {
    assert.equal(
      resolveSupplyChainScope(actorWith([capability])).tier,
      "SITE",
      `${capability} must still grant site scope`,
    );
  }

  // CEO and an explicit all-departments grant still reach every site.
  assert.equal(resolveSupplyChainScope(actorWith([], { role: "CEO" })).tier, "ALL");
  assert.equal(resolveSupplyChainScope(actorWith(["demand.all_departments"])).tier, "ALL");

  // The previous corrective fix is not regressed: fallback custody is still
  // not a generic scope tier.
  assert.equal(resolveSupplyChainScope(actorWith(["receiving.fallback_receive"])).tier, "OWN");
});

test("a price-granted department user cannot reach another department through any chain surface", async () => {
  // The other department's Team Lead gets price visibility and nothing else.
  await setOverride(users.teamLeadOtherDept, "procurement.view_prices", "GRANT", users.ceo);
  try {
    const token = ctx.tokens.teamLeadOtherDept;

    // Direct detail access — IPO, Delivery Challan, receiving.
    for (const path of [
      `/api/v1/ipos/${chain.ipoId}`,
      `/api/v1/ipos/${chain.ipoId}/pdf`,
      `/api/v1/delivery-challans/${dcId}`,
      `/api/v1/receiving/challans/${dcId}`,
    ]) {
      const response = await apiRequest(ctx.baseUrl, "GET", path, { token });
      assert.ok(
        [403, 404].includes(response.status),
        `${path} was reachable (${response.status}) with price visibility alone`,
      );
    }

    // Enumeration — the record must not appear in any list either.
    for (const path of [
      "/api/v1/ipos?pageSize=100",
      "/api/v1/delivery-challans?pageSize=100",
      "/api/v1/receiving/challans?pageSize=100",
      "/api/v1/receiving/receipts?pageSize=100",
    ]) {
      const response = await apiRequest(ctx.baseUrl, "GET", path, { token });
      if (response.status !== 200) continue;
      assert.ok(
        !response.body.data.some((row) => row.id === chain.ipoId || row.id === dcId),
        `${path} enumerated another department's record`,
      );
    }

    // Reports reuse the same resolver: the export must not carry the other
    // department's rows, and must certainly not carry its prices.
    await setOverride(users.teamLeadOtherDept, "procurement.export", "GRANT", users.ceo);
    const exportResponse = await fetch(
      `${ctx.baseUrl}/api/v1/reports/procurement/ipo-history.xlsx`,
      { headers: { Origin: "http://localhost:5173", Cookie: token } },
    );
    if (exportResponse.status === 200) {
      const text = Buffer.from(await exportResponse.arrayBuffer()).toString("latin1");
      assert.ok(!text.includes(chain.ipoNumber), "the export leaked another department's IPO");
      assert.ok(!text.includes("1234.50"), "the export leaked another department's estimated price");
      assert.ok(!text.includes("1111.25"), "the export leaked another department's actual price");
    }

    // Carry-forward reuses it too.
    const carryForward = await apiRequest(
      ctx.baseUrl,
      "GET",
      `/api/v1/ipos/outstanding?catalogEntryIds=${randomUUID()}`,
      { token },
    );
    assert.ok(carryForward.status !== 200 || carryForward.body.data.length === 0);
  } finally {
    await clearOverride(users.teamLeadOtherDept, "procurement.view_prices");
    await clearOverride(users.teamLeadOtherDept, "procurement.export");
  }
});

test("the owning department still sees its own record, with prices once granted", async () => {
  // Without the grant: the record is reachable, the prices are not.
  const blind = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${chain.ipoId}`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(blind.status, 200, "the owning department reaches its own IPO");
  assert.equal(blind.body.data.includesCommercialData, false);
  assert.ok(!JSON.stringify(blind.body).includes("1234.50"));
  assert.ok(!JSON.stringify(blind.body).includes("1111.25"));

  // With the grant: the same record, now with its prices — field visibility,
  // exactly as intended, and still only within their own department.
  await setOverride(users.teamLead, "procurement.view_prices", "GRANT", users.ceo);
  try {
    const granted = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${chain.ipoId}`, {
      token: ctx.tokens.teamLead,
    });
    assert.equal(granted.status, 200);
    assert.equal(granted.body.data.includesCommercialData, true);
    assert.equal(granted.body.data.lines[0].estimated_unit_price, "1234.50");
    assert.equal(granted.body.data.lines[0].actual_unit_price, "1111.25");
  } finally {
    await clearOverride(users.teamLead, "procurement.view_prices");
  }
});

test("legitimate management keeps its site-wide reach and its price visibility", async () => {
  // SITE_MANAGER and UPPER_MANAGEMENT hold demand.review by role, so their
  // scope comes from real review authority — not from price visibility.
  for (const [label, token] of [
    ["site manager", ctx.tokens.siteManager],
    ["upper management", ctx.tokens.upperManagement],
  ]) {
    const response = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${chain.ipoId}`, { token });
    assert.equal(response.status, 200, `${label} lost access to a cross-department record at their site`);
  }

  // SITE_MANAGER also holds procurement.view_prices by role, so prices remain
  // visible to them.
  const managerView = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${chain.ipoId}`, {
    token: ctx.tokens.siteManager,
  });
  assert.equal(managerView.body.data.includesCommercialData, true);
  assert.equal(managerView.body.data.lines[0].actual_unit_price, "1111.25");
});

test("an explicit price DENY removes prices without removing operational scope", async () => {
  await setOverride(users.siteManager, "procurement.view_prices", "DENY", users.ceo);
  try {
    const response = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${chain.ipoId}`, {
      token: ctx.tokens.siteManager,
    });
    // Scope comes from demand.review, so the record is still reachable...
    assert.equal(response.status, 200);
    // ...but every commercial field is gone.
    assert.equal(response.body.data.includesCommercialData, false);
    const serialized = JSON.stringify(response.body);
    assert.ok(!serialized.includes("1234.50"));
    assert.ok(!serialized.includes("1111.25"));

    // And the priced document is refused outright.
    const pdf = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${chain.ipoId}/pdf`, {
      token: ctx.tokens.siteManager,
    });
    assert.equal(pdf.status, 403);
  } finally {
    await clearOverride(users.siteManager, "procurement.view_prices");
  }
});
