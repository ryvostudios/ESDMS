import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { buildApprovedIpo, clearOverride, setOverride } from "./procurement-chain-helpers.js";

// `procurement.view_prices` says whether an actor may see commercial FIELDS on
// a record they can already reach. It must never decide WHICH records they can
// reach. The pricing detail route accepts it as sufficient authority, so if the
// service does not re-resolve record scope, a department user granted price
// visibility can read every other department's prices by demand id — which is
// exactly what a live production test found.

let ctx;
let users;
let civil;

before(async () => {
  const server = await startTestServer();
  users = await seedUsers();
  const tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    teamLeadOtherDept: await authHeader(server.baseUrl, "teamlead2@test.eset.local"),
    otherSiteTeamLead: await authHeader(server.baseUrl, "teamlead-othersite@test.eset.local"),
  };
  const uoms = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: tokens.ceo,
  });
  ctx = { baseUrl: server.baseUrl, tokens, close: server.close };
  // A fully priced Demand owned by departmentA ("Civil" in this fixture).
  civil = await buildApprovedIpo(ctx, {
    uomId: uoms.body.data[0].id,
    quantities: [12],
    prices: ["987.65"],
  });
});

after(async () => {
  if (ctx) await ctx.close();
});

const pricing = (token, demandId) =>
  apiRequest(ctx.baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, { token });

test("1+2 — a price-view-only Team Lead reads their OWN department's pricing but not another department's", async () => {
  await setOverride(users.teamLeadOtherDept, "procurement.view_prices", "GRANT", users.ceo);
  try {
    const token = await authHeader(ctx.baseUrl, "teamlead2@test.eset.local");

    // The defect: same site, different department, price visibility only.
    const foreign = await pricing(token, civil.demandId);
    assert.equal(foreign.status, 404, "another department's pricing detail was readable");

    // Its own department's pricing stays reachable — the fix must not
    // over-correct into denying legitimate same-department access.
    const own = await buildApprovedIpo(ctx, {
      uomId: (await apiRequest(ctx.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
        token: ctx.tokens.ceo,
      })).body.data[0].id,
      quantities: [5],
      prices: ["10.00"],
      creatorToken: token,
    });
    const mine = await pricing(token, own.demandId);
    assert.equal(mine.status, 200, "own-department pricing detail must remain readable");
    assert.ok(mine.body.data.lines.some((l) => l.estimated_unit_price === "10.00"));
  } finally {
    await clearOverride(users.teamLeadOtherDept, "procurement.view_prices");
  }
});

test("3+4 — the same actor still cannot reach the foreign Demand, IPO, DC or receipt", async () => {
  await setOverride(users.teamLeadOtherDept, "procurement.view_prices", "GRANT", users.ceo);
  try {
    const token = await authHeader(ctx.baseUrl, "teamlead2@test.eset.local");
    assert.equal((await apiRequest(ctx.baseUrl, "GET", `/api/v1/demands/${civil.demandId}`, { token })).status, 404);
    assert.equal((await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${civil.ipoId}`, { token })).status, 404);
    assert.equal(
      (await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${civil.ipoId}/pdf`, { token })).status,
      404,
    );
  } finally {
    await clearOverride(users.teamLeadOtherDept, "procurement.view_prices");
  }
});

test("5 — without price visibility the route is refused on capability, before scope", async () => {
  const token = await authHeader(ctx.baseUrl, "teamlead2@test.eset.local");
  const response = await pricing(token, civil.demandId);
  assert.equal(response.status, 403, "no price capability must be a capability refusal");
});

test("6 — demand.review + view_prices keeps cross-department access at its own site", async () => {
  // The site-tier reviewer is exactly who needs foreign-department pricing to
  // review it; the fix must not touch them.
  const response = await pricing(ctx.tokens.siteManager, civil.demandId);
  assert.equal(response.status, 200);
  assert.ok(response.body.data.lines.some((l) => l.estimated_unit_price === "987.65"));
});

test("7 — demand.approve + view_prices keeps same-site access", async () => {
  // A formal approver built from scratch on a department-scoped user: price
  // visibility plus demand.approve and nothing else. demand.approve is a
  // genuine site-wide supply-chain authority, so this actor must still reach
  // another department's pricing at the same site — that is the access the
  // formal gate depends on.
  await setOverride(users.teamLeadOtherDept, "procurement.view_prices", "GRANT", users.ceo);
  await setOverride(users.teamLeadOtherDept, "demand.approve", "GRANT", users.ceo);
  try {
    const token = await authHeader(ctx.baseUrl, "teamlead2@test.eset.local");
    const response = await pricing(token, civil.demandId);
    assert.equal(response.status, 200, "a formal approver lost cross-department pricing access");
    assert.ok(response.body.data.lines.some((l) => l.estimated_unit_price === "987.65"));
  } finally {
    await clearOverride(users.teamLeadOtherDept, "demand.approve");
    await clearOverride(users.teamLeadOtherDept, "procurement.view_prices");
  }
});

test("8+9 — procurement.pricing and CEO scope behaviour are preserved", async () => {
  assert.equal((await pricing(ctx.tokens.ceo, civil.demandId)).status, 200);
  // The Procurement actor in this fixture reaches pricing through
  // procurement.pricing, which is a site-wide action capability.
  const queue = await apiRequest(ctx.baseUrl, "GET", "/api/v1/procurement/pricing", {
    token: ctx.tokens.ceo,
  });
  assert.equal(queue.status, 200, "the pricing list must be unchanged");
});

test("10 — a different site is denied even with price visibility", async () => {
  await setOverride(users.otherSiteTeamLead, "procurement.view_prices", "GRANT", users.ceo);
  try {
    const token = await authHeader(ctx.baseUrl, "teamlead-othersite@test.eset.local");
    assert.equal((await pricing(token, civil.demandId)).status, 404);
  } finally {
    await clearOverride(users.otherSiteTeamLead, "procurement.view_prices");
  }
});

test("11+13 — the out-of-scope response is generic and leaks no commercial metadata", async () => {
  await setOverride(users.teamLeadOtherDept, "procurement.view_prices", "GRANT", users.ceo);
  try {
    const token = await authHeader(ctx.baseUrl, "teamlead2@test.eset.local");
    const response = await pricing(token, civil.demandId);
    assert.equal(response.status, 404);
    const body = JSON.stringify(response.body);
    for (const secret of ["987.65", "11851.80", civil.demandNumber, "Civil", "department", "site"]) {
      if (secret) assert.ok(!body.includes(secret), `the 404 leaked ${secret}`);
    }
    assert.match(response.body.error.message, /not found/i);
  } finally {
    await clearOverride(users.teamLeadOtherDept, "procurement.view_prices");
  }
});
