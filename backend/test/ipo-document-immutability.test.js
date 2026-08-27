import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import pool from "../src/config/database.js";
import { generateIpoPdf } from "../src/modules/ipo/ipo.pdf.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { buildApprovedIpo, recordPurchase } from "./procurement-chain-helpers.js";

// The IPO is the approved purchasing AUTHORITY: what management authorized
// Procurement to buy. Downloading it a year later must say exactly what it
// said the day it was issued — a document whose meaning drifts with downstream
// activity is not an authority.
//
// PDFKit subsets its fonts, so the rendered bytes contain glyph ids rather
// than readable words. Rather than decode them, these tests compare the
// rendered CONTENT STREAM across different purchasing states: if the document
// is genuinely independent of purchasing progress, the drawing instructions
// must be byte-identical. That is a stronger claim than searching for a header
// string, and it stays true regardless of how the layout is restyled.

let ctx;
let uomId;

function contentStreamOf(buffer) {
  const raw = buffer.toString("latin1");
  const pattern = /stream\r?\n([\s\S]*?)\r?\nendstream/g;
  let text = "";
  let match;
  while ((match = pattern.exec(raw))) {
    try {
      text += zlib.inflateSync(Buffer.from(match[1], "latin1")).toString("latin1");
    } catch {
      // Not a Flate stream (embedded font programs); nothing to read.
    }
  }
  assert.ok(text.length > 0, "no readable content stream in the rendered document");
  return text;
}

const IPO_FIXTURE = {
  ipo_number: "ESET/2026/32",
  generated_at: "2026-08-01T09:00:00.000Z",
  department_name: "Civil",
  site_name: "Main Site",
  demand_number: "DL-2026-000004",
  demand_revision: 1,
  currency: "PKR",
  estimated_total: "5000.00",
  status: "GENERATED",
  generated_by_name: "Test CEO",
  acknowledged_by_name: null,
};

function lineWith(purchasedQuantity) {
  return [
    {
      line_no: 1,
      item_name_snapshot: "Cable 2.5mm",
      uom_code_snapshot: "M",
      approved_quantity: "100.00",
      estimated_unit_price: "50.00",
      estimated_line_total: "5000.00",
      // Present in the projection because the Procurement UI needs it. The
      // document must simply not render it.
      purchased_quantity: purchasedQuantity,
      actual_unit_price: "48.25",
      actual_line_total: "2895.00",
      procurement_note: "internal note",
    },
  ];
}

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

test("the issued IPO renders identically no matter how much has since been purchased", async () => {
  const atIssue = contentStreamOf(await generateIpoPdf({ ipo: IPO_FIXTURE, lines: lineWith("0.00"), approvals: [] }));
  const partway = contentStreamOf(await generateIpoPdf({ ipo: IPO_FIXTURE, lines: lineWith("60.00"), approvals: [] }));
  const complete = contentStreamOf(await generateIpoPdf({ ipo: IPO_FIXTURE, lines: lineWith("100.00"), approvals: [] }));

  assert.equal(atIssue, partway, "purchasing 60 changed the issued purchasing authority");
  assert.equal(atIssue, complete, "purchasing the full quantity changed the issued purchasing authority");
});

test("no downstream progress field of any kind reaches the document", async () => {
  // Every mutable downstream value on one render versus another. If any of
  // them is drawn, the streams diverge.
  const baseline = contentStreamOf(
    await generateIpoPdf({ ipo: IPO_FIXTURE, lines: lineWith("0.00"), approvals: [] }),
  );

  const withProgress = contentStreamOf(
    await generateIpoPdf({
      ipo: { ...IPO_FIXTURE, status: "PURCHASING" },
      lines: [
        {
          ...lineWith("100.00")[0],
          purchase_status: "PURCHASED",
          outstanding_quantity: "0.00",
          allocated_quantity: "100.00",
          received_quantity: "100.00",
          discrepancy_quantity: "0.00",
          purchase_event_count: 3,
        },
      ],
      approvals: [],
    }),
  );

  assert.equal(
    baseline,
    withProgress,
    "a downstream field (purchase status, outstanding, delivered, received) reached the issued IPO",
  );
});

