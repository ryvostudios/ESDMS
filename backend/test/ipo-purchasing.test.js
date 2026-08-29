import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import {
  buildApprovedIpo,
  clearOverride,
  createFinalizedDc,
  recordPurchase,
  setOverride,
} from "./procurement-chain-helpers.js";

let ctx;
let users;
let uomId;

before(async () => {
  const server = await startTestServer();
  users = await seedUsers();
  const tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    upperManagement: await authHeader(server.baseUrl, "um@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    teamLeadOtherDept: await authHeader(server.baseUrl, "teamlead2@test.eset.local"),
    employee: await authHeader(server.baseUrl, "employee@test.eset.local"),
    guard: await authHeader(server.baseUrl, "guard@test.eset.local"),
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

const chain = (options = {}) => buildApprovedIpo(ctx, { uomId, ...options });

test("final approval generates exactly one immutable, correctly numbered IPO", async () => {
  const { demandId, ipoId, ipoNumber, pricingId } = await chain();

  const stored = await pool.query(
    `SELECT ipo_number, demand_id, demand_revision, pricing_id, status, currency, estimated_total,
            site_id, department_id
     FROM ipos WHERE id = $1`,
    [ipoId],
  );
  const ipo = stored.rows[0];
  assert.equal(ipo.status, "GENERATED");
  assert.equal(ipo.demand_revision, 1);
  assert.equal(ipo.pricing_id, pricingId);
  assert.equal(ipo.currency, "PKR");
  // 100 * 50.00 + 20 * 10.00 — computed by the server from the approved
  // pricing version, in exact numeric, never from a client total.
  assert.equal(ipo.estimated_total, "5200.00");
  // The authentic E-Set reference format, driven by configurable numbering
  // settings rather than a hard-coded string.
  assert.match(ipoNumber, /^ESET\/\d{4}\/\d+$/);

  const lines = await pool.query(
    "SELECT approved_quantity, estimated_unit_price, purchased_quantity, purchase_status FROM ipo_lines WHERE ipo_id = $1 ORDER BY line_no",
    [ipoId],
  );
  assert.deepEqual(
    lines.rows.map((line) => [line.approved_quantity, line.estimated_unit_price, line.purchase_status]),
    [["100.00", "50.00", "NOT_PURCHASED"], ["20.00", "10.00", "NOT_PURCHASED"]],
  );

  // Exactly-once: a second row for the same Demand revision is impossible.
  await assert.rejects(
    pool.query(
      // Copies every column, the authorization binding included, so the
      // unique (demand_id, demand_revision) index is genuinely what rejects
      // this rather than an incidental NOT NULL.
      `INSERT INTO ipos (ipo_number, demand_id, demand_revision, pricing_id, disposition_fingerprint,
                         site_id, department_id, estimated_total, generated_by_user_id)
       SELECT 'IPO-DUPLICATE-1', demand_id, demand_revision, pricing_id, disposition_fingerprint,
              site_id, department_id, estimated_total, generated_by_user_id
       FROM ipos WHERE id = $1`,
      [ipoId],
    ),
    /ipos_demand_revision_key|duplicate key/,
  );

  // The approved commercial snapshot is immutable, and the document cannot
  // be deleted, even from a direct database write.
  await assert.rejects(
    pool.query("UPDATE ipos SET estimated_total = 1 WHERE id = $1", [ipoId]),
    /approved IPO snapshot is immutable/,
  );
  await assert.rejects(pool.query("DELETE FROM ipos WHERE id = $1", [ipoId]), /cannot be deleted/);
  await assert.rejects(
    pool.query("UPDATE ipo_lines SET approved_quantity = 1 WHERE ipo_id = $1", [ipoId]),
    /approved IPO line snapshot is immutable/,
  );

  const demand = await pool.query("SELECT status FROM material_demands WHERE id = $1", [demandId]);
  assert.equal(demand.rows[0].status, "IPO_GENERATED");
});

test("IPO numbering is unique and sequential under concurrent generation", async () => {
  const results = await Promise.all([chain(), chain(), chain(), chain()]);
  const numbers = results.map((result) => result.ipoNumber);
  assert.equal(new Set(numbers).size, numbers.length, "no IPO number is ever issued twice");

  const sequences = numbers.map((number) => Number(number.split("/")[2]));
  const sorted = [...sequences].sort((a, b) => a - b);
  for (let index = 1; index < sorted.length; index += 1) {
    assert.notEqual(sorted[index], sorted[index - 1]);
  }
});

test("partial purchasing is recorded as real events, and over-purchase is rejected", async () => {
  const { ipoId, ipoLines } = await chain();

  const acknowledged = await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/acknowledge`, {
    token: ctx.tokens.ceo,
  });
  assert.equal(acknowledged.status, 200);
  assert.equal(acknowledged.body.data.ipo.status, "ACKNOWLEDGED");
  // Replayed acknowledgement is a successful no-op.
  assert.equal((await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/acknowledge`, { token: ctx.tokens.ceo })).status, 200);

  const overPurchase = await recordPurchase(ctx, ipoId, [
    { ipoLineId: ipoLines[0].id, quantity: "101", actualUnitPrice: "48.00" },
  ]);
  assert.equal(overPurchase.status, 400);

  const partial = await recordPurchase(ctx, ipoId, [
    { ipoLineId: ipoLines[0].id, quantity: "60", actualUnitPrice: "48.50", procurementNote: "Rest next week" },
  ]);
  assert.equal(partial.status, 200, JSON.stringify(partial.body));
  const line = partial.body.data.lines.find((row) => row.id === ipoLines[0].id);
  assert.equal(line.purchase_status, "PARTIALLY_PURCHASED");
  assert.equal(line.purchased_quantity, "60.00");
  assert.equal(line.outstanding_quantity, "40.00");
  // Estimated and actual price remain separately traceable, never overwritten.
  assert.equal(line.estimated_unit_price, "50.00");
  assert.equal(line.actual_unit_price, "48.50");

  // The rest is bought later, at a DIFFERENT price. Both transactions must
  // survive: a single cumulative price column would have destroyed the first.
  const rest = await recordPurchase(ctx, ipoId, [
    { ipoLineId: ipoLines[0].id, quantity: "40", actualUnitPrice: "52.25" },
  ]);
  assert.equal(rest.status, 200, JSON.stringify(rest.body));
  const closed = rest.body.data.lines.find((row) => row.id === ipoLines[0].id);
  assert.equal(closed.purchased_quantity, "100.00");
  assert.equal(closed.purchase_status, "PURCHASED");
  // 60 × 48.50 + 40 × 52.25 = 5000.00 — exact, from the events themselves.
  assert.equal(closed.actual_line_total, "5000.00");
  assert.equal(closed.actual_unit_price, "52.25", "the latest price, not an average");
  assert.equal(closed.purchase_event_count, 2);

  const events = rest.body.data.purchaseEvents.filter((event) => event.ipo_line_id === ipoLines[0].id);
  assert.deepEqual(
    events.map((event) => [event.quantity, event.actual_unit_price]),
    [["60.00", "48.50"], ["40.00", "52.25"]],
    "both purchases are preserved at the price actually paid",
  );

  // Nothing further fits under the approved quantity.
  assert.equal(
    (await recordPurchase(ctx, ipoId, [{ ipoLineId: ipoLines[0].id, quantity: "1", actualUnitPrice: "50.00" }]))
      .status,
    400,
  );
});

