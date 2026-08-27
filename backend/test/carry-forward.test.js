import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { buildApprovedIpo, createFinalizedDc, recordPurchase, unique } from "./procurement-chain-helpers.js";

let ctx;
let users;
let uomId;

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
  uomId = uoms.body.data[0].id;
  ctx = { baseUrl: server.baseUrl, tokens, close: server.close };
});

after(async () => {
  await ctx.close();
});

// Builds a chain that ends with a real, closed shortfall of 40 on line one.
async function shortfallOf40() {
  const built = await buildApprovedIpo(ctx, { uomId, quantities: [100, 20] });
  assert.equal(
    (await recordPurchase(ctx, built.ipoId, [
      { ipoLineId: built.ipoLines[0].id, quantity: "60", actualUnitPrice: "48.00" },
    ])).status,
    200,
  );
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${built.ipoId}/close-purchasing`, {
      token: ctx.tokens.ceo,
    })).status,
    200,
  );

  const catalogEntryId = (
    await pool.query(
      `SELECT mdl.catalog_entry_id FROM ipo_lines il
       JOIN material_demand_lines mdl ON mdl.id = il.demand_line_id WHERE il.id = $1`,
      [built.ipoLines[0].id],
    )
  ).rows[0].catalog_entry_id;

  return { ...built, catalogEntryId, sourceId: built.ipoLines[0].id };
}

const outstandingFor = (catalogEntryId, token) =>
  apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/outstanding?catalogEntryIds=${catalogEntryId}`, { token });

