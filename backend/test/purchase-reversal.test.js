import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { buildApprovedIpo, createFinalizedDc, recordPurchase } from "./procurement-chain-helpers.js";

// A correction is not a new purchase at a price of the buyer's choosing. It
// withdraws part of ONE specific earlier purchase, at that purchase's price.
// Everything below exists to make the alternative impossible.

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
    guard: await authHeader(server.baseUrl, "guard@test.eset.local"),
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

const chain = (options = {}) => buildApprovedIpo(ctx, { uomId, ...options });

const purchase = (ipoId, ipoLineId, quantity, actualUnitPrice) =>
  recordPurchase(ctx, ipoId, [{ ipoLineId, quantity, actualUnitPrice }]);

const reverse = (ipoId, ipoLineId, quantity, reversesPurchaseEventId, operationId) =>
  recordPurchase(
    ctx,
    ipoId,
    [{ ipoLineId, quantity, reversesPurchaseEventId, reason: "wrong quantity entered" }],
    undefined,
    operationId,
  );

async function eventsFor(ipoLineId) {
  const result = await pool.query(
    `SELECT quantity, actual_unit_price, reverses_purchase_event_id, procurement_note
     FROM ipo_purchase_events WHERE ipo_line_id = $1 ORDER BY purchased_at ASC, id ASC`,
    [ipoLineId],
  );
  return result.rows;
}

async function totalsFor(ipoLineId) {
  const result = await pool.query(
    `SELECT COALESCE(SUM(quantity), 0)::numeric(12,2) AS quantity,
            COALESCE(SUM(quantity * actual_unit_price), 0)::numeric(26,2) AS value
     FROM ipo_purchase_events WHERE ipo_line_id = $1`,
    [ipoLineId],
  );
  return result.rows[0];
}

async function firstEventId(ipoLineId) {
  const result = await pool.query(
    "SELECT id FROM ipo_purchase_events WHERE ipo_line_id = $1 ORDER BY purchased_at ASC, id ASC LIMIT 1",
    [ipoLineId],
  );
  return result.rows[0].id;
}

test("a reversal must name the purchase it reverses, and may not invent a price", async () => {
  const { ipoId, ipoLines } = await chain();
  assert.equal((await purchase(ipoId, ipoLines[0].id, "60", "100.00")).status, 200);

  // The original defect: a free-standing negative event at an arbitrary price.
  const bogus = await recordPurchase(ctx, ipoId, [
    { ipoLineId: ipoLines[0].id, quantity: "-60", actualUnitPrice: "1.00" },
  ]);
  assert.equal(bogus.status, 400, "an unlinked negative event is not a purchase");

  // Naming the original but still trying to dictate the price is refused by
  // the contract itself — the field does not exist on a reversal.
  const pricedReversal = await recordPurchase(ctx, ipoId, [
    {
      ipoLineId: ipoLines[0].id,
      quantity: "-60",
      reversesPurchaseEventId: await firstEventId(ipoLines[0].id),
      reason: "duplicate",
      actualUnitPrice: "1.00",
    },
  ]);
  assert.equal(pricedReversal.status, 400);

  // A correction without a reason is not an audit trail.
  const noReason = await recordPurchase(ctx, ipoId, [
    {
      ipoLineId: ipoLines[0].id,
      quantity: "-10",
      reversesPurchaseEventId: await firstEventId(ipoLines[0].id),
    },
  ]);
  assert.equal(noReason.status, 400);

  // Nothing was recorded by any of the refused attempts.
  assert.deepEqual(await totalsFor(ipoLines[0].id), { quantity: "60.00", value: "6000.00" });
});