test("a purchase operation is idempotent, and a replay writes no second audit event", async () => {
  const { ipoId, ipoLines } = await chain();
  const operationId = randomUUID();
  const body = [{ ipoLineId: ipoLines[0].id, quantity: "60", actualUnitPrice: "48.50" }];

  assert.equal((await recordPurchase(ctx, ipoId, body, undefined, operationId)).status, 200);
  // Exactly the same request again — a retry after a lost response.
  assert.equal((await recordPurchase(ctx, ipoId, body, undefined, operationId)).status, 200);

  const line = await pool.query("SELECT purchased_quantity FROM ipo_lines WHERE id = $1", [ipoLines[0].id]);
  assert.equal(line.rows[0].purchased_quantity, "60.00", "the replay booked nothing");
  const events = await pool.query(
    "SELECT count(*)::int AS n FROM ipo_purchase_events WHERE ipo_line_id = $1",
    [ipoLines[0].id],
  );
  assert.equal(events.rows[0].n, 1);
  // Nothing happened, so nothing is audited a second time.
  const audit = await pool.query(
    "SELECT count(*)::int AS n FROM procurement_audit_log WHERE ipo_id = $1 AND action = 'PURCHASE_RECORDED'",
    [ipoId],
  );
  assert.equal(audit.rows[0].n, 1);

  // Two concurrent identical retries still book exactly one purchase.
  const { ipoId: raceIpo, ipoLines: raceLines } = await chain();
  const raceOperation = randomUUID();
  const raceBody = [{ ipoLineId: raceLines[0].id, quantity: "10", actualUnitPrice: "5.00" }];
  await Promise.all([
    recordPurchase(ctx, raceIpo, raceBody, undefined, raceOperation),
    recordPurchase(ctx, raceIpo, raceBody, undefined, raceOperation),
  ]);
  const raced = await pool.query(
    "SELECT count(*)::int AS n FROM ipo_purchase_events WHERE ipo_line_id = $1",
    [raceLines[0].id],
  );
  assert.equal(raced.rows[0].n, 1);

  // A genuinely separate purchase carries its own operation id.
  assert.equal((await recordPurchase(ctx, raceIpo, raceBody)).status, 200);
  const separate = await pool.query(
    "SELECT count(*)::int AS n, SUM(quantity)::numeric(12,2) AS total FROM ipo_purchase_events WHERE ipo_line_id = $1",
    [raceLines[0].id],
  );
  assert.equal(separate.rows[0].n, 2);
  assert.equal(separate.rows[0].total, "20.00");
});