// Creates a Demand that carries `quantity` from `sourceId`, then submits it.
async function carryForward(catalogEntryId, sourceId, quantity, { sourceType = "UNPURCHASED_IPO_QUANTITY" } = {}) {
  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: {
      lines: [
        {
          catalogEntryId,
          quantity: Number(quantity),
          carryForward: { sourceType, sourceId, quantity: Number(quantity) },
        },
      ],
    },
  });
  if (created.status !== 201) return { created, submitted: null };

  const submitted = await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${created.body.data.demand.id}/submit`, {
    token: ctx.tokens.teamLead,
  });
  return { created, submitted, demandId: created.body.data.demand.id };
}

test("a carried quantity is claimed against its source and reduces what remains", async () => {
  const { catalogEntryId, sourceId } = await shortfallOf40();

  const before = await outstandingFor(catalogEntryId, ctx.tokens.teamLead);
  const source = before.body.data.find((row) => row.source_id === sourceId);
  assert.ok(source);
  assert.equal(source.source_quantity, "40.00");
  assert.equal(source.available_quantity, "40.00");

  const { submitted, demandId } = await carryForward(catalogEntryId, sourceId, "25");
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));

  // The claim is persisted with authoritative source linkage.
  const allocation = await pool.query(
    `SELECT source_type, source_ipo_line_id, source_quantity, allocated_quantity, status, target_demand_id
     FROM carry_forward_allocations WHERE target_demand_id = $1`,
    [demandId],
  );
  assert.equal(allocation.rowCount, 1);
  assert.equal(allocation.rows[0].source_type, "UNPURCHASED_IPO_QUANTITY");
  assert.equal(allocation.rows[0].source_ipo_line_id, sourceId);
  assert.equal(allocation.rows[0].source_quantity, "40.00");
  assert.equal(allocation.rows[0].allocated_quantity, "25.00");
  assert.equal(allocation.rows[0].status, "ACTIVE");

  // What remains available reflects the claim.
  const after = await outstandingFor(catalogEntryId, ctx.tokens.teamLead);
  const remaining = after.body.data.find((row) => row.source_id === sourceId);
  assert.equal(remaining.source_quantity, "40.00", "the original shortfall is unchanged");
  assert.equal(remaining.allocated_quantity, "25.00");
  assert.equal(remaining.available_quantity, "15.00");

  // The source IPO itself was not altered by any of this.
  const ipoLine = await pool.query(
    "SELECT approved_quantity, purchased_quantity FROM ipo_lines WHERE id = $1",
    [sourceId],
  );
  assert.deepEqual(ipoLine.rows[0], { approved_quantity: "100.00", purchased_quantity: "60.00" });
});

test("the same outstanding quantity cannot be carried into several Demands", async () => {
  const { catalogEntryId, sourceId } = await shortfallOf40();

  assert.equal((await carryForward(catalogEntryId, sourceId, "40")).submitted.status, 200);

  // A second Demand tries to carry the very same 40.
  const second = await carryForward(catalogEntryId, sourceId, "40");
  assert.equal(second.submitted.status, 409, "the quantity was already claimed");

  // And a third, for even a single unit.
  const third = await carryForward(catalogEntryId, sourceId, "1");
  assert.equal(third.submitted.status, 409);

  const claimed = await pool.query(
    `SELECT COALESCE(SUM(allocated_quantity), 0)::numeric(12,2) AS total
     FROM carry_forward_allocations WHERE source_ipo_line_id = $1 AND status = 'ACTIVE'`,
    [sourceId],
  );
  assert.equal(claimed.rows[0].total, "40.00", "never more than the source held");

  // The database refuses over-allocation independently of the service.
  const demand = await pool.query("SELECT id, department_id, site_id FROM material_demands LIMIT 1");
  const line = await pool.query("SELECT id FROM material_demand_lines WHERE demand_id = $1 LIMIT 1", [
    demand.rows[0].id,
  ]);
  await assert.rejects(
    pool.query(
      `INSERT INTO carry_forward_allocations
         (source_type, source_ipo_line_id, department_id, site_id, source_quantity, allocated_quantity,
          target_demand_id, target_demand_line_id, created_by_user_id)
       VALUES ('UNPURCHASED_IPO_QUANTITY', $1, $2, $3, 40, 5, $4, $5, $6)`,
      [sourceId, demand.rows[0].department_id, demand.rows[0].site_id, demand.rows[0].id, line.rows[0].id, users.ceo],
    ),
    /exceeds the quantity still available/,
  );
});

test("concurrent Demands cannot both claim the last remaining quantity", async () => {
  const { catalogEntryId, sourceId } = await shortfallOf40();

  // Two Demands, each drafted for 30 of the same 40, submitted simultaneously.
  const a = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: {
      lines: [
        { catalogEntryId, quantity: 30, carryForward: { sourceType: "UNPURCHASED_IPO_QUANTITY", sourceId, quantity: 30 } },
      ],
    },
  });
  const b = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: {
      lines: [
        { catalogEntryId, quantity: 30, carryForward: { sourceType: "UNPURCHASED_IPO_QUANTITY", sourceId, quantity: 30 } },
      ],
    },
  });
  assert.equal(a.status, 201);
  assert.equal(b.status, 201);

  const [first, second] = await Promise.all([
    apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${a.body.data.demand.id}/submit`, { token: ctx.tokens.teamLead }),
    apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${b.body.data.demand.id}/submit`, { token: ctx.tokens.teamLead }),
  ]);

  const succeeded = [first, second].filter((response) => response.status === 200);
  assert.equal(succeeded.length, 1, "30 + 30 cannot both come out of 40");

  const claimed = await pool.query(
    `SELECT COALESCE(SUM(allocated_quantity), 0)::numeric(12,2) AS total
     FROM carry_forward_allocations WHERE source_ipo_line_id = $1 AND status = 'ACTIVE'`,
    [sourceId],
  );
  assert.equal(claimed.rows[0].total, "30.00");
});

test("a rejected Demand releases its claim back to the pool", async () => {
  const { catalogEntryId, sourceId } = await shortfallOf40();
  const { demandId, submitted } = await carryForward(catalogEntryId, sourceId, "40");
  assert.equal(submitted.status, 200);

  let available = (await outstandingFor(catalogEntryId, ctx.tokens.teamLead)).body.data.find(
    (row) => row.source_id === sourceId,
  );
  assert.equal(available, undefined, "nothing remains while the claim is active");

  // The request is rejected at the initial gate.
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/reviews`, {
      token: ctx.tokens.siteManager,
      body: { decision: "REJECTED", reason: "Not needed after all" },
    })).status,
    200,
  );

  available = (await outstandingFor(catalogEntryId, ctx.tokens.teamLead)).body.data.find(
    (row) => row.source_id === sourceId,
  );
  assert.ok(available, "the quantity is claimable again");
  assert.equal(available.available_quantity, "40.00");

  // The released claim is kept as history, not deleted.
  const released = await pool.query(
    "SELECT status, released_at FROM carry_forward_allocations WHERE target_demand_id = $1",
    [demandId],
  );
  assert.equal(released.rows[0].status, "RELEASED");
  assert.ok(released.rows[0].released_at);
});

