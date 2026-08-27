import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { buildApprovedIpo, recordPurchase } from "./procurement-chain-helpers.js";

// An operation id makes a request idempotent — but only against the same
// parent. Reusing one under a different IPO is a client bug, not a replay, and
// answering it with the other IPO's challan would report a shipment as cut
// that never was.

let ctx;
let users;
let uomId;

before(async () => {
  const server = await startTestServer();
  users = await seedUsers();
  const tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    teamLeadOtherDept: await authHeader(server.baseUrl, "teamlead2@test.eset.local"),
    otherSiteAdmin: await authHeader(server.baseUrl, "admin-othersite@test.eset.local"),
  };
  const uoms = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: tokens.ceo,
  });
  uomId = uoms.body.data[0].id;
  ctx = { baseUrl: server.baseUrl, tokens, close: server.close };
});

after(async () => {
  await ctx.close();
});

// An IPO with `purchased` units available to put on a challan.
async function purchasedIpo(purchased = "100") {
  const built = await buildApprovedIpo(ctx, { uomId, quantities: [100] });
  assert.equal(
    (await recordPurchase(ctx, built.ipoId, [
      { ipoLineId: built.ipoLines[0].id, quantity: purchased, actualUnitPrice: "10.00" },
    ])).status,
    200,
  );
  return built;
}

const createDc = (ipo, quantity, operationId, token) =>
  apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
    token: token || ctx.tokens.ceo,
    body: {
      operationId,
      ipoId: ipo.ipoId,
      lines: [{ ipoLineId: ipo.ipoLines[0].id, quantity }],
    },
  });

const allocatedOn = async (ipoId) =>
  (
    await pool.query(
      `SELECT COALESCE(SUM(dcl.quantity), 0)::numeric(12,2) AS total
       FROM delivery_challan_lines dcl
       JOIN delivery_challans dc ON dc.id = dcl.dc_id
       WHERE dcl.ipo_id = $1 AND dc.status <> 'CANCELLED'`,
      [ipoId],
    )
  ).rows[0].total;

const challanCountOn = async (ipoId) =>
  (await pool.query("SELECT count(*)::int AS n FROM delivery_challans WHERE ipo_id = $1", [ipoId])).rows[0].n;

test("A — an exact replay returns the same challan and the same number", async () => {
  const ipo = await purchasedIpo("60");
  const operationId = randomUUID();

  const first = await createDc(ipo, "20", operationId);
  assert.equal(first.status, 201);
  const dcId = first.body.data.deliveryChallan.id;
  const dcNumber = first.body.data.deliveryChallan.dc_number;

  const replay = await createDc(ipo, "20", operationId);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.data.deliveryChallan.id, dcId);
  assert.equal(replay.body.data.deliveryChallan.dc_number, dcNumber);

  assert.equal(await challanCountOn(ipo.ipoId), 1, "no second challan, no second number");
  assert.equal(await allocatedOn(ipo.ipoId), "20.00", "the replay allocated nothing further");
});

test("B — reusing an operation id under a different IPO is refused", async () => {
  const a = await purchasedIpo("60");
  const b = await purchasedIpo("100");
  const operationId = randomUUID();

  const owned = await createDc(a, "20", operationId);
  assert.equal(owned.status, 201);
  const ownedDcId = owned.body.data.deliveryChallan.id;

  const crossParent = await createDc(b, "30", operationId);
  assert.equal(crossParent.status, 409, "an id owned by another IPO must not be treated as a replay");
  assert.notEqual(crossParent.body?.data?.deliveryChallan?.id, ownedDcId);

  // The message names nothing about the other request.
  const message = crossParent.body.error.message;
  assert.match(message, /already been used/i);
  assert.ok(!message.includes(a.ipoNumber), "the conflict named the owning IPO");
  assert.ok(!message.includes(ownedDcId), "the conflict named the owning challan");
});

test("C — a refused cross-IPO reuse allocates nothing on the requested IPO", async () => {
  const a = await purchasedIpo("60");
  const b = await purchasedIpo("100");
  const operationId = randomUUID();

  assert.equal((await createDc(a, "20", operationId)).status, 201);

  const before = await allocatedOn(b.ipoId);
  assert.equal((await createDc(b, "30", operationId)).status, 409);

  assert.equal(await allocatedOn(b.ipoId), before, "the losing IPO's purchased quantity was touched");
  assert.equal(await challanCountOn(b.ipoId), 0, "a challan was created on the losing IPO");
  // The owning IPO is likewise untouched by the failed attempt.
  assert.equal(await allocatedOn(a.ipoId), "20.00");
  assert.equal(await challanCountOn(a.ipoId), 1);
});