test("a correction reverses an earlier purchase without erasing it", async () => {
  const { ipoId, ipoLines } = await chain();
  assert.equal(
    (await recordPurchase(ctx, ipoId, [
      { ipoLineId: ipoLines[0].id, quantity: "60", actualUnitPrice: "48.50" },
    ])).status,
    200,
  );

  // Booked in error: reverse 10 units. A correction names the exact purchase
  // it withdraws and inherits its price — see purchase-reversal.test.js for
  // the full financial-integrity rules.
  const originalId = (
    await pool.query(
      "SELECT id FROM ipo_purchase_events WHERE ipo_line_id = $1 ORDER BY purchased_at ASC LIMIT 1",
      [ipoLines[0].id],
    )
  ).rows[0].id;

  const corrected = await recordPurchase(ctx, ipoId, [
    {
      ipoLineId: ipoLines[0].id,
      quantity: "-10",
      reversesPurchaseEventId: originalId,
      reason: "Booked in error",
    },
  ]);
  assert.equal(corrected.status, 200, JSON.stringify(corrected.body));
  const line = corrected.body.data.lines.find((row) => row.id === ipoLines[0].id);
  assert.equal(line.purchased_quantity, "50.00");
  assert.equal(line.purchase_event_count, 2);

  // A correction can never reverse more than the purchase it references.
  assert.equal(
    (await recordPurchase(ctx, ipoId, [
      { ipoLineId: ipoLines[0].id, quantity: "-100", reversesPurchaseEventId: originalId, reason: "too much" },
    ])).status,
    409,
  );

  // Nor drop below what a live Delivery Challan already carries.
  await createFinalizedDc(ctx, ipoId, [{ ipoLineId: ipoLines[0].id, quantity: "50" }]);
  assert.equal(
    (await recordPurchase(ctx, ipoId, [
      { ipoLineId: ipoLines[0].id, quantity: "-40", reversesPurchaseEventId: originalId, reason: "too much" },
    ])).status,
    409,
  );
});