test("a reversal inherits the original price, so a fully reversed purchase nets to zero", async () => {
  const { ipoId, ipoLines } = await chain();
  await purchase(ipoId, ipoLines[0].id, "60", "100.00");
  const originalId = await firstEventId(ipoLines[0].id);

  assert.equal((await reverse(ipoId, ipoLines[0].id, "-60", originalId)).status, 200);

  const events = await eventsFor(ipoLines[0].id);
  assert.deepEqual(
    events.map((e) => [e.quantity, e.actual_unit_price]),
    [["60.00", "100.00"], ["-60.00", "100.00"]],
    "the reversal carries the original's price, not one of its own",
  );
  assert.equal(events[1].reverses_purchase_event_id, originalId);
  assert.equal(events[1].procurement_note, "wrong quantity entered");

  // The defect's signature number was 5,940. It must be exactly zero.
  assert.deepEqual(await totalsFor(ipoLines[0].id), { quantity: "0.00", value: "0.00" });

  // The original row is preserved, never rewritten to +0.
  assert.equal(events[0].quantity, "60.00");
});

test("a partial reversal leaves the remainder intact and exact", async () => {
  const { ipoId, ipoLines } = await chain();
  await purchase(ipoId, ipoLines[0].id, "60", "100.00");
  const originalId = await firstEventId(ipoLines[0].id);

  assert.equal((await reverse(ipoId, ipoLines[0].id, "-20", originalId)).status, 200);

  // Net 40 @ 100 = 4,000, from two preserved rows rather than a rewritten one.
  assert.deepEqual(await totalsFor(ipoLines[0].id), { quantity: "40.00", value: "4000.00" });
  const events = await eventsFor(ipoLines[0].id);
  assert.equal(events.length, 2);
  assert.equal(events[0].quantity, "60.00");

  const line = await pool.query(
    "SELECT purchased_quantity, purchase_status FROM ipo_lines WHERE id = $1",
    [ipoLines[0].id],
  );
  assert.equal(line.rows[0].purchased_quantity, "40.00");
  assert.equal(line.rows[0].purchase_status, "PARTIALLY_PURCHASED");
});

test("reversals can never exceed the purchase they reverse", async () => {
  const { ipoId, ipoLines } = await chain();
  await purchase(ipoId, ipoLines[0].id, "60", "100.00");
  const originalId = await firstEventId(ipoLines[0].id);

  assert.equal((await reverse(ipoId, ipoLines[0].id, "-70", originalId)).status, 409);

  assert.equal((await reverse(ipoId, ipoLines[0].id, "-20", originalId)).status, 200);
  assert.equal((await reverse(ipoId, ipoLines[0].id, "-30", originalId)).status, 200);
  // 50 of 60 reversed; 10 remain reversible.
  assert.equal((await reverse(ipoId, ipoLines[0].id, "-11", originalId)).status, 409);
  assert.equal((await reverse(ipoId, ipoLines[0].id, "-10", originalId)).status, 200);
  assert.equal((await reverse(ipoId, ipoLines[0].id, "-1", originalId)).status, 409);

  assert.deepEqual(await totalsFor(ipoLines[0].id), { quantity: "0.00", value: "0.00" });

  // The database refuses the same over-reversal independently of the service.
  await assert.rejects(
    pool.query(
      `INSERT INTO ipo_purchase_events
         (ipo_id, ipo_line_id, quantity, actual_unit_price, procurement_note,
          purchased_by_user_id, operation_id, reverses_purchase_event_id)
       VALUES ($1, $2, -5, 100.00, 'direct', $3, $4, $5)`,
      [ipoId, ipoLines[0].id, users.ceo, randomUUID(), originalId],
    ),
    /exceeds the .* originally purchased/,
  );

  // And refuses a reversal that tries to carry a different price.
  const fresh = await chain();
  await purchase(fresh.ipoId, fresh.ipoLines[0].id, "10", "100.00");
  const freshOriginal = await firstEventId(fresh.ipoLines[0].id);
  await assert.rejects(
    pool.query(
      `INSERT INTO ipo_purchase_events
         (ipo_id, ipo_line_id, quantity, actual_unit_price, procurement_note,
          purchased_by_user_id, operation_id, reverses_purchase_event_id)
       VALUES ($1, $2, -10, 1.00, 'direct', $3, $4, $5)`,
      [fresh.ipoId, fresh.ipoLines[0].id, users.ceo, randomUUID(), freshOriginal],
    ),
    /must carry the price of the purchase it reverses/,
  );
});