test("an abandoned draft never holds any quantity", async () => {
  const { catalogEntryId, sourceId } = await shortfallOf40();

  // Drafted but never submitted.
  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: {
      lines: [
        { catalogEntryId, quantity: 40, carryForward: { sourceType: "UNPURCHASED_IPO_QUANTITY", sourceId, quantity: 40 } },
      ],
    },
  });
  assert.equal(created.status, 201);

  const available = (await outstandingFor(catalogEntryId, ctx.tokens.teamLead)).body.data.find(
    (row) => row.source_id === sourceId,
  );
  assert.equal(available.available_quantity, "40.00", "a draft reserves nothing");
  const allocations = await pool.query(
    "SELECT count(*)::int AS n FROM carry_forward_allocations WHERE target_demand_id = $1",
    [created.body.data.demand.id],
  );
  assert.equal(allocations.rows[0].n, 0);
});

test("a confirmed receiving shortage is its own carry-forward source, distinct from unpurchased quantity", async () => {
  const built = await buildApprovedIpo(ctx, { uomId, quantities: [100, 20] });
  // Everything approved is purchased, so there is NO unpurchased shortfall.
  assert.equal(
    (await recordPurchase(ctx, built.ipoId, [
      { ipoLineId: built.ipoLines[0].id, quantity: "100", actualUnitPrice: "48.00" },
    ])).status,
    200,
  );
  const dc = await createFinalizedDc(ctx, built.ipoId, [{ ipoLineId: built.ipoLines[0].id, quantity: "100" }]);

  // 60 arrive; 40 are short.
  const received = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/challans/${dc.dcId}/receipts`, {
    token: ctx.tokens.teamLead,
    body: {
      operationId: randomUUID(),
      lines: [
        {
          dcLineId: dc.lines[0].id,
          receivedQuantity: "60",
          discrepancyQuantity: "40",
          discrepancyType: "SHORT",
          discrepancyNote: "Supplier delivered short",
        },
      ],
    },
  });
  assert.equal(received.status, 201, JSON.stringify(received.body));
  const receiptId = received.body.data.receipt.id;

  const catalogEntryId = (
    await pool.query(
      `SELECT mdl.catalog_entry_id FROM ipo_lines il
       JOIN material_demand_lines mdl ON mdl.id = il.demand_line_id WHERE il.id = $1`,
      [built.ipoLines[0].id],
    )
  ).rows[0].catalog_entry_id;

  // Not yet confirmed: the shortage is still under review, so not claimable.
  let sources = (await outstandingFor(catalogEntryId, ctx.tokens.teamLead)).body.data;
  assert.ok(!sources.some((row) => row.source_type === "RECEIVING_SHORTAGE"));

  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/confirm`, {
      token: ctx.tokens.teamLead,
    })).status,
    200,
  );

  sources = (await outstandingFor(catalogEntryId, ctx.tokens.teamLead)).body.data;
  const shortage = sources.find((row) => row.source_type === "RECEIVING_SHORTAGE");
  assert.ok(shortage, "a confirmed shortage becomes claimable");
  assert.equal(shortage.source_quantity, "40.00");
  assert.equal(shortage.available_quantity, "40.00");
  assert.equal(shortage.discrepancy_type, "SHORT");

  // Crucially: the same 40 does NOT also appear as unpurchased quantity —
  // everything approved was bought, so the two source types cannot overlap.
  assert.ok(
    !sources.some((row) => row.source_type === "UNPURCHASED_IPO_QUANTITY" && row.ipo_id === built.ipoId),
    "a shortage is never double-counted as unpurchased quantity",
  );

  // It claims like any other source.
  const { submitted } = await carryForward(catalogEntryId, shortage.source_id, "40", {
    sourceType: "RECEIVING_SHORTAGE",
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  const after = (await outstandingFor(catalogEntryId, ctx.tokens.teamLead)).body.data.find(
    (row) => row.source_type === "RECEIVING_SHORTAGE",
  );
  assert.equal(after, undefined);
});

