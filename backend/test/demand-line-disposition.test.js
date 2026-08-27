import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { clearOverride, setOverride, unique } from "./procurement-chain-helpers.js";

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
    employee: await authHeader(server.baseUrl, "employee@test.eset.local"),
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
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

// Takes a Demand all the way to PENDING_FINAL_APPROVAL, which is where
// management records line-level purchasing decisions.
async function pendingFinal({ quantities = [100, 20, 5], prices = ["50.00", "10.00", "4.00"] } = {}) {
  const entries = [];
  for (let index = 0; index < quantities.length; index += 1) {
    const response = await apiRequest(ctx.baseUrl, "POST", "/api/v1/material-catalog", {
      token: ctx.tokens.teamLead,
      body: { newItem: { name: unique("Disposition material") }, defaultUomId: uomId },
    });
    entries.push(response.body.data.id);
  }

  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: { lines: entries.map((catalogEntryId, index) => ({ catalogEntryId, quantity: quantities[index] })) },
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
  await apiRequest(ctx.baseUrl, "PUT", `/api/v1/procurement/pricing/${demandId}`, {
    token: ctx.tokens.ceo,
    body: {
      revision: 1,
      pricingVersion: 1,
      currency: "PKR",
      lines: pricing.body.data.lines.map((line, index) => ({
        demandLineId: line.demand_line_id,
        estimatedUnitPrice: prices[index],
      })),
    },
  });
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/procurement/pricing/${demandId}/submit`, {
    token: ctx.tokens.ceo,
    body: { revision: 1, pricingVersion: 1 },
  });

  const current = await apiRequest(ctx.baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, {
    token: ctx.tokens.ceo,
  });
  return { demandId, pricingId: current.body.data.pricing.id, lines: current.body.data.lines };
}

const setDispositions = (demandId, body, token) =>
  apiRequest(ctx.baseUrl, "PUT", `/api/v1/demands/${demandId}/line-dispositions`, { token, body });

test("an out-of-budget line is excluded from the IPO without deleting anything", async () => {
  const { demandId, pricingId, lines } = await pendingFinal();

  const excluded = await setDispositions(
    demandId,
    {
      pricingId,
      lines: [
        {
          demandLineId: lines[1].demand_line_id,
          disposition: "EXCLUDED",
          exclusionCategory: "OUT_OF_BUDGET",
          reason: "Deferred to next quarter",
        },
      ],
    },
    ctx.tokens.siteManager,
  );
  assert.equal(excluded.status, 200, JSON.stringify(excluded.body));

  // Nothing was destroyed: the Demand line, its quantity, its pricing line
  // and its estimate all survive intact.
  const demandLines = await pool.query(
    "SELECT count(*)::int AS n FROM material_demand_lines WHERE demand_id = $1",
    [demandId],
  );
  assert.equal(demandLines.rows[0].n, 3);
  const pricingLines = await pool.query(
    "SELECT count(*)::int AS n FROM material_demand_pricing_lines WHERE pricing_id = $1",
    [pricingId],
  );
  assert.equal(pricingLines.rows[0].n, 3);

  const stored = await pool.query(
    `SELECT disposition, exclusion_category, reason, requested_quantity_snapshot, estimated_unit_price_snapshot
     FROM material_demand_line_dispositions WHERE pricing_id = $1`,
    [pricingId],
  );
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].disposition, "EXCLUDED");
  assert.equal(stored.rows[0].exclusion_category, "OUT_OF_BUDGET");
  assert.equal(stored.rows[0].requested_quantity_snapshot, "20.00");
  assert.equal(stored.rows[0].estimated_unit_price_snapshot, "10.00");

  // The rest of the Demand proceeds through the final gate normally.
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-reviews`, {
      token: ctx.tokens.siteManager,
      body: { pricingId, decision: "APPROVED" },
    })).status,
    200,
  );
  const final = await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-approvals`, {
    token: ctx.tokens.ceo,
    body: { pricingId, decision: "APPROVED" },
  });
  assert.equal(final.status, 200);
  assert.equal(final.body.data.demand.status, "IPO_GENERATED");

  // Only approved-for-purchase lines reach the IPO, and the committed value
  // covers exactly those lines: 100*50.00 + 5*4.00 = 5020.00 (not 5220.00).
  const ipo = await pool.query("SELECT id, estimated_total FROM ipos WHERE demand_id = $1", [demandId]);
  assert.equal(ipo.rows[0].estimated_total, "5020.00");
  const ipoLines = await pool.query("SELECT count(*)::int AS n FROM ipo_lines WHERE ipo_id = $1", [
    ipo.rows[0].id,
  ]);
  assert.equal(ipoLines.rows[0].n, 2);
});

test("a CEO out-of-budget ruling after an earlier review invalidates that stale approval", async () => {
  const { demandId, pricingId, lines } = await pendingFinal();

  // The Site Manager records the final management review on the full set.
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-reviews`, {
      token: ctx.tokens.siteManager,
      body: { pricingId, decision: "APPROVED" },
    })).status,
    200,
  );

  // Only THEN does the CEO rule a line out of budget — the real business
  // sequence. It must be permitted, not blocked.
  const excluded = await setDispositions(
    demandId,
    {
      pricingId,
      lines: [
        { demandLineId: lines[1].demand_line_id, disposition: "EXCLUDED", exclusionCategory: "OUT_OF_BUDGET" },
      ],
    },
    ctx.tokens.ceo,
  );
  assert.equal(excluded.status, 200, JSON.stringify(excluded.body));

  // The Site Manager's approval is preserved, but it approved a DIFFERENT
  // purchasing set, so it no longer satisfies the gate: a formal approval now
  // must not complete the workflow on its own.
  const formal = await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-approvals`, {
    token: ctx.tokens.ceo,
    body: { pricingId, decision: "APPROVED" },
  });
  assert.equal(formal.status, 200);
  assert.equal(
    formal.body.data.demand.status,
    "PENDING_FINAL_APPROVAL",
    "a stale review cannot complete the gate for a set it never saw",
  );
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ipos WHERE demand_id = $1", [demandId])).rows[0].n, 0);

  // The Site Manager decides again on the NEW set — a new immutable row
  // alongside the old one, never an edit of it.
  const reReview = await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-reviews`, {
    token: ctx.tokens.siteManager,
    body: { pricingId, decision: "APPROVED" },
  });
  assert.equal(reReview.status, 200, JSON.stringify(reReview.body));
  assert.equal(reReview.body.data.demand.status, "IPO_GENERATED");

  const reviews = await pool.query(
    `SELECT disposition_fingerprint FROM material_demand_approvals
     WHERE demand_id = $1 AND approval_stage = 'FINAL' AND approval_type = 'MANAGEMENT_REVIEW'`,
    [demandId],
  );
  assert.equal(reviews.rowCount, 2, "both decisions are preserved");
  assert.equal(new Set(reviews.rows.map((row) => row.disposition_fingerprint)).size, 2);

  // The IPO contains exactly the set that was formally approved.
  const ipo = await pool.query("SELECT id FROM ipos WHERE demand_id = $1", [demandId]);
  const ipoLines = await pool.query(
    "SELECT demand_line_id FROM ipo_lines WHERE ipo_id = $1",
    [ipo.rows[0].id],
  );
  assert.equal(ipoLines.rowCount, 2);
  assert.ok(!ipoLines.rows.some((row) => row.demand_line_id === lines[1].demand_line_id));
});