test("two concurrent reversals cannot both take the last reversible quantity", async () => {
  const { ipoId, ipoLines } = await chain();
  await purchase(ipoId, ipoLines[0].id, "60", "100.00");
  const originalId = await firstEventId(ipoLines[0].id);
  assert.equal((await reverse(ipoId, ipoLines[0].id, "-50", originalId)).status, 200);

  // 10 remain. Two independent corrections of 8 each arrive together.
  const [a, b] = await Promise.all([
    reverse(ipoId, ipoLines[0].id, "-8", originalId),
    reverse(ipoId, ipoLines[0].id, "-8", originalId),
  ]);
  assert.equal([a, b].filter((r) => r.status === 200).length, 1, "8 + 8 cannot come out of 10");

  const reversed = await pool.query(
    "SELECT COALESCE(SUM(-quantity), 0)::numeric(12,2) AS total FROM ipo_purchase_events WHERE reverses_purchase_event_id = $1",
    [originalId],
  );
  assert.equal(reversed.rows[0].total, "58.00");
  assert.ok(Number(reversed.rows[0].total) <= 60);
});

test("a reversal cannot reach a purchase on another IPO or another line", async () => {
  const a = await chain();
  const b = await chain();
  await purchase(a.ipoId, a.ipoLines[0].id, "10", "100.00");
  await purchase(b.ipoId, b.ipoLines[0].id, "10", "100.00");
  const aEvent = await firstEventId(a.ipoLines[0].id);

  // From IPO B, naming IPO A's purchase.
  const crossIpo = await reverse(b.ipoId, b.ipoLines[0].id, "-5", aEvent);
  assert.equal(crossIpo.status, 400);

  // Same IPO, wrong line.
  await purchase(a.ipoId, a.ipoLines[1].id, "5", "10.00");
  const crossLine = await reverse(a.ipoId, a.ipoLines[1].id, "-5", aEvent);
  assert.equal(crossLine.status, 400);

  // The composite foreign key makes it structurally impossible too.
  await assert.rejects(
    pool.query(
      `INSERT INTO ipo_purchase_events
         (ipo_id, ipo_line_id, quantity, actual_unit_price, procurement_note,
          purchased_by_user_id, operation_id, reverses_purchase_event_id)
       VALUES ($1, $2, -5, 100.00, 'direct', $3, $4, $5)`,
      [b.ipoId, b.ipoLines[0].id, users.ceo, randomUUID(), aEvent],
    ),
    /reversal_line_fkey|foreign key/i,
  );

  // Nothing changed on either IPO.
  assert.deepEqual(await totalsFor(a.ipoLines[0].id), { quantity: "10.00", value: "1000.00" });
  assert.deepEqual(await totalsFor(b.ipoLines[0].id), { quantity: "10.00", value: "1000.00" });
});

test("a reversal cannot reverse another reversal, or itself", async () => {
  const { ipoId, ipoLines } = await chain();
  await purchase(ipoId, ipoLines[0].id, "60", "100.00");
  const originalId = await firstEventId(ipoLines[0].id);
  assert.equal((await reverse(ipoId, ipoLines[0].id, "-20", originalId)).status, 200);

  const reversalId = (
    await pool.query("SELECT id FROM ipo_purchase_events WHERE reverses_purchase_event_id = $1", [originalId])
  ).rows[0].id;

  assert.equal((await reverse(ipoId, ipoLines[0].id, "-5", reversalId)).status, 400);
  await assert.rejects(
    pool.query(
      `INSERT INTO ipo_purchase_events
         (ipo_id, ipo_line_id, quantity, actual_unit_price, procurement_note,
          purchased_by_user_id, operation_id, reverses_purchase_event_id)
       VALUES ($1, $2, -5, 100.00, 'direct', $3, $4, $5)`,
      [ipoId, ipoLines[0].id, users.ceo, randomUUID(), reversalId],
    ),
    /only reference an original purchase/,
  );
});