test("D+E — neither a replay nor a refused reuse produces duplicate side effects", async () => {
  const a = await purchasedIpo("60");
  const b = await purchasedIpo("100");
  const operationId = randomUUID();

  const created = await createDc(a, "20", operationId);
  const dcId = created.body.data.deliveryChallan.id;

  const countAudit = async (entityId) =>
    (
      await pool.query(
        "SELECT count(*)::int AS n FROM procurement_audit_log WHERE entity_id = $1 AND action = 'DC_CREATED'",
        [entityId],
      )
    ).rows[0].n;
  const countOutboxFor = async (ipoId) =>
    (
      await pool.query(
        `SELECT count(*)::int AS n FROM notification_outbox o
         JOIN delivery_challans dc ON dc.id = o.entity_id
         WHERE dc.ipo_id = $1`,
        [ipoId],
      )
    ).rows[0].n;

  assert.equal(await countAudit(dcId), 1);
  const outboxBefore = await countOutboxFor(a.ipoId);

  // Exact replay — nothing actually happened, so nothing is recorded again.
  assert.equal((await createDc(a, "20", operationId)).status, 201);
  assert.equal(await countAudit(dcId), 1, "the replay wrote a second DC_CREATED audit row");
  assert.equal(await countOutboxFor(a.ipoId), outboxBefore, "the replay produced a second outbox entry");

  // Refused cross-IPO reuse — no audit, no document job, no outbox anywhere.
  assert.equal((await createDc(b, "30", operationId)).status, 409);
  assert.equal(await countAudit(dcId), 1);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM procurement_audit_log WHERE ipo_id = $1", [b.ipoId]))
      .rows[0].n,
    (await pool.query("SELECT count(*)::int AS n FROM procurement_audit_log WHERE ipo_id = $1 AND action <> 'DC_CREATED'", [b.ipoId]))
      .rows[0].n,
    "a DC_CREATED audit row appeared on the losing IPO",
  );
  assert.equal(await countOutboxFor(b.ipoId), 0);
});

test("F — two concurrent exact replays still produce exactly one challan", async () => {
  const ipo = await purchasedIpo("60");
  const operationId = randomUUID();

  const results = await Promise.all([
    createDc(ipo, "20", operationId),
    createDc(ipo, "20", operationId),
  ]);
  assert.ok(results.every((r) => [201, 409].includes(r.status)));

  assert.equal(await challanCountOn(ipo.ipoId), 1);
  assert.equal(await allocatedOn(ipo.ipoId), "20.00");
});

test("G — a concurrent cross-IPO collision leaves at most one winner", async () => {
  const a = await purchasedIpo("60");
  const b = await purchasedIpo("100");
  const operationId = randomUUID();

  const [forA, forB] = await Promise.all([
    createDc(a, "20", operationId),
    createDc(b, "30", operationId),
  ]);

  const winners = [forA, forB].filter((r) => r.status === 201);
  assert.equal(winners.length, 1, "an operation id can only ever own one challan");

  const total = (await challanCountOn(a.ipoId)) + (await challanCountOn(b.ipoId));
  assert.equal(total, 1, "one challan in total across both IPOs");

  // Whichever lost has no allocation and no challan of its own.
  const loserIsB = forA.status === 201;
  assert.equal(await allocatedOn(loserIsB ? b.ipoId : a.ipoId), "0.00");
  assert.equal(await challanCountOn(loserIsB ? b.ipoId : a.ipoId), 0);

  // And no row is somehow linked to both.
  const owned = await pool.query("SELECT ipo_id FROM delivery_challans WHERE operation_id = $1", [operationId]);
  assert.equal(owned.rowCount, 1);
  assert.ok([a.ipoId, b.ipoId].includes(owned.rows[0].ipo_id));
});

test("H — an operation id is not a way to reach another department's or site's challan", async () => {
  const a = await purchasedIpo("60");
  const operationId = randomUUID();
  const created = await createDc(a, "20", operationId);
  assert.equal(created.status, 201);
  const dcNumber = created.body.data.deliveryChallan.dc_number;

  // dc.manage is still required; the operation id is no capability bypass.
  for (const token of [ctx.tokens.teamLead, ctx.tokens.teamLeadOtherDept, ctx.tokens.admin, ctx.tokens.siteManager]) {
    const response = await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
      token,
      body: { operationId, ipoId: a.ipoId, lines: [{ ipoLineId: a.ipoLines[0].id, quantity: "20" }] },
    });
    assert.equal(response.status, 403);
  }

  // A dc.manage holder at another site cannot use the id to learn anything:
  // the IPO itself is out of scope, so the request dies before replay.
  const otherSite = await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
    token: ctx.tokens.otherSiteAdmin,
    body: { operationId, ipoId: a.ipoId, lines: [{ ipoLineId: a.ipoLines[0].id, quantity: "20" }] },
  });
  assert.ok([403, 404].includes(otherSite.status));
  assert.ok(!JSON.stringify(otherSite.body).includes(dcNumber), "the challan number leaked out of scope");

  assert.equal(await challanCountOn(a.ipoId), 1);
});