test("the purchasing set freezes once the IPO has been generated", async () => {
  const { demandId, pricingId, lines } = await pendingFinal();

  await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-reviews`, {
    token: ctx.tokens.siteManager,
    body: { pricingId, decision: "APPROVED" },
  });
  const completed = await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-approvals`, {
    token: ctx.tokens.ceo,
    body: { pricingId, decision: "APPROVED" },
  });
  assert.equal(completed.body.data.demand.status, "IPO_GENERATED");

  // The set is now purchasing authority and cannot move underneath it.
  const late = await setDispositions(
    demandId,
    {
      pricingId,
      lines: [
        { demandLineId: lines[0].demand_line_id, disposition: "EXCLUDED", exclusionCategory: "OUT_OF_BUDGET" },
      ],
    },
    ctx.tokens.ceo,
  );
  assert.equal(late.status, 409);

  // The database enforces the same freeze independently of the service.
  await assert.rejects(
    pool.query(
      `INSERT INTO material_demand_line_dispositions
         (demand_id, revision, pricing_id, demand_line_id, disposition, exclusion_category,
          requested_quantity_snapshot, estimated_unit_price_snapshot, actor_user_id)
       VALUES ($1, 1, $2, $3, 'EXCLUDED', 'OUT_OF_BUDGET', 1, 1, $4)`,
      [demandId, pricingId, lines[0].demand_line_id, users.ceo],
    ),
    /frozen once an IPO has been generated/,
  );
});