test("recorded purchasing facts freeze once purchasing is closed", async () => {
  const { ipoId, ipoLines } = await chain();
  assert.equal(
    (await recordPurchase(ctx, ipoId, [
      { ipoLineId: ipoLines[0].id, quantity: "60", actualUnitPrice: "48.50" },
    ])).status,
    200,
  );
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/close-purchasing`, { token: ctx.tokens.ceo }))
      .status,
    200,
  );

  // The service refuses...
  assert.equal(
    (await recordPurchase(ctx, ipoId, [
      { ipoLineId: ipoLines[0].id, quantity: "10", actualUnitPrice: "48.50" },
    ])).status,
    409,
  );

  // ...and so does the database, for any writer.
  await assert.rejects(
    pool.query("UPDATE ipo_lines SET purchased_quantity = 70 WHERE id = $1", [ipoLines[0].id]),
    /frozen once purchasing has been closed/,
  );
  await assert.rejects(
    pool.query("UPDATE ipo_lines SET procurement_note = 'rewritten' WHERE id = $1", [ipoLines[0].id]),
    /frozen once purchasing has been closed/,
  );
  // A recorded purchase event is never editable or deletable at any point.
  await assert.rejects(
    pool.query("UPDATE ipo_purchase_events SET actual_unit_price = 1 WHERE ipo_line_id = $1", [ipoLines[0].id]),
    /append-only/i,
  );
});

test("a purchase total cannot be fabricated without the events behind it", async () => {
  const { ipoId, ipoLines } = await chain();
  assert.equal(
    (await recordPurchase(ctx, ipoId, [
      { ipoLineId: ipoLines[0].id, quantity: "10", actualUnitPrice: "5.00" },
    ])).status,
    200,
  );

  // Inflating the stored total, even into a shape the CHECK constraint would
  // otherwise accept, is refused: the aggregate must equal the sum of the
  // recorded events.
  await assert.rejects(
    pool.query(
      "UPDATE ipo_lines SET purchased_quantity = approved_quantity, purchase_status = 'PURCHASED' WHERE id = $1",
      [ipoLines[0].id],
    ),
    /must equal the sum of recorded purchase events/,
  );

  // The untouched line is equally protected.
  await assert.rejects(
    pool.query(
      "UPDATE ipo_lines SET purchased_quantity = approved_quantity, purchase_status = 'PURCHASED' WHERE id = $1",
      [ipoLines[1].id],
    ),
    /must equal the sum of recorded purchase events/,
  );

  const line = await pool.query("SELECT purchased_quantity FROM ipo_lines WHERE id = $1", [ipoLines[0].id]);
  assert.equal(line.rows[0].purchased_quantity, "10.00");
});

test("actual purchase prices and totals are invisible without commercial authority", async () => {
  const { ipoId, ipoLines } = await chain();
  assert.equal((await recordPurchase(ctx, ipoId, [
    { ipoLineId: ipoLines[0].id, quantity: "100", actualUnitPrice: "47.25" },
  ])).status, 200);

  const teamLead = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipoId}`, { token: ctx.tokens.teamLead });
  assert.equal(teamLead.status, 200);
  assert.equal(teamLead.body.data.includesCommercialData, false);
  assert.equal(teamLead.body.data.ipo.estimated_total, undefined);
  const serialized = JSON.stringify(teamLead.body);
  assert.ok(!serialized.includes("47.25"), "an operational viewer never receives an actual purchase price");
  assert.ok(!serialized.includes("estimated_unit_price"), "no estimated price column is even projected");
  // Operational quantities remain fully visible — receiving does not need prices.
  assert.equal(teamLead.body.data.lines[0].purchased_quantity, "100.00");

  const manager = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipoId}`, { token: ctx.tokens.siteManager });
  assert.equal(manager.body.data.includesCommercialData, true);
  assert.equal(manager.body.data.lines[0].actual_unit_price, "47.25");
  assert.equal(manager.body.data.ipo.estimated_total, "5200.00");
});

test("IPO PDF requires commercial authority and respects department/site isolation", async () => {
  const { ipoId } = await chain();

  const teamLeadPdf = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipoId}/pdf`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(teamLeadPdf.status, 403, "ipo.view alone must not become a price-leak bypass");

  const guardPdf = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipoId}/pdf`, { token: ctx.tokens.guard });
  assert.equal(guardPdf.status, 403);

  // Fetched directly rather than through apiRequest, which consumes the body
  // as JSON — this document is binary and must be inspected as bytes.
  const managerPdf = await fetch(`${ctx.baseUrl}/api/v1/ipos/${ipoId}/pdf`, {
    headers: { Origin: "http://localhost:5173", Cookie: ctx.tokens.siteManager },
  });
  assert.equal(managerPdf.status, 200);
  assert.equal(managerPdf.headers.get("content-type"), "application/pdf");
  // The business reference contains "/" — the download filename must be a
  // sanitized derivation of it, never the raw value, which would break the
  // Content-Disposition header and reach a filesystem path unescaped.
  const disposition = managerPdf.headers.get("content-disposition");
  assert.match(disposition, /^attachment; filename="ESET-\d{4}-\d+\.pdf"$/);
  assert.ok(!disposition.includes("/"), "no path separator ever reaches the download filename");
  assert.equal(managerPdf.headers.get("cache-control"), "private, no-store");
  const bytes = Buffer.from(await managerPdf.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
  assert.ok(bytes.length > 1000, "a real document, not an empty stub");

  // Another site's management cannot obtain the document by knowing the id.
  await setOverride(users.otherSiteAdmin, "procurement.view_prices", "GRANT", users.ceo);
  try {
    const crossSite = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipoId}/pdf`, {
      token: ctx.tokens.otherSiteAdmin,
    });
    assert.equal(crossSite.status, 404);
  } finally {
    await clearOverride(users.otherSiteAdmin, "procurement.view_prices");
  }
});