test("multi-price history survives a reversal exactly", async () => {
  const { ipoId, ipoLines } = await chain({ quantities: [100, 20] });
  await purchase(ipoId, ipoLines[0].id, "60", "100.00");
  const firstEvent = await firstEventId(ipoLines[0].id);
  await purchase(ipoId, ipoLines[0].id, "20", "110.00");

  // Reverse 10 from the FIRST event only; the second is untouched.
  assert.equal((await reverse(ipoId, ipoLines[0].id, "-10", firstEvent)).status, 200);

  const events = await eventsFor(ipoLines[0].id);
  assert.deepEqual(
    events.map((e) => [e.quantity, e.actual_unit_price]),
    [["60.00", "100.00"], ["20.00", "110.00"], ["-10.00", "100.00"]],
    "the reversal took the first event's price, not the second's",
  );

  // 50 × 100 + 20 × 110 = 7,200, and 70 units net.
  assert.deepEqual(await totalsFor(ipoLines[0].id), { quantity: "70.00", value: "7200.00" });

  const detail = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipoId}`, { token: ctx.tokens.ceo });
  const line = detail.body.data.lines.find((row) => row.id === ipoLines[0].id);
  assert.equal(line.purchased_quantity, "70.00");
  assert.equal(line.actual_line_total, "7200.00");
  assert.equal(line.actual_unit_price, "110.00", "the latest price that still stands");
  // Outstanding follows the net purchase: 100 approved - 70 = 30.
  assert.equal(line.outstanding_quantity, "30.00");
});

test("Previous Actual Price ignores a fully reversed purchase and falls back", async () => {
  // Two finalized purchases of the SAME catalogue item: an older one at 90
  // that stands, and a newer one at 100 that is fully reversed.
  const older = await chain({ quantities: [100], prices: ["95.00"] });
  await purchase(older.ipoId, older.ipoLines[0].id, "30", "90.00");
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${older.ipoId}/close-purchasing`, {
      token: ctx.tokens.ceo,
    })).status,
    200,
  );

  const catalogEntryId = (
    await pool.query(
      `SELECT mdl.catalog_entry_id FROM ipo_lines il
       JOIN material_demand_lines mdl ON mdl.id = il.demand_line_id WHERE il.id = $1`,
      [older.ipoLines[0].id],
    )
  ).rows[0].catalog_entry_id;

  // A newer Demand for the same item, purchased at 100 and then fully reversed.
  const newer = await chain({ quantities: [100], prices: ["99.00"] });
  const newerLine = newer.ipoLines[0];
  await pool.query("UPDATE ipo_lines SET company_item_id = (SELECT company_item_id FROM ipo_lines WHERE id = $2) WHERE id = $1", [
    newerLine.id,
    older.ipoLines[0].id,
  ]).catch(() => {});

  await purchase(newer.ipoId, newerLine.id, "60", "100.00");
  const newerEvent = await firstEventId(newerLine.id);
  assert.equal((await reverse(newer.ipoId, newerLine.id, "-60", newerEvent)).status, 200);
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${newer.ipoId}/close-purchasing`, {
      token: ctx.tokens.ceo,
    })).status,
    200,
  );

  const { findLatestActualPurchases } = await import("../src/modules/ipo/ipo.repository.js");
  const companyItemId = (
    await pool.query("SELECT company_item_id FROM ipo_lines WHERE id = $1", [older.ipoLines[0].id])
  ).rows[0].company_item_id;
  const previous = await findLatestActualPurchases([companyItemId], null);

  assert.equal(
    previous.get(companyItemId)?.actual_unit_price,
    "90.00",
    "the fully reversed 100 is not what we last paid; the standing 90 is",
  );

  // And it reaches Procurement through the live pricing endpoint too.
  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: { lines: [{ catalogEntryId, quantity: 5 }] },
  });
  const demandId = created.body.data.demand.id;
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/submit`, { token: ctx.tokens.teamLead });
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/reviews`, {
    token: ctx.tokens.siteManager,
    body: { decision: "APPROVED" },
  });
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/approvals`, {
    token: ctx.tokens.ceo,
    body: { decision: "APPROVED" },
  });
  const pricing = await apiRequest(ctx.baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, {
    token: ctx.tokens.ceo,
  });
  assert.equal(pricing.body.data.lines[0].previous_purchase_unit_price, "90.00");
});