test("a formal approval and a concurrent out-of-budget ruling cannot disagree about the IPO", async () => {
  const { demandId, pricingId, lines } = await pendingFinal();

  await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-reviews`, {
    token: ctx.tokens.siteManager,
    body: { pricingId, decision: "APPROVED" },
  });

  // The CFO approves at the same moment the CEO excludes a line.
  const [formal, exclusion] = await Promise.all([
    apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-approvals`, {
      token: ctx.tokens.ceo,
      body: { pricingId, decision: "APPROVED" },
    }),
    setDispositions(
      demandId,
      {
        pricingId,
        lines: [
          { demandLineId: lines[1].demand_line_id, disposition: "EXCLUDED", exclusionCategory: "OUT_OF_BUDGET" },
        ],
      },
      ctx.tokens.siteManager,
    ),
  ]);

  assert.ok([200, 409].includes(formal.status));
  assert.ok([200, 409].includes(exclusion.status));

  // Whatever the interleaving, an IPO — if one exists at all — contains
  // exactly the set that a complete pair of matching approvals authorized.
  const ipo = await pool.query("SELECT id, pricing_id FROM ipos WHERE demand_id = $1", [demandId]);
  if (ipo.rowCount === 0) return;

  const ipoLineIds = (
    await pool.query("SELECT demand_line_id FROM ipo_lines WHERE ipo_id = $1", [ipo.rows[0].id])
  ).rows.map((row) => row.demand_line_id);

  const dispositions = await pool.query(
    `SELECT demand_line_id, disposition FROM material_demand_line_dispositions WHERE pricing_id = $1`,
    [pricingId],
  );
  const excludedIds = dispositions.rows
    .filter((row) => row.disposition === "EXCLUDED")
    .map((row) => row.demand_line_id);

  for (const excludedId of excludedIds) {
    assert.ok(
      !ipoLineIds.includes(excludedId),
      "an excluded line can never appear on the generated IPO",
    );
  }

  const approvals = await pool.query(
    `SELECT approval_type, disposition_fingerprint FROM material_demand_approvals
     WHERE demand_id = $1 AND approval_stage = 'FINAL' AND decision = 'APPROVED'`,
    [demandId],
  );
  const fingerprints = approvals.rows.map((row) => row.disposition_fingerprint);
  const management = approvals.rows.filter((row) => row.approval_type === "MANAGEMENT_REVIEW");
  const formalRows = approvals.rows.filter((row) => row.approval_type === "FORMAL_APPROVAL");
  assert.ok(
    management.some((m) => formalRows.some((f) => f.disposition_fingerprint === m.disposition_fingerprint)),
    "the IPO exists only because both responsibilities approved the SAME set",
  );
  assert.ok(fingerprints.length >= 2);
});

test("excluding every line is refused — that is a rejection, not a purchasing decision", async () => {
  const { demandId, pricingId, lines } = await pendingFinal();

  const all = await setDispositions(
    demandId,
    {
      pricingId,
      lines: lines.map((line) => ({
        demandLineId: line.demand_line_id,
        disposition: "EXCLUDED",
        exclusionCategory: "OUT_OF_BUDGET",
      })),
    },
    ctx.tokens.ceo,
  );
  assert.equal(all.status, 400);

  const stored = await pool.query(
    "SELECT count(*)::int AS n FROM material_demand_line_dispositions WHERE pricing_id = $1",
    [pricingId],
  );
  assert.equal(stored.rows[0].n, 0, "the whole request rolls back, leaving no partial decision");
});

test("line dispositions require management responsibility AND price visibility", async () => {
  const { demandId, pricingId, lines } = await pendingFinal();
  const body = {
    pricingId,
    lines: [{ demandLineId: lines[1].demand_line_id, disposition: "EXCLUDED", exclusionCategory: "OUT_OF_BUDGET" }],
  };

  // No management responsibility at all.
  assert.equal((await setDispositions(demandId, body, ctx.tokens.teamLead)).status, 403);
  assert.equal((await setDispositions(demandId, body, ctx.tokens.employee)).status, 403);
  assert.equal((await setDispositions(demandId, body, ctx.tokens.admin)).status, 403);

  // Holds demand.review but is denied price visibility — an out-of-budget
  // decision is a decision about a price.
  await setOverride(users.siteManager, "procurement.view_prices", "DENY", users.ceo);
  try {
    assert.equal((await setDispositions(demandId, body, ctx.tokens.siteManager)).status, 403);
  } finally {
    await clearOverride(users.siteManager, "procurement.view_prices");
  }

  assert.equal((await setDispositions(demandId, body, ctx.tokens.siteManager)).status, 200);
});