test("IPO visibility is department-scoped for an ordinary department user", async () => {
  const { ipoId } = await chain();

  const ownDepartment = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipoId}`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(ownDepartment.status, 200);

  const otherDepartment = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipoId}`, {
    token: ctx.tokens.teamLeadOtherDept,
  });
  assert.equal(otherDepartment.status, 404, "a sibling department's IPO is indistinguishable from a missing one");

  const otherSite = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipoId}`, {
    token: ctx.tokens.otherSiteAdmin,
  });
  assert.equal(otherSite.status, 404);

  const listed = await apiRequest(ctx.baseUrl, "GET", "/api/v1/ipos?pageSize=100", {
    token: ctx.tokens.teamLeadOtherDept,
  });
  assert.equal(listed.status, 200);
  assert.ok(!listed.body.data.some((row) => row.id === ipoId), "cross-department IPOs never appear in a list");
});

test("cancellation preserves the IPO and its number, and never voids recorded purchases", async () => {
  const { ipoId, ipoNumber, demandId, ipoLines } = await chain();

  const unauthorized = await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/cancel`, {
    token: ctx.tokens.siteManager,
    body: { reason: "No longer needed" },
  });
  assert.equal(unauthorized.status, 403);

  const noReason = await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/cancel`, {
    token: ctx.tokens.ceo,
    body: {},
  });
  assert.equal(noReason.status, 400);

  const cancelled = await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/cancel`, {
    token: ctx.tokens.ceo,
    body: { category: "NO_LONGER_REQUIRED", reason: "Project deferred" },
  });
  assert.equal(cancelled.status, 200, JSON.stringify(cancelled.body));
  assert.equal(cancelled.body.data.ipo.status, "CANCELLED");
  assert.equal(cancelled.body.data.ipo.ipo_number, ipoNumber, "the number is preserved, never released");

  assert.equal(
    (await pool.query("SELECT status FROM material_demands WHERE id = $1", [demandId])).rows[0].status,
    "IPO_CANCELLED",
  );
  assert.equal(
    (await recordPurchase(ctx, ipoId, [{ ipoLineId: ipoLines[0].id, quantity: "5", actualUnitPrice: "1.00" }]))
      .status,
    409,
  );
  await assert.rejects(
    pool.query("UPDATE ipos SET status = 'PURCHASING' WHERE id = $1", [ipoId]),
    /cancelled IPO cannot be reopened/,
  );

  // A purchased IPO is protected from cancellation: recorded purchases are
  // never silently voided.
  const purchased = await chain();
  assert.equal(
    (await recordPurchase(ctx, purchased.ipoId, [
      { ipoLineId: purchased.ipoLines[0].id, quantity: "10", actualUnitPrice: "40.00" },
    ])).status,
    200,
  );
  const refused = await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${purchased.ipoId}/cancel`, {
    token: ctx.tokens.ceo,
    body: { reason: "Change of plan" },
  });
  assert.equal(refused.status, 409);
});

test("previous purchase price comes from actual history and stays behind the price gate", async () => {
  const first = await chain({ prices: ["50.00", "10.00"] });
  assert.equal(
    (await recordPurchase(ctx, first.ipoId, [
      { ipoLineId: first.ipoLines[0].id, quantity: "100", actualUnitPrice: "44.75" },
    ])).status,
    200,
  );

  const catalogEntryId = (
    await pool.query(
      `SELECT mdl.catalog_entry_id FROM ipo_lines il
       JOIN material_demand_lines mdl ON mdl.id = il.demand_line_id
       WHERE il.id = $1`,
      [first.ipoLines[0].id],
    )
  ).rows[0].catalog_entry_id;

  // A second Demand for the SAME catalog item, taken to the pricing stage.
  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: { lines: [{ catalogEntryId, quantity: 30 }] },
  });
  assert.equal(created.status, 201);
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

  // Purchasing on the first IPO is still OPEN, so its price is not yet an
  // authoritative "what we last paid" — it can still move.
  const inProgress = await apiRequest(ctx.baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, {
    token: ctx.tokens.ceo,
  });
  assert.equal(inProgress.status, 200);
  assert.equal(
    inProgress.body.data.lines[0].previous_purchase_unit_price,
    null,
    "an unfinalized purchase is not a previous purchase price",
  );

  // Once Procurement formally closes purchasing, it becomes authoritative.
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${first.ipoId}/close-purchasing`, {
      token: ctx.tokens.ceo,
    })).status,
    200,
  );

  const pricing = await apiRequest(ctx.baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, {
    token: ctx.tokens.ceo,
  });
  assert.equal(pricing.status, 200);
  assert.equal(pricing.body.data.lines[0].previous_purchase_unit_price, "44.75");
  assert.equal(pricing.body.data.lines[0].previous_purchase_ipo_number, first.ipoNumber);

  // A user without price authority cannot reach the pricing endpoint at all,
  // so previous prices are unreachable through it.
  const teamLead = await apiRequest(ctx.baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(teamLead.status, 403);
});