test("an exclusion on a pricing version that never became authority is not a carry-forward source", async () => {
  // A Demand whose FINAL gate was rejected: management review approved, formal
  // approval rejected. Its exclusions were never purchasing authority.
  const entryA = await apiRequest(ctx.baseUrl, "POST", "/api/v1/material-catalog", {
    token: ctx.tokens.teamLead,
    body: { newItem: { name: unique("Rejected gate material") }, defaultUomId: uomId },
  });
  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: { lines: [{ catalogEntryId: entryA.body.data.id, quantity: 10 }] },
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
  const pricingDetail = await apiRequest(ctx.baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, {
    token: ctx.tokens.ceo,
  });
  await apiRequest(ctx.baseUrl, "PUT", `/api/v1/procurement/pricing/${demandId}`, {
    token: ctx.tokens.ceo,
    body: {
      revision: 1,
      pricingVersion: 1,
      currency: "PKR",
      lines: [{ demandLineId: pricingDetail.body.data.lines[0].demand_line_id, estimatedUnitPrice: "9.00" }],
    },
  });
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/procurement/pricing/${demandId}/submit`, {
    token: ctx.tokens.ceo,
    body: { revision: 1, pricingVersion: 1 },
  });
  const current = await apiRequest(ctx.baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, {
    token: ctx.tokens.ceo,
  });
  const pricingId = current.body.data.pricing.id;

  // Management review APPROVES, formal approval REJECTS — an incomplete gate.
  await apiRequest(ctx.baseUrl, "PUT", `/api/v1/demands/${demandId}/line-dispositions`, {
    token: ctx.tokens.siteManager,
    body: {
      pricingId,
      lines: [
        {
          demandLineId: pricingDetail.body.data.lines[0].demand_line_id,
          disposition: "EXCLUDED",
          exclusionCategory: "OUT_OF_BUDGET",
        },
      ],
    },
  });
  // Excluding the only line is refused outright, which is itself the point:
  // an incomplete gate can never produce an authoritative exclusion.
  const dispositions = await pool.query(
    "SELECT count(*)::int AS n FROM material_demand_line_dispositions WHERE pricing_id = $1",
    [pricingId],
  );
  assert.equal(dispositions.rows[0].n, 0);

  // No IPO was generated, so nothing from this Demand is claimable.
  const sources = await outstandingFor(entryA.body.data.id, ctx.tokens.teamLead);
  assert.equal(sources.status, 200);
  assert.equal(
    sources.body.data.filter((row) => row.demand_id === demandId).length,
    0,
    "a pricing version that never became purchasing authority yields no carry-forward source",
  );
});

test("carry-forward is department- and site-scoped", async () => {
  const { catalogEntryId, sourceId } = await shortfallOf40();

  // Another department's lead sees nothing of this department's shortfall.
  const otherDepartment = await outstandingFor(catalogEntryId, ctx.tokens.teamLeadOtherDept);
  assert.equal(otherDepartment.status, 200);
  assert.equal(otherDepartment.body.data.length, 0);

  const otherSite = await outstandingFor(catalogEntryId, ctx.tokens.otherSiteTeamLead);
  assert.equal(otherSite.status, 200);
  assert.equal(otherSite.body.data.length, 0);

  // And cannot claim it even knowing the source id: the catalogue entry does
  // not belong to their department, so the line itself is refused.
  const attempt = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLeadOtherDept,
    body: {
      lines: [
        { catalogEntryId, quantity: 10, carryForward: { sourceType: "UNPURCHASED_IPO_QUANTITY", sourceId, quantity: 10 } },
      ],
    },
  });
  assert.equal(attempt.status, 400);
});

test("a Draft's source survives save, reopen, edit and save, then claims exactly once", async () => {
  const { catalogEntryId, sourceId } = await shortfallOf40();

  // Step 1 — a Draft carrying 40 from the outstanding source.
  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: {
      note: "original note",
      lines: [
        {
          catalogEntryId,
          quantity: 40,
          carryForward: { sourceType: "UNPURCHASED_IPO_QUANTITY", sourceId, quantity: 40 },
        },
      ],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const demandId = created.body.data.demand.id;

  // A Draft states intent; it reserves nothing yet.
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM carry_forward_allocations WHERE target_demand_id = $1", [demandId]))
      .rows[0].n,
    0,
  );

  // Step 2 — reopen. The Draft must hand the source back to the editor.
  const reopened = await apiRequest(ctx.baseUrl, "GET", `/api/v1/demands/${demandId}`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(reopened.status, 200);
  const reopenedLine = reopened.body.data.lines[0];
  assert.equal(reopenedLine.carry_forward_source_type, "UNPURCHASED_IPO_QUANTITY");
  assert.equal(reopenedLine.carry_forward_source_id, sourceId);
  assert.equal(reopenedLine.carry_forward_quantity, "40.00");

  // Step 3 — edit: an unrelated note, and a smaller carried quantity. This is
  // exactly the payload the repaired form now produces from that response.
  const edited = await apiRequest(ctx.baseUrl, "PATCH", `/api/v1/demands/${demandId}`, {
    token: ctx.tokens.teamLead,
    body: {
      note: "revised note",
      lines: [
        {
          catalogEntryId: reopenedLine.catalog_entry_id,
          quantity: 25,
          carryForward: {
            sourceType: reopenedLine.carry_forward_source_type,
            sourceId: reopenedLine.carry_forward_source_id,
            quantity: 25,
          },
        },
      ],
    },
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.body));

  const afterEdit = await apiRequest(ctx.baseUrl, "GET", `/api/v1/demands/${demandId}`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(afterEdit.body.data.demand.note, "revised note");
  assert.equal(afterEdit.body.data.lines[0].carry_forward_source_id, sourceId, "the source survived the edit");
  assert.equal(afterEdit.body.data.lines[0].carry_forward_quantity, "25.00");
  // Still nothing reserved while it remains a Draft.
  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM carry_forward_allocations WHERE target_demand_id = $1", [demandId]))
      .rows[0].n,
    0,
  );

  // Step 4 — submit. Now, and only now, the claim becomes authoritative.
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/submit`, { token: ctx.tokens.teamLead }))
      .status,
    200,
  );

  const allocations = await pool.query(
    `SELECT source_type, source_ipo_line_id, allocated_quantity, status
     FROM carry_forward_allocations WHERE target_demand_id = $1`,
    [demandId],
  );
  assert.equal(allocations.rowCount, 1, "exactly one allocation — not zero, and not a duplicate");
  assert.equal(allocations.rows[0].source_type, "UNPURCHASED_IPO_QUANTITY");
  assert.equal(allocations.rows[0].source_ipo_line_id, sourceId);
  assert.equal(allocations.rows[0].allocated_quantity, "25.00");
  assert.equal(allocations.rows[0].status, "ACTIVE");

  // The edited-down remainder is genuinely still available, and no more.
  const remaining = (await outstandingFor(catalogEntryId, ctx.tokens.teamLead)).body.data.find(
    (row) => row.source_id === sourceId,
  );
  assert.equal(remaining.available_quantity, "15.00");

  // And the source cannot now be over-claimed by a second Demand.
  assert.equal((await carryForward(catalogEntryId, sourceId, "16")).submitted.status, 409);
  assert.equal((await carryForward(catalogEntryId, sourceId, "15")).submitted.status, 200);
});