test("a partially reversed purchase remains an eligible Previous Actual Price", async () => {
  const built = await chain({ quantities: [100], prices: ["99.00"] });
  await purchase(built.ipoId, built.ipoLines[0].id, "60", "100.00");
  const originalId = await firstEventId(built.ipoLines[0].id);
  assert.equal((await reverse(built.ipoId, built.ipoLines[0].id, "-20", originalId)).status, 200);
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${built.ipoId}/close-purchasing`, {
      token: ctx.tokens.ceo,
    })).status,
    200,
  );

  const companyItemId = (
    await pool.query("SELECT company_item_id FROM ipo_lines WHERE id = $1", [built.ipoLines[0].id])
  ).rows[0].company_item_id;
  const { findLatestActualPurchases } = await import("../src/modules/ipo/ipo.repository.js");
  const previous = await findLatestActualPurchases([companyItemId], null);

  assert.equal(previous.get(companyItemId)?.actual_unit_price, "100.00", "40 units really were kept at 100");
  const line = await pool.query("SELECT purchased_quantity FROM ipo_lines WHERE id = $1", [built.ipoLines[0].id]);
  assert.equal(line.rows[0].purchased_quantity, "40.00");
});

test("a reversal cannot undo material that has already been put on a Delivery Challan", async () => {
  const { ipoId, ipoLines } = await chain();
  await purchase(ipoId, ipoLines[0].id, "60", "100.00");
  const originalId = await firstEventId(ipoLines[0].id);
  await createFinalizedDc(ctx, ipoId, [{ ipoLineId: ipoLines[0].id, quantity: "50" }]);

  // 50 have physically moved; only the 10 above that may be corrected away.
  assert.equal((await reverse(ipoId, ipoLines[0].id, "-20", originalId)).status, 409);
  assert.equal((await reverse(ipoId, ipoLines[0].id, "-10", originalId)).status, 200);

  const line = await pool.query("SELECT purchased_quantity FROM ipo_lines WHERE id = $1", [ipoLines[0].id]);
  assert.equal(line.rows[0].purchased_quantity, "50.00");
});

test("reversals are blocked once purchasing is closed, and require purchasing authority", async () => {
  const { ipoId, ipoLines } = await chain();
  await purchase(ipoId, ipoLines[0].id, "60", "100.00");
  const originalId = await firstEventId(ipoLines[0].id);

  // No new authority is introduced: a correction needs exactly the capability
  // that recording a purchase needs.
  for (const token of [ctx.tokens.teamLead, ctx.tokens.admin, ctx.tokens.siteManager, ctx.tokens.guard]) {
    const response = await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/purchases`, {
      token,
      body: {
        operationId: randomUUID(),
        lines: [
          { ipoLineId: ipoLines[0].id, quantity: "-5", reversesPurchaseEventId: originalId, reason: "x" },
        ],
      },
    });
    assert.equal(response.status, 403);
  }

  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/close-purchasing`, { token: ctx.tokens.ceo }))
      .status,
    200,
  );

  // Ordinary Procurement cannot append a correction to closed purchasing.
  assert.equal((await reverse(ipoId, ipoLines[0].id, "-5", originalId)).status, 409);
  await assert.rejects(
    pool.query("UPDATE ipo_lines SET purchased_quantity = 55 WHERE id = $1", [ipoLines[0].id]),
    /frozen once purchasing has been closed/,
  );
});

test("a replayed reversal records one correction, not two", async () => {
  const { ipoId, ipoLines } = await chain();
  await purchase(ipoId, ipoLines[0].id, "60", "100.00");
  const originalId = await firstEventId(ipoLines[0].id);
  const operationId = randomUUID();

  assert.equal((await reverse(ipoId, ipoLines[0].id, "-20", originalId, operationId)).status, 200);
  // The response was lost; the client retries the identical correction.
  assert.equal((await reverse(ipoId, ipoLines[0].id, "-20", originalId, operationId)).status, 200);

  const reversals = await pool.query(
    "SELECT COALESCE(SUM(-quantity), 0)::numeric(12,2) AS total, count(*)::int AS n FROM ipo_purchase_events WHERE reverses_purchase_event_id = $1",
    [originalId],
  );
  assert.equal(reversals.rows[0].n, 1);
  assert.equal(reversals.rows[0].total, "20.00");
  assert.deepEqual(await totalsFor(ipoLines[0].id), { quantity: "40.00", value: "4000.00" });

  // Two concurrent retries are equally safe.
  const raceOperation = randomUUID();
  await Promise.all([
    reverse(ipoId, ipoLines[0].id, "-5", originalId, raceOperation),
    reverse(ipoId, ipoLines[0].id, "-5", originalId, raceOperation),
  ]);
  const after = await pool.query(
    "SELECT count(*)::int AS n FROM ipo_purchase_events WHERE reverses_purchase_event_id = $1",
    [originalId],
  );
  assert.equal(after.rows[0].n, 2, "the original reversal plus one from the raced pair");
});

test("the corrected purchase history stays behind the price gate", async () => {
  // A price that appears nowhere else, so finding it is unambiguous proof of
  // a leak rather than a collision with an operational quantity.
  const PRICE = "137.77";
  const { ipoId, ipoLines } = await chain();
  await purchase(ipoId, ipoLines[0].id, "60", PRICE);
  const originalId = await firstEventId(ipoLines[0].id);
  await reverse(ipoId, ipoLines[0].id, "-20", originalId);

  const operational = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipoId}`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(operational.status, 200);
  assert.equal(operational.body.data.includesCommercialData, false);
  assert.deepEqual(operational.body.data.purchaseEvents, [], "no purchase history without price authority");
  const serialized = JSON.stringify(operational.body);
  assert.ok(!serialized.includes(PRICE), "the corrected price leaked to an operational viewer");
  assert.ok(!serialized.includes("reverses_purchase_event_id"));

  const authorized = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipoId}`, {
    token: ctx.tokens.siteManager,
  });
  assert.equal(authorized.body.data.purchaseEvents.length, 2);
  const reversal = authorized.body.data.purchaseEvents.find((e) => Number(e.quantity) < 0);
  assert.equal(reversal.reverses_purchase_event_id, originalId);
  assert.equal(reversal.actual_unit_price, PRICE);
});

test("the correction is audited without hiding that history was corrected", async () => {
  const { ipoId, ipoLines } = await chain();
  await purchase(ipoId, ipoLines[0].id, "60", "100.00");
  const originalId = await firstEventId(ipoLines[0].id);
  await reverse(ipoId, ipoLines[0].id, "-20", originalId);

  const audit = await pool.query(
    `SELECT metadata FROM procurement_audit_log
     WHERE ipo_id = $1 AND action = 'PURCHASE_RECORDED' ORDER BY created_at DESC LIMIT 1`,
    [ipoId],
  );
  const line = audit.rows[0].metadata.lines[0];
  assert.equal(line.quantity, "-20");
  assert.equal(line.reversesPurchaseEventId, originalId, "the audit names the purchase that was corrected");
  // Quantities and identifiers only — never the price.
  assert.ok(!JSON.stringify(audit.rows[0].metadata).includes("100.00"));
});