test("an unpurchased balance becomes a claimable carry-forward source once purchasing closes", async () => {
  const { ipoId, ipoLines } = await chain({ quantities: [100, 20] });
  assert.equal(
    (await recordPurchase(ctx, ipoId, [
      { ipoLineId: ipoLines[0].id, quantity: "60", actualUnitPrice: "48.00" },
      { ipoLineId: ipoLines[1].id, quantity: "20", actualUnitPrice: "9.00" },
    ])).status,
    200,
  );

  const catalogEntryId = (
    await pool.query(
      `SELECT mdl.catalog_entry_id FROM ipo_lines il
       JOIN material_demand_lines mdl ON mdl.id = il.demand_line_id WHERE il.id = $1`,
      [ipoLines[0].id],
    )
  ).rows[0].catalog_entry_id;

  const outstandingUrl = `/api/v1/ipos/outstanding?catalogEntryIds=${catalogEntryId}`;

  // While purchasing is still open the shortfall can change, so it is not yet
  // a carry-forward source.
  const early = await apiRequest(ctx.baseUrl, "GET", outstandingUrl, { token: ctx.tokens.teamLead });
  assert.equal(early.status, 200);
  assert.ok(!early.body.data.some((row) => row.ipo_id === ipoId));

  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/close-purchasing`, { token: ctx.tokens.ceo }))
      .status,
    200,
  );

  const outstanding = await apiRequest(ctx.baseUrl, "GET", outstandingUrl, { token: ctx.tokens.teamLead });
  assert.equal(outstanding.status, 200, JSON.stringify(outstanding.body));
  const row = outstanding.body.data.find((entry) => entry.ipo_id === ipoId);
  assert.ok(row, "the unresolved prior quantity is discoverable for a later Demand");
  assert.equal(row.source_type, "UNPURCHASED_IPO_QUANTITY");
  assert.equal(row.source_quantity, "40.00");
  assert.equal(row.allocated_quantity, "0.00");
  assert.equal(row.available_quantity, "40.00");

  // Reading carry-forward information changes nothing about the old IPO.
  const unchanged = await pool.query(
    "SELECT approved_quantity, purchased_quantity FROM ipo_lines WHERE id = $1",
    [ipoLines[0].id],
  );
  assert.deepEqual(unchanged.rows[0], { approved_quantity: "100.00", purchased_quantity: "60.00" });
});

test("purchasing capability is required and is not implied by management or ADMIN roles", async () => {
  const { ipoId, ipoLines } = await chain();
  // A fresh operation id per attempt, so a later attempt is never mistaken
  // for a replay of an earlier refused one.
  const body = () => ({
    operationId: randomUUID(),
    lines: [{ ipoLineId: ipoLines[0].id, quantity: "1", actualUnitPrice: "1.00" }],
  });

  for (const token of [ctx.tokens.admin, ctx.tokens.siteManager, ctx.tokens.upperManagement, ctx.tokens.teamLead]) {
    const response = await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/purchases`, {
      token,
      body: body(),
    });
    assert.equal(response.status, 403);
  }

  // WHAT (purchase) and WHERE (site scope) are separate grants; purchasing
  // another department's IPO needs both.
  await setOverride(users.admin, "procurement.purchase", "GRANT", users.ceo);
  await setOverride(users.admin, "procurement.site_scope", "GRANT", users.ceo);
  try {
    assert.equal(
      (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/purchases`, {
        token: ctx.tokens.admin,
        body: body(),
      })).status,
      200,
    );
  } finally {
    await clearOverride(users.admin, "procurement.purchase");
    await clearOverride(users.admin, "procurement.site_scope");
  }

  await setOverride(users.admin, "procurement.purchase", "DENY", users.ceo);
  try {
    assert.equal(
      (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/purchases`, {
        token: ctx.tokens.admin,
        body: body(),
      })).status,
      403,
      "an individual DENY still wins",
    );
  } finally {
    await clearOverride(users.admin, "procurement.purchase");
  }
});
