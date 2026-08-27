import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { buildApprovedIpo, createFinalizedDc, recordPurchase } from "./procurement-chain-helpers.js";

let ctx;
let uomId;

before(async () => {
  const server = await startTestServer();
  await seedUsers();
  const tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
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

async function purchasedChain(quantity = "60") {
  const built = await chain();
  assert.equal(
    (await recordPurchase(ctx, built.ipoId, [
      { ipoLineId: built.ipoLines[0].id, quantity: quantity, actualUnitPrice: "48.00" },
    ])).status,
    200,
  );
  return built;
}

test("a Delivery Challan can only deliver what was actually purchased", async () => {
  const { ipoId, ipoLines } = await purchasedChain("60");

  const overAllocated = await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
    token: ctx.tokens.ceo,
    body: { operationId: randomUUID(), ipoId, lines: [{ ipoLineId: ipoLines[0].id, quantity: "61" }] },
  });
  assert.equal(overAllocated.status, 400);

  const unpurchasedLine = await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
    token: ctx.tokens.ceo,
    body: { operationId: randomUUID(), ipoId, lines: [{ ipoLineId: ipoLines[1].id, quantity: "1" }] },
  });
  assert.equal(unpurchasedLine.status, 400, "nothing was purchased on that line");

  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
    token: ctx.tokens.ceo,
    body: { operationId: randomUUID(), ipoId, lines: [{ ipoLineId: ipoLines[0].id, quantity: "40" }] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal(created.body.data.deliveryChallan.status, "DRAFT");
  assert.match(created.body.data.deliveryChallan.dc_number, /^ESET-DC\/\d{4}\/\d+$/);
});

test("the same purchased quantity can never be allocated to two Delivery Challans", async () => {
  const { ipoId, ipoLines } = await purchasedChain("60");

  const first = await createFinalizedDc(ctx, ipoId, [{ ipoLineId: ipoLines[0].id, quantity: "40" }]);
  assert.ok(first.dcId);

  const overflow = await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
    token: ctx.tokens.ceo,
    body: { operationId: randomUUID(), ipoId, lines: [{ ipoLineId: ipoLines[0].id, quantity: "21" }] },
  });
  assert.equal(overflow.status, 400, "only 20 of the purchased 60 remain unallocated");

  // The remainder is legitimately deliverable on a second challan — partial
  // delivery must not be blocked.
  const second = await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
    token: ctx.tokens.ceo,
    body: { operationId: randomUUID(), ipoId, lines: [{ ipoLineId: ipoLines[0].id, quantity: "20" }] },
  });
  assert.equal(second.status, 201);

  // Direct database writes cannot bypass the allocation invariant either.
  await assert.rejects(
    pool.query(
      `INSERT INTO delivery_challan_lines
         (dc_id, ipo_id, ipo_line_id, line_no, item_name_snapshot, uom_code_snapshot, uom_name_snapshot, quantity)
       VALUES ($1, $2, $3, 99, 'x', 'x', 'x', 5)`,
      [second.body.data.deliveryChallan.id, ipoId, ipoLines[0].id],
    ),
    /allocation exceeds the purchased quantity/,
  );
});

test("concurrent Delivery Challan creation cannot double-allocate the same line", async () => {
  const { ipoId, ipoLines } = await purchasedChain("60");

  // Two DIFFERENT shipments racing for the same remaining quantity — distinct
  // operation ids, so this is a real allocation race, not a retry.
  const line = { ipoLineId: ipoLines[0].id, quantity: "60" };
  const [a, b] = await Promise.all([
    apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
      token: ctx.tokens.ceo,
      body: { operationId: randomUUID(), ipoId, lines: [line] },
    }),
    apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
      token: ctx.tokens.ceo,
      body: { operationId: randomUUID(), ipoId, lines: [line] },
    }),
  ]);

  const created = [a, b].filter((response) => response.status === 201);
  assert.equal(created.length, 1, "exactly one of two concurrent full allocations may succeed");

  const allocated = await pool.query(
    `SELECT COALESCE(SUM(dcl.quantity), 0)::numeric(12,2) AS total
     FROM delivery_challan_lines dcl JOIN delivery_challans dc ON dc.id = dcl.dc_id
     WHERE dcl.ipo_line_id = $1 AND dc.status <> 'CANCELLED'`,
    [ipoLines[0].id],
  );
  assert.equal(allocated.rows[0].total, "60.00");
});