test("a Draft that drops its carry-forward line claims nothing on submission", async () => {
  const { catalogEntryId, sourceId } = await shortfallOf40();

  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: {
      lines: [
        {
          catalogEntryId,
          quantity: 40,
          carryForward: { sourceType: "UNPURCHASED_IPO_QUANTITY", sourceId, quantity: 40 },
        },
      ],
    },
  });
  const demandId = created.body.data.demand.id;

  // The user removes the carried line and asks for the material afresh.
  assert.equal(
    (await apiRequest(ctx.baseUrl, "PATCH", `/api/v1/demands/${demandId}`, {
      token: ctx.tokens.teamLead,
      body: { lines: [{ catalogEntryId, quantity: 12 }] },
    })).status,
    200,
  );
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/submit`, { token: ctx.tokens.teamLead }))
      .status,
    200,
  );

  assert.equal(
    (await pool.query("SELECT count(*)::int AS n FROM carry_forward_allocations WHERE target_demand_id = $1", [demandId]))
      .rows[0].n,
    0,
    "an ordinary line claims nothing",
  );
  // The whole 40 is therefore still available to whoever needs it.
  const remaining = (await outstandingFor(catalogEntryId, ctx.tokens.teamLead)).body.data.find(
    (row) => row.source_id === sourceId,
  );
  assert.equal(remaining.available_quantity, "40.00");
});

test("a restored source is still re-validated server-side, never trusted", async () => {
  const { catalogEntryId } = await shortfallOf40();

  // Another department's outstanding source, discovered independently.
  const foreign = await buildApprovedIpo(ctx, { uomId, quantities: [50], creatorToken: ctx.tokens.teamLeadOtherDept });
  await recordPurchase(ctx, foreign.ipoId, [
    { ipoLineId: foreign.ipoLines[0].id, quantity: "10", actualUnitPrice: "5.00" },
  ]);
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${foreign.ipoId}/close-purchasing`, { token: ctx.tokens.ceo });

  // A tampered client sends its own catalogue entry with the OTHER
  // department's source id. Restored form state is intent, never authority.
  const tampered = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: {
      lines: [
        {
          catalogEntryId,
          quantity: 10,
          carryForward: {
            sourceType: "UNPURCHASED_IPO_QUANTITY",
            sourceId: foreign.ipoLines[0].id,
            quantity: 10,
          },
        },
      ],
    },
  });
  assert.ok([400, 404].includes(tampered.status), `cross-department source accepted (${tampered.status})`);

  const stolen = await pool.query(
    "SELECT count(*)::int AS n FROM carry_forward_allocations WHERE source_ipo_line_id = $1",
    [foreign.ipoLines[0].id],
  );
  assert.equal(stolen.rows[0].n, 0);
});