test("the approved authority itself is still rendered, and still drives the document", async () => {
  const baseline = contentStreamOf(
    await generateIpoPdf({ ipo: IPO_FIXTURE, lines: lineWith("0.00"), approvals: [] }),
  );

  // Each approved value must genuinely be on the page: changing any of them
  // must change the document. Otherwise "identical output" above would be
  // satisfied by rendering nothing at all.
  const variants = {
    "approved quantity": { lines: [{ ...lineWith("0.00")[0], approved_quantity: "999.00" }] },
    "approved unit price": { lines: [{ ...lineWith("0.00")[0], estimated_unit_price: "77.00" }] },
    "approved line total": { lines: [{ ...lineWith("0.00")[0], estimated_line_total: "7777.00" }] },
    "item description": { lines: [{ ...lineWith("0.00")[0], item_name_snapshot: "Something else" }] },
    UOM: { lines: [{ ...lineWith("0.00")[0], uom_code_snapshot: "KG" }] },
    "IPO number": { ipo: { ...IPO_FIXTURE, ipo_number: "ESET/2026/99" } },
    "Demand reference": { ipo: { ...IPO_FIXTURE, demand_number: "DL-2026-000999" } },
    "grand total": { ipo: { ...IPO_FIXTURE, estimated_total: "9999.00" } },
  };

  for (const [label, override] of Object.entries(variants)) {
    const rendered = contentStreamOf(
      await generateIpoPdf({
        ipo: override.ipo || IPO_FIXTURE,
        lines: override.lines || lineWith("0.00"),
        approvals: [],
      }),
    );
    assert.notEqual(rendered, baseline, `${label} is not actually rendered on the IPO`);
  }
});

test("end to end: the same IPO downloads identically before and after a real purchase", async () => {
  const chain = await buildApprovedIpo(ctx, { uomId, quantities: [100], prices: ["50.00"] });

  const download = async () => {
    const response = await fetch(`${ctx.baseUrl}/api/v1/ipos/${chain.ipoId}/pdf`, {
      headers: { Origin: "http://localhost:5173", Cookie: ctx.tokens.siteManager },
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "application/pdf");
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
    // Business reference contains "/" — the download filename must be a
    // sanitized derivation of it (High Fix / earlier corrective pass).
    assert.match(response.headers.get("content-disposition"), /^attachment; filename="ESET-\d{4}-\d+\.pdf"$/);
    return contentStreamOf(bytes);
  };

  const beforePurchase = await download();

  assert.equal(
    (await recordPurchase(ctx, chain.ipoId, [
      { ipoLineId: chain.ipoLines[0].id, quantity: "60", actualUnitPrice: "48.25" },
    ])).status,
    200,
  );
  const line = await pool.query("SELECT purchased_quantity FROM ipo_lines WHERE id = $1", [chain.ipoLines[0].id]);
  assert.equal(line.rows[0].purchased_quantity, "60.00", "purchasing really did move underneath the document");

  const afterPurchase = await download();
  assert.equal(beforePurchase, afterPurchase, "the issued IPO changed after Procurement bought against it");
});

test("Procurement still sees purchasing progress in the application", async () => {
  const chain = await buildApprovedIpo(ctx, { uomId, quantities: [100], prices: ["50.00"] });
  await recordPurchase(ctx, chain.ipoId, [
    { ipoLineId: chain.ipoLines[0].id, quantity: "60", actualUnitPrice: "48.25" },
  ]);

  // Removing progress from the DOCUMENT must not remove it from the UI.
  const detail = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${chain.ipoId}`, {
    token: ctx.tokens.siteManager,
  });
  assert.equal(detail.status, 200);
  const line = detail.body.data.lines[0];
  assert.equal(line.purchased_quantity, "60.00");
  assert.equal(line.outstanding_quantity, "40.00");
  assert.equal(line.purchase_status, "PARTIALLY_PURCHASED");
});

test("the IPO document remains gated on commercial authority", async () => {
  const chain = await buildApprovedIpo(ctx, { uomId, quantities: [10], prices: ["50.00"] });

  // ipo.view alone is operational visibility, never the priced document.
  const operational = await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${chain.ipoId}/pdf`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(operational.status, 403);

  const authorized = await fetch(`${ctx.baseUrl}/api/v1/ipos/${chain.ipoId}/pdf`, {
    headers: { Origin: "http://localhost:5173", Cookie: ctx.tokens.siteManager },
  });
  assert.equal(authorized.status, 200);
});