test("a finalized Delivery Challan is immutable and finalization is idempotent", async () => {
  const { ipoId, ipoLines } = await purchasedChain("60");
  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
    token: ctx.tokens.ceo,
    body: { operationId: randomUUID(), ipoId, note: "First run", lines: [{ ipoLineId: ipoLines[0].id, quantity: "30" }] },
  });
  const dcId = created.body.data.deliveryChallan.id;

  // A draft is correctable in place.
  const edited = await apiRequest(ctx.baseUrl, "PATCH", `/api/v1/delivery-challans/${dcId}`, {
    token: ctx.tokens.ceo,
    body: { lines: [{ ipoLineId: ipoLines[0].id, quantity: "35" }] },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.lines[0].quantity, "35.00");

  const finalized = await apiRequest(ctx.baseUrl, "POST", `/api/v1/delivery-challans/${dcId}/finalize`, {
    token: ctx.tokens.ceo,
  });
  assert.equal(finalized.status, 200);
  assert.equal(finalized.body.data.deliveryChallan.status, "FINALIZED");

  // Replayed finalize is a successful no-op, not a second transition.
  const replay = await apiRequest(ctx.baseUrl, "POST", `/api/v1/delivery-challans/${dcId}/finalize`, {
    token: ctx.tokens.ceo,
  });
  assert.equal(replay.status, 200);
  const transitions = await pool.query(
    "SELECT count(*)::int AS n FROM procurement_audit_log WHERE entity_id = $1 AND action = 'DC_FINALIZED'",
    [dcId],
  );
  assert.equal(transitions.rows[0].n, 1);

  const afterFinalize = await apiRequest(ctx.baseUrl, "PATCH", `/api/v1/delivery-challans/${dcId}`, {
    token: ctx.tokens.ceo,
    body: { lines: [{ ipoLineId: ipoLines[0].id, quantity: "1" }] },
  });
  assert.equal(afterFinalize.status, 409, "finalized content is never silently rewritten");

  await assert.rejects(
    pool.query("UPDATE delivery_challan_lines SET quantity = 1 WHERE dc_id = $1", [dcId]),
    /can only change while the challan is a draft/,
  );
  await assert.rejects(
    pool.query("DELETE FROM delivery_challans WHERE id = $1", [dcId]),
    /cannot be deleted/,
  );
});

test("Delivery Challan management requires dc.manage; viewing is department-scoped", async () => {
  const { ipoId, ipoLines } = await purchasedChain("60");
  const body = { ipoId, lines: [{ ipoLineId: ipoLines[0].id, quantity: "10" }] };

  for (const token of [ctx.tokens.teamLead, ctx.tokens.admin, ctx.tokens.siteManager, ctx.tokens.employee]) {
    assert.equal(
      (await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", { token, body })).status,
      403,
    );
  }

  const { dcId } = await createFinalizedDc(ctx, ipoId, [{ ipoLineId: ipoLines[0].id, quantity: "10" }]);

  assert.equal(
    (await apiRequest(ctx.baseUrl, "GET", `/api/v1/delivery-challans/${dcId}`, { token: ctx.tokens.teamLead }))
      .status,
    200,
  );
  assert.equal(
    (await apiRequest(ctx.baseUrl, "GET", `/api/v1/delivery-challans/${dcId}`, {
      token: ctx.tokens.teamLeadOtherDept,
    })).status,
    404,
  );
  assert.equal(
    (await apiRequest(ctx.baseUrl, "GET", `/api/v1/delivery-challans/${dcId}`, {
      token: ctx.tokens.otherSiteAdmin,
    })).status,
    404,
  );
  assert.equal(
    (await apiRequest(ctx.baseUrl, "GET", `/api/v1/delivery-challans/${dcId}`, { token: ctx.tokens.guard })).status,
    403,
    "Gate Guard has no Delivery Challan access at all",
  );
});

test("the Delivery Challan document carries no commercial information", async () => {
  const { ipoId, ipoLines } = await purchasedChain("60");
  const { dcId } = await createFinalizedDc(ctx, ipoId, [{ ipoLineId: ipoLines[0].id, quantity: "25" }]);

  // A department receiver can obtain the operational document without any
  // price capability whatsoever.
  const response = await fetch(`${ctx.baseUrl}/api/v1/delivery-challans/${dcId}/pdf`, {
    headers: { Origin: "http://localhost:5173", Cookie: ctx.tokens.teamLead },
  });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "application/pdf");
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");

  // There is no price column on a challan line to leak in the first place.
  const columns = await pool.query(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'delivery_challan_lines' AND column_name ILIKE '%price%'`,
  );
  assert.equal(columns.rowCount, 0);

  const detail = await apiRequest(ctx.baseUrl, "GET", `/api/v1/delivery-challans/${dcId}`, {
    token: ctx.tokens.teamLead,
  });
  const serialized = JSON.stringify(detail.body);
  assert.ok(!serialized.includes("48.00"), "the actual purchase price never appears on a Delivery Challan");
  assert.ok(!serialized.includes("estimated_unit_price"));

  const guardPdf = await apiRequest(ctx.baseUrl, "GET", `/api/v1/delivery-challans/${dcId}/pdf`, {
    token: ctx.tokens.guard,
  });
  assert.equal(guardPdf.status, 403);
});

test("Gate Pass remains a completely separate document domain", async () => {
  const { ipoId, ipoLines } = await purchasedChain("60");
  const { dcId } = await createFinalizedDc(ctx, ipoId, [{ ipoLineId: ipoLines[0].id, quantity: "5" }]);

  // No schema coupling: neither table references the other.
  const coupling = await pool.query(
    `SELECT tc.table_name, ccu.table_name AS references_table
     FROM information_schema.table_constraints tc
     JOIN information_schema.constraint_column_usage ccu ON ccu.constraint_name = tc.constraint_name
     WHERE tc.constraint_type = 'FOREIGN KEY'
       AND ((tc.table_name LIKE 'delivery_challan%' AND ccu.table_name LIKE 'gate_pass%')
         OR (tc.table_name LIKE 'gate_pass%' AND ccu.table_name LIKE 'delivery_challan%'))`,
  );
  assert.equal(coupling.rowCount, 0, "Delivery Challan and Gate Pass share no foreign key in either direction");

  // And a Delivery Challan id is not addressable through the Gate Pass API,
  // even for a user who genuinely holds Gate Pass view authority.
  const crossFetch = await apiRequest(ctx.baseUrl, "GET", `/api/v1/gate-passes/${dcId}`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(crossFetch.status, 404);
});

test("a Delivery Challan cannot be cancelled once material has been received against it", async () => {
  const { ipoId, ipoLines } = await purchasedChain("60");
  const { dcId, lines } = await createFinalizedDc(ctx, ipoId, [{ ipoLineId: ipoLines[0].id, quantity: "20" }]);

  const received = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/challans/${dcId}/receipts`, {
    token: ctx.tokens.teamLead,
    body: {
      operationId: randomUUID(), lines: [{ dcLineId: lines[0].id, receivedQuantity: "20" }] },
  });
  assert.equal(received.status, 201, JSON.stringify(received.body));

  const cancelled = await apiRequest(ctx.baseUrl, "POST", `/api/v1/delivery-challans/${dcId}/cancel`, {
    token: ctx.tokens.ceo,
    body: { reason: "Wrong department" },
  });
  assert.equal(cancelled.status, 409, "receiving history is never voided by a Procurement-side correction");
});