test("the department sees that a line was excluded, but not the financial explanation", async () => {
  const { demandId, pricingId, lines } = await pendingFinal();
  await setDispositions(
    demandId,
    {
      pricingId,
      lines: [
        {
          demandLineId: lines[1].demand_line_id,
          disposition: "EXCLUDED",
          exclusionCategory: "OUT_OF_BUDGET",
          reason: "Budget ceiling reached for this quarter",
        },
      ],
    },
    ctx.tokens.siteManager,
  );

  const asDepartment = await apiRequest(ctx.baseUrl, "GET", `/api/v1/demands/${demandId}`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(asDepartment.status, 200);
  const disposition = asDepartment.body.data.dispositions[0];
  // The category is operational context the department needs in order to
  // decide whether to carry the line forward.
  assert.equal(disposition.disposition, "EXCLUDED");
  assert.equal(disposition.exclusion_category, "OUT_OF_BUDGET");
  // The free-text financial explanation and the estimate are not.
  assert.equal(disposition.reason, null);
  assert.equal(disposition.estimated_unit_price_snapshot, undefined);
  assert.ok(!JSON.stringify(asDepartment.body).includes("Budget ceiling reached"));

  const asManagement = await apiRequest(ctx.baseUrl, "GET", `/api/v1/demands/${demandId}`, {
    token: ctx.tokens.siteManager,
  });
  assert.equal(asManagement.body.data.dispositions[0].reason, "Budget ceiling reached for this quarter");
});

test("an excluded line becomes a carry-forward candidate for the department's next Demand", async () => {
  const { demandId, pricingId, lines } = await pendingFinal();
  const excludedLineId = lines[1].demand_line_id;

  await setDispositions(
    demandId,
    {
      pricingId,
      lines: [{ demandLineId: excludedLineId, disposition: "EXCLUDED", exclusionCategory: "OUT_OF_BUDGET" }],
    },
    ctx.tokens.siteManager,
  );
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-reviews`, {
    token: ctx.tokens.siteManager,
    body: { pricingId, decision: "APPROVED" },
  });
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-approvals`, {
    token: ctx.tokens.ceo,
    body: { pricingId, decision: "APPROVED" },
  });

  const catalogEntryId = (
    await pool.query("SELECT catalog_entry_id FROM material_demand_lines WHERE id = $1", [excludedLineId])
  ).rows[0].catalog_entry_id;

  const outstanding = await apiRequest(
    ctx.baseUrl,
    "GET",
    `/api/v1/ipos/outstanding?catalogEntryIds=${catalogEntryId}`,
    { token: ctx.tokens.teamLead },
  );
  assert.equal(outstanding.status, 200, JSON.stringify(outstanding.body));
  const candidate = outstanding.body.data.find((row) => row.demand_id === demandId);
  assert.ok(candidate, "the unfunded line is offered back to the department");
  assert.equal(candidate.source_type, "OUT_OF_BUDGET");
  assert.equal(candidate.exclusion_category, "OUT_OF_BUDGET");
  assert.equal(candidate.source_quantity, "20.00");
  assert.equal(candidate.available_quantity, "20.00");
  assert.equal(candidate.allocated_quantity, "0.00");
  assert.equal(candidate.demand_number, (await pool.query(
    "SELECT demand_number FROM material_demands WHERE id = $1",
    [demandId],
  )).rows[0].demand_number);

  // Surfacing a candidate is strictly read-only: it must never create a
  // Demand, and it must never alter the exclusion decision it reports.
  const countDemands = async () =>
    (await pool.query("SELECT count(*)::int AS n FROM material_demands")).rows[0].n;
  const before = await countDemands();
  await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/outstanding?catalogEntryIds=${catalogEntryId}`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(await countDemands(), before);

  const untouched = await pool.query(
    "SELECT disposition, exclusion_category FROM material_demand_line_dispositions WHERE demand_line_id = $1",
    [excludedLineId],
  );
  assert.equal(untouched.rows[0].disposition, "EXCLUDED");
  assert.equal(untouched.rows[0].exclusion_category, "OUT_OF_BUDGET");
});

test("dispositions can only be recorded while the Demand is pending final approval", async () => {
  const { demandId, pricingId, lines } = await pendingFinal();
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-reviews`, {
    token: ctx.tokens.siteManager,
    body: { pricingId, decision: "REJECTED", reason: "Reprice line 1" },
  });

  const afterRejection = await setDispositions(
    demandId,
    {
      pricingId,
      lines: [{ demandLineId: lines[0].demand_line_id, disposition: "EXCLUDED", exclusionCategory: "DUPLICATE" }],
    },
    ctx.tokens.ceo,
  );
  assert.equal(afterRejection.status, 409);
});
