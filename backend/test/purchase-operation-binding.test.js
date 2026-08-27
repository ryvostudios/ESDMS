import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { buildApprovedIpo, recordPurchase } from "./procurement-chain-helpers.js";

// An operation id makes a purchase request retryable. It does not make an
// unrelated request succeed: answering "buy 30 for IPO-B" with an event that
// bought 20 for IPO-A reports a purchase that never happened, and reports it
// with a success status.

let ctx;
let uomId;

before(async () => {
  const server = await startTestServer();
  await seedUsers();
  const tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
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

const ipo = (quantities = [100, 100]) => buildApprovedIpo(ctx, { uomId, quantities });

const buy = (target, lineId, quantity, price, operationId) =>
  recordPurchase(ctx, target.ipoId, [{ ipoLineId: lineId, quantity, actualUnitPrice: price }], null, operationId);

const reverse = (target, lineId, quantity, eventId, operationId, reason = "over-ordered") =>
  recordPurchase(
    ctx,
    target.ipoId,
    [{ ipoLineId: lineId, quantity, reversesPurchaseEventId: eventId, reason }],
    null,
    operationId,
  );

const lineState = async (lineId) =>
  (
    await pool.query(
      `SELECT l.purchased_quantity,
              (SELECT COALESCE(SUM(e.quantity * e.actual_unit_price), 0)::numeric(16,2)
               FROM ipo_purchase_events e WHERE e.ipo_line_id = l.id) AS actual_total,
              (SELECT count(*)::int FROM ipo_purchase_events e WHERE e.ipo_line_id = l.id) AS events
       FROM ipo_lines l WHERE l.id = $1`,
      [lineId],
    )
  ).rows[0];

const purchaseAudits = async (ipoId) =>
  (
    await pool.query(
      "SELECT count(*)::int AS n FROM procurement_audit_log WHERE ipo_id = $1 AND action = 'PURCHASE_RECORDED'",
      [ipoId],
    )
  ).rows[0].n;

const eventIdFor = async (lineId) =>
  (
    await pool.query(
      "SELECT id FROM ipo_purchase_events WHERE ipo_line_id = $1 AND quantity > 0 ORDER BY purchased_at LIMIT 1",
      [lineId],
    )
  ).rows[0].id;

test("1 — an exact replay books nothing further and writes no second audit", async () => {
  const a = await ipo();
  const op = randomUUID();

  assert.equal((await buy(a, a.ipoLines[0].id, "20", "100.00", op)).status, 200);
  assert.equal((await buy(a, a.ipoLines[0].id, "20", "100.00", op)).status, 200);

  const state = await lineState(a.ipoLines[0].id);
  assert.equal(state.purchased_quantity, "20.00");
  assert.equal(state.actual_total, "2000.00");
  assert.equal(state.events, 1);
  assert.equal(await purchaseAudits(a.ipoId), 1);
});

test("2 — the same id under a different IPO conflicts and books nothing", async () => {
  const a = await ipo();
  const b = await ipo();
  const op = randomUUID();

  assert.equal((await buy(a, a.ipoLines[0].id, "20", "100.00", op)).status, 200);
  const crossIpo = await buy(b, b.ipoLines[0].id, "30", "200.00", op);
  assert.equal(crossIpo.status, 409);

  const state = await lineState(b.ipoLines[0].id);
  assert.equal(state.purchased_quantity, "0.00");
  assert.equal(state.actual_total, "0.00");
  assert.equal(state.events, 0);
  assert.equal(await purchaseAudits(b.ipoId), 0);
});

test("3 — the same id on a different line of the same IPO conflicts", async () => {
  const a = await ipo();
  const op = randomUUID();

  assert.equal((await buy(a, a.ipoLines[0].id, "20", "100.00", op)).status, 200);
  assert.equal((await buy(a, a.ipoLines[1].id, "40", "100.00", op)).status, 409);

  assert.equal((await lineState(a.ipoLines[1].id)).purchased_quantity, "0.00");
  assert.equal((await lineState(a.ipoLines[1].id)).events, 0);
  assert.equal(await purchaseAudits(a.ipoId), 1);
});

test("4 — the same id with a different quantity conflicts", async () => {
  const a = await ipo();
  const op = randomUUID();

  assert.equal((await buy(a, a.ipoLines[0].id, "20", "100.00", op)).status, 200);
  assert.equal((await buy(a, a.ipoLines[0].id, "30", "100.00", op)).status, 409);

  const state = await lineState(a.ipoLines[0].id);
  assert.equal(state.purchased_quantity, "20.00", "the stored event was mutated");
  assert.equal(state.events, 1);
});

test("5 — the same id at a different price conflicts and leaves the original event alone", async () => {
  const a = await ipo();
  const op = randomUUID();

  assert.equal((await buy(a, a.ipoLines[0].id, "20", "100.00", op)).status, 200);
  assert.equal((await buy(a, a.ipoLines[0].id, "20", "110.00", op)).status, 409);

  const state = await lineState(a.ipoLines[0].id);
  assert.equal(state.actual_total, "2000.00", "the recorded value moved");
  assert.equal(state.events, 1);

  // A trailing line added to an otherwise identical request is a different
  // operation too.
  const widened = await recordPurchase(
    ctx,
    a.ipoId,
    [
      { ipoLineId: a.ipoLines[0].id, quantity: "20", actualUnitPrice: "100.00" },
      { ipoLineId: a.ipoLines[1].id, quantity: "5", actualUnitPrice: "100.00" },
    ],
    null,
    op,
  );
  assert.equal(widened.status, 409);
  assert.equal((await lineState(a.ipoLines[1].id)).events, 0);
});

test("6+7 — a purchase id cannot be reused for a reversal, or the reverse", async () => {
  const a = await ipo();
  const purchaseOp = randomUUID();
  const reversalOp = randomUUID();

  assert.equal((await buy(a, a.ipoLines[0].id, "20", "100.00", purchaseOp)).status, 200);
  const eventId = await eventIdFor(a.ipoLines[0].id);

  // Purchase id reused for a correction.
  assert.equal((await reverse(a, a.ipoLines[0].id, "-5", eventId, purchaseOp)).status, 409);
  assert.equal((await lineState(a.ipoLines[0].id)).purchased_quantity, "20.00");

  // A genuine correction, then its id reused for a fresh purchase.
  assert.equal((await reverse(a, a.ipoLines[0].id, "-5", eventId, reversalOp)).status, 200);
  assert.equal((await lineState(a.ipoLines[0].id)).purchased_quantity, "15.00");

  assert.equal((await buy(a, a.ipoLines[1].id, "10", "100.00", reversalOp)).status, 409);
  assert.equal((await lineState(a.ipoLines[1].id)).events, 0);

  // The correction itself still replays cleanly.
  assert.equal((await reverse(a, a.ipoLines[0].id, "-5", eventId, reversalOp)).status, 200);
  const state = await lineState(a.ipoLines[0].id);
  assert.equal(state.purchased_quantity, "15.00", "the replayed correction reversed twice");
  assert.equal(state.events, 2);
});

test("8 — a reversal id cannot be turned on a different original event", async () => {
  const a = await ipo();
  const op = randomUUID();

  assert.equal((await buy(a, a.ipoLines[0].id, "20", "100.00", randomUUID())).status, 200);
  assert.equal((await buy(a, a.ipoLines[1].id, "20", "100.00", randomUUID())).status, 200);
  const eventA = await eventIdFor(a.ipoLines[0].id);
  const eventB = await eventIdFor(a.ipoLines[1].id);

  assert.equal((await reverse(a, a.ipoLines[0].id, "-5", eventA, op)).status, 200);
  // Same line, same quantity — only the source event differs. Still a
  // different operation.
  assert.equal((await reverse(a, a.ipoLines[1].id, "-5", eventB, op)).status, 409);

  assert.equal((await lineState(a.ipoLines[0].id)).purchased_quantity, "15.00");
  assert.equal((await lineState(a.ipoLines[1].id)).purchased_quantity, "20.00", "line 2 was reversed");
});

test("9 — concurrent exact replays produce one event and one audit", async () => {
  const a = await ipo();
  const op = randomUUID();

  const results = await Promise.all([
    buy(a, a.ipoLines[0].id, "20", "100.00", op),
    buy(a, a.ipoLines[0].id, "20", "100.00", op),
  ]);
  assert.ok(results.every((r) => r.status === 200), JSON.stringify(results.map((r) => r.status)));

  const state = await lineState(a.ipoLines[0].id);
  assert.equal(state.events, 1);
  assert.equal(state.purchased_quantity, "20.00");
  assert.equal(await purchaseAudits(a.ipoId), 1);
});

test("10 — a concurrent cross-IPO collision leaves exactly one owner", async () => {
  const a = await ipo();
  const b = await ipo();
  const op = randomUUID();

  const [forA, forB] = await Promise.all([
    buy(a, a.ipoLines[0].id, "20", "100.00", op),
    buy(b, b.ipoLines[0].id, "30", "200.00", op),
  ]);

  assert.equal([forA, forB].filter((r) => r.status === 200).length, 1, "both requests claimed the same id");
  assert.equal([forA, forB].filter((r) => r.status === 409).length, 1);

  const owned = await pool.query("SELECT DISTINCT ipo_id FROM ipo_purchase_events WHERE operation_id = $1", [op]);
  assert.equal(owned.rowCount, 1, "one operation id ended up spanning two IPOs");

  const loser = forA.status === 200 ? b : a;
  const state = await lineState(loser.ipoLines[0].id);
  assert.equal(state.purchased_quantity, "0.00");
  assert.equal(state.events, 0);
  assert.equal(await purchaseAudits(loser.ipoId), 0);
});

test("12 — a conflict discloses nothing about the operation's real owner", async () => {
  const a = await ipo();
  const b = await ipo();
  const op = randomUUID();

  assert.equal((await buy(a, a.ipoLines[0].id, "20", "137.50", op)).status, 200);
  const conflict = await buy(b, b.ipoLines[0].id, "30", "200.00", op);
  assert.equal(conflict.status, 409);

  const body = JSON.stringify(conflict.body);
  for (const secret of [a.ipoId, a.ipoNumber, a.ipoLines[0].id, "137.50", "137.5", "2750", "20.00"]) {
    if (secret) assert.ok(!body.includes(secret), `the conflict leaked ${secret}`);
  }
  assert.match(conflict.body.error.message, /already been used/i);
});

test("11+24+25 — a conflict leaves previous-price history and carry-forward untouched", async () => {
  const a = await ipo();
  const b = await ipo();
  const op = randomUUID();

  const companyItemId = (
    await pool.query("SELECT company_item_id FROM ipo_lines WHERE id = $1", [b.ipoLines[0].id])
  ).rows[0].company_item_id;
  const previousPrice = async () =>
    (
      await pool.query(
        `SELECT e.actual_unit_price
         FROM ipo_purchase_events e
         JOIN ipo_lines l ON l.id = e.ipo_line_id
         WHERE l.company_item_id = $1
         ORDER BY e.purchased_at DESC LIMIT 1`,
        [companyItemId],
      )
    ).rows[0]?.actual_unit_price ?? null;
  const outstanding = async () =>
    (
      await pool.query(
        "SELECT (approved_quantity - purchased_quantity)::numeric(12,2) AS q FROM ipo_lines WHERE id = $1",
        [b.ipoLines[0].id],
      )
    ).rows[0].q;

  assert.equal((await buy(a, a.ipoLines[0].id, "20", "100.00", op)).status, 200);

  const priceBefore = await previousPrice();
  const outstandingBefore = await outstanding();

  assert.equal((await buy(b, b.ipoLines[0].id, "30", "250.00", op)).status, 409);

  // A rejected request books nothing, so it cannot become the price the next
  // demand is compared against, nor shrink what carry-forward still owes.
  assert.equal(await previousPrice(), priceBefore);
  assert.equal(await previousPrice(), null, "a phantom purchase entered price history");
  assert.equal(await outstanding(), outstandingBefore);
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM ipo_purchase_events WHERE ipo_id = $1", [b.ipoId]))
      .rows[0].n,
    0,
  );
});
