import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import pool from "../src/config/database.js";
import { findIpoSignoffs } from "../src/modules/ipo/ipo.repository.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { clearOverride, setOverride, unique } from "./procurement-chain-helpers.js";

// An IPO's signoffs must name the people who approved the purchasing set the
// IPO actually contains. A decision taken on a DIFFERENT set — before the CEO
// ruled a line out of budget — is real, immutable history, but it is not a
// signature on this document.

let ctx;
let users;
let uomId;

before(async () => {
  const server = await startTestServer();
  users = await seedUsers();
  const tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    upperManagement: await authHeader(server.baseUrl, "um@test.eset.local"),
    hr: await authHeader(server.baseUrl, "hr@test.eset.local"),
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

// Takes a Demand to PENDING_FINAL_APPROVAL with three priced lines.
async function pendingFinal() {
  const entries = [];
  for (let index = 0; index < 3; index += 1) {
    const entry = await apiRequest(ctx.baseUrl, "POST", "/api/v1/material-catalog", {
      token: ctx.tokens.teamLead,
      body: { newItem: { name: unique("Signoff material") }, defaultUomId: uomId },
    });
    entries.push(entry.body.data.id);
  }

  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: { lines: entries.map((catalogEntryId, i) => ({ catalogEntryId, quantity: [100, 20, 5][i] })) },
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
      lines: pricing.body.data.lines.map((line, i) => ({
        demandLineId: line.demand_line_id,
        estimatedUnitPrice: ["50.00", "10.00", "4.00"][i],
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

const finalReview = (demandId, pricingId, token) =>
  apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-reviews`, {
    token,
    body: { pricingId, decision: "APPROVED" },
  });

const finalApproval = (demandId, pricingId, token) =>
  apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-approvals`, {
    token,
    body: { pricingId, decision: "APPROVED" },
  });

const exclude = (demandId, pricingId, demandLineId, token) =>
  apiRequest(ctx.baseUrl, "PUT", `/api/v1/demands/${demandId}/line-dispositions`, {
    token,
    body: {
      pricingId,
      lines: [{ demandLineId, disposition: "EXCLUDED", exclusionCategory: "OUT_OF_BUDGET" }],
    },
  });

const ipoFor = async (demandId) =>
  (await pool.query("SELECT id, pricing_id, disposition_fingerprint FROM ipos WHERE demand_id = $1", [demandId]))
    .rows[0];

function contentStreamOf(buffer) {
  const raw = buffer.toString("latin1");
  const pattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let text = "";
  let match;
  while ((match = pattern.exec(raw))) {
    try {
      text += zlib.inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
    } catch {
      // Embedded font program, not page content.
    }
  }
  return text;
}

test("A — a straightforward IPO carries exactly its two authorizing signoffs", async () => {
  const { demandId, pricingId } = await pendingFinal();
  assert.equal((await finalReview(demandId, pricingId, ctx.tokens.siteManager)).status, 200);
  assert.equal((await finalApproval(demandId, pricingId, ctx.tokens.ceo)).status, 200);

  const ipo = await ipoFor(demandId);
  assert.match(ipo.disposition_fingerprint, /^[0-9a-f]{64}$/);

  const signoffs = await findIpoSignoffs(pool, ipo.id);
  assert.equal(signoffs.length, 2);
  assert.deepEqual(
    signoffs.map((s) => [s.approval_type, s.actor_name]).sort(),
    [["FORMAL_APPROVAL", "Test CEO"], ["MANAGEMENT_REVIEW", "Test Manager"]],
  );
});

test("B — a superseded approval is never presented as a signoff on the IPO", async () => {
  const { demandId, pricingId, lines } = await pendingFinal();

  // The Site Manager approves the FULL set (fingerprint A)...
  assert.equal((await finalReview(demandId, pricingId, ctx.tokens.siteManager)).status, 200);
  // ...then the CEO rules a line out of budget, producing fingerprint B.
  assert.equal((await exclude(demandId, pricingId, lines[1].demand_line_id, ctx.tokens.ceo)).status, 200);

  // A different manager approves the NEW set, and the CFO signs it off.
  await setOverride(users.upperManagement, "procurement.view_prices", "GRANT", users.ceo);
  await setOverride(users.hr, "demand.approve", "GRANT", users.ceo);
  await setOverride(users.hr, "procurement.view_prices", "GRANT", users.ceo);
  try {
    assert.equal((await finalReview(demandId, pricingId, ctx.tokens.upperManagement)).status, 200);
    const completed = await finalApproval(demandId, pricingId, ctx.tokens.hr);
    assert.equal(completed.status, 200, JSON.stringify(completed.body));
    assert.equal(completed.body.data.demand.status, "IPO_GENERATED");

    const ipo = await ipoFor(demandId);

    // Three approved FINAL decisions exist in history for this Pricing
    // version — but only two of them authorized this IPO.
    const history = await pool.query(
      `SELECT approval_type, disposition_fingerprint FROM material_demand_approvals
       WHERE approval_stage = 'FINAL' AND pricing_id = $1 AND decision = 'APPROVED'`,
      [pricingId],
    );
    assert.equal(history.rowCount, 3);
    assert.equal(new Set(history.rows.map((r) => r.disposition_fingerprint)).size, 2);

    const signoffs = await findIpoSignoffs(pool, ipo.id);
    assert.equal(signoffs.length, 2, "a stale approval leaked into the IPO signoffs");
    const names = signoffs.map((s) => s.actor_name);
    assert.ok(names.includes("Test Upper Management"), "the manager who approved THIS set signed it");
    assert.ok(names.includes("Test HR"), "the formal approver of THIS set signed it");
    assert.ok(
      !names.includes("Test Manager"),
      "the manager who approved the superseded set must not appear as a signatory",
    );

    // The IPO's own binding is what selects them.
    assert.equal(
      signoffs.length,
      (
        await pool.query(
          `SELECT count(*)::int AS n FROM material_demand_approvals
           WHERE approval_stage='FINAL' AND pricing_id=$1 AND decision='APPROVED'
             AND disposition_fingerprint=$2`,
          [pricingId, ipo.disposition_fingerprint],
        )
      ).rows[0].n,
    );

    // And the IPO contains exactly the set those two approved.
    const ipoLines = await pool.query("SELECT demand_line_id FROM ipo_lines WHERE ipo_id = $1", [ipo.id]);
    assert.equal(ipoLines.rowCount, 2);
    assert.ok(!ipoLines.rows.some((r) => r.demand_line_id === lines[1].demand_line_id));
  } finally {
    await clearOverride(users.upperManagement, "procurement.view_prices");
    await clearOverride(users.hr, "demand.approve");
    await clearOverride(users.hr, "procurement.view_prices");
  }
});

test("C — the CEO exception survives: one actor may hold both responsibilities", async () => {
  const { demandId, pricingId } = await pendingFinal();
  assert.equal((await finalReview(demandId, pricingId, ctx.tokens.ceo)).status, 200);
  assert.equal((await finalApproval(demandId, pricingId, ctx.tokens.ceo)).status, 200);

  const signoffs = await findIpoSignoffs(pool, (await ipoFor(demandId)).id);
  // Two responsibilities, same actor — deduplication is by responsibility and
  // fingerprint, never by person.
  assert.equal(signoffs.length, 2);
  assert.deepEqual(signoffs.map((s) => s.approval_type).sort(), ["FORMAL_APPROVAL", "MANAGEMENT_REVIEW"]);
  assert.ok(signoffs.every((s) => s.actor_name === "Test CEO"));
});

test("D — the signoff query cannot be asked for another context's approvals", async () => {
  const a = await pendingFinal();
  await finalReview(a.demandId, a.pricingId, ctx.tokens.siteManager);
  await finalApproval(a.demandId, a.pricingId, ctx.tokens.ceo);
  const ipoA = await ipoFor(a.demandId);

  const b = await pendingFinal();
  await finalReview(b.demandId, b.pricingId, ctx.tokens.siteManager);
  await finalApproval(b.demandId, b.pricingId, ctx.tokens.ceo);
  const ipoB = await ipoFor(b.demandId);

  // The query takes an IPO id and joins through that IPO's own binding, so
  // there is no parameter through which a caller could supply a mismatched
  // pricing version or fingerprint.
  const forA = await findIpoSignoffs(pool, ipoA.id);
  const forB = await findIpoSignoffs(pool, ipoB.id);
  assert.equal(forA.length, 2);
  assert.equal(forB.length, 2);
  assert.notEqual(ipoA.pricing_id, ipoB.pricing_id);
  assert.equal((await findIpoSignoffs(pool, "00000000-0000-0000-0000-000000000000")).length, 0);
});

test("E — the IPO's authorization binding is immutable", async () => {
  const { demandId, pricingId } = await pendingFinal();
  await finalReview(demandId, pricingId, ctx.tokens.siteManager);
  await finalApproval(demandId, pricingId, ctx.tokens.ceo);
  const ipo = await ipoFor(demandId);

  await assert.rejects(
    pool.query("UPDATE ipos SET disposition_fingerprint = $2 WHERE id = $1", [ipo.id, "b".repeat(64)]),
    /approved IPO snapshot is immutable/,
  );
  // The format is constrained the same way the approval rows are.
  await assert.rejects(
    pool.query("UPDATE ipos SET disposition_fingerprint = 'not-a-fingerprint' WHERE id = $1", [ipo.id]),
    /immutable|fingerprint_check/,
  );
});

test("F — the superseded decision remains visible in the Demand's own history", async () => {
  const { demandId, pricingId, lines } = await pendingFinal();
  await finalReview(demandId, pricingId, ctx.tokens.siteManager);
  await exclude(demandId, pricingId, lines[1].demand_line_id, ctx.tokens.ceo);
  await finalReview(demandId, pricingId, ctx.tokens.siteManager);
  await finalApproval(demandId, pricingId, ctx.tokens.ceo);

  // Nothing was deleted or rewritten: the Demand still shows every decision
  // that was actually taken, which is what makes the history truthful.
  const detail = await apiRequest(ctx.baseUrl, "GET", `/api/v1/demands/${demandId}`, {
    token: ctx.tokens.siteManager,
  });
  assert.equal(detail.status, 200);
  const finals = detail.body.data.approvals.filter(
    (a) => a.approval_stage === "FINAL" && a.approval_type === "MANAGEMENT_REVIEW",
  );
  assert.equal(finals.length, 2, "both management decisions remain in the Demand's history");
  assert.equal(new Set(finals.map((a) => a.disposition_fingerprint)).size, 2);
});

test("the issued document's signoff section reflects only the authorizing set", async () => {
  const { demandId, pricingId, lines } = await pendingFinal();
  await finalReview(demandId, pricingId, ctx.tokens.siteManager);
  await exclude(demandId, pricingId, lines[1].demand_line_id, ctx.tokens.ceo);

  await setOverride(users.upperManagement, "procurement.view_prices", "GRANT", users.ceo);
  try {
    await finalReview(demandId, pricingId, ctx.tokens.upperManagement);
    await finalApproval(demandId, pricingId, ctx.tokens.ceo);
    const ipo = await ipoFor(demandId);

    // The document is rendered from the same bound helper, so what the PDF
    // says and what the query returns cannot disagree.
    const signoffs = await findIpoSignoffs(pool, ipo.id);
    assert.deepEqual(
      signoffs.map((s) => s.actor_name).sort(),
      ["Test CEO", "Test Upper Management"],
    );

    // Rendering with the superseded manager included must produce a visibly
    // different document — proving the signoff block is really on the page.
    const { generateIpoPdf } = await import("../src/modules/ipo/ipo.pdf.js");
    const detail = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipo.id}`, {
      token: ctx.tokens.siteManager,
    });
    const document = { ipo: detail.body.data.ipo, lines: detail.body.data.lines };

    const correct = contentStreamOf(await generateIpoPdf({ ...document, approvals: signoffs }));
    const contaminated = contentStreamOf(
      await generateIpoPdf({
        ...document,
        approvals: [
          ...signoffs,
          { approval_type: "MANAGEMENT_REVIEW", actor_name: "Test Manager", created_at: new Date().toISOString() },
        ],
      }),
    );
    assert.notEqual(correct, contaminated, "the signoff block is not actually rendered");

    // Medium Fix 1 stays intact: purchasing progress is still absent.
    const withProgress = contentStreamOf(
      await generateIpoPdf({
        ipo: document.ipo,
        lines: document.lines.map((line) => ({ ...line, purchased_quantity: "99.00" })),
        approvals: signoffs,
      }),
    );
    assert.equal(correct, withProgress, "purchasing progress reached the IPO document again");
  } finally {
    await clearOverride(users.upperManagement, "procurement.view_prices");
  }
});