test("a retried Delivery Challan creation reuses the same challan and number", async () => {
  const { ipoId, ipoLines } = await purchasedChain("60");
  const operationId = randomUUID();
  const body = { operationId, ipoId, lines: [{ ipoLineId: ipoLines[0].id, quantity: "20" }] };

  const first = await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
    token: ctx.tokens.ceo,
    body,
  });
  assert.equal(first.status, 201);
  const dcId = first.body.data.deliveryChallan.id;

  // The response was lost; the client retries the identical request.
  const replay = await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
    token: ctx.tokens.ceo,
    body,
  });
  assert.equal(replay.status, 201);
  assert.equal(replay.body.data.deliveryChallan.id, dcId, "the same logical challan is returned");
  assert.equal(replay.body.data.deliveryChallan.dc_number, first.body.data.deliveryChallan.dc_number);

  const challans = await pool.query("SELECT count(*)::int AS n FROM delivery_challans WHERE ipo_id = $1", [ipoId]);
  assert.equal(challans.rows[0].n, 1, "no second challan and no second DC number");

  const allocated = await pool.query(
    `SELECT COALESCE(SUM(dcl.quantity), 0)::numeric(12,2) AS total
     FROM delivery_challan_lines dcl JOIN delivery_challans dc ON dc.id = dcl.dc_id
     WHERE dcl.ipo_line_id = $1 AND dc.status <> 'CANCELLED'`,
    [ipoLines[0].id],
  );
  assert.equal(allocated.rows[0].total, "20.00", "the retry allocated nothing further");

  // Two concurrent retries of the same operation still yield one challan.
  const raceOperation = randomUUID();
  const raceBody = { operationId: raceOperation, ipoId, lines: [{ ipoLineId: ipoLines[0].id, quantity: "10" }] };
  await Promise.all([
    apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", { token: ctx.tokens.ceo, body: raceBody }),
    apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", { token: ctx.tokens.ceo, body: raceBody }),
  ]);
  const afterRace = await pool.query("SELECT count(*)::int AS n FROM delivery_challans WHERE ipo_id = $1", [ipoId]);
  assert.equal(afterRace.rows[0].n, 2, "one original plus one from the raced retry pair");

  // A genuinely different shipment carries its own operation id.
  const separate = await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
    token: ctx.tokens.ceo,
    body: { operationId: randomUUID(), ipoId, lines: [{ ipoLineId: ipoLines[0].id, quantity: "10" }] },
  });
  assert.equal(separate.status, 201);
  assert.notEqual(separate.body.data.deliveryChallan.id, dcId);
});
