import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { processOnce } from "../src/shared/notifications/outbox.processor.js";
import { isWhatsAppDeliveryEnabled } from "../src/shared/notifications/whatsapp-provider.js";
import { formatDocumentNumber, documentFilename } from "../src/shared/documents/document-number.js";
import { buildApprovedIpo, createFinalizedDc, recordPurchase } from "./procurement-chain-helpers.js";

let ctx;
let uomId;

before(async () => {
  const server = await startTestServer();
  await seedUsers();
  const tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
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

test("document numbers follow the configured E-Set format and never reach a filename raw", () => {
  assert.equal(
    formatDocumentNumber({ prefix: "ESET", separator: "/", suffix: "", padWidth: 1 }, 2026, 32),
    "ESET/2026/32",
  );
  // Padding, suffix and separator are all configuration, not code.
  assert.equal(
    formatDocumentNumber({ prefix: "IPO", separator: "-", suffix: "A", padWidth: 6 }, 2026, 7),
    "IPO-2026-000007-A",
  );

  // The "/" in a real reference must never reach a Content-Disposition
  // header or a storage path.
  assert.equal(documentFilename("ESET/2026/32", "pdf"), "ESET-2026-32.pdf");
  assert.equal(documentFilename("../../etc/passwd", "pdf"), "etc-passwd.pdf");
  assert.ok(!documentFilename('a"b/c', "pdf").includes('"'));
});

test("IPO generation queues a durable document job that stores the rendered document", async () => {
  const { ipoId, ipoNumber } = await buildApprovedIpo(ctx, { uomId });

  const job = await pool.query(
    `SELECT status, channel FROM notification_outbox
     WHERE event_type = 'GENERATE_IPO_DOCUMENT' AND entity_id = $1`,
    [ipoId],
  );
  assert.equal(job.rowCount, 1, "the job is enqueued in the very transaction that created the IPO");
  assert.equal(job.rows[0].channel, "SYSTEM");
  assert.equal(job.rows[0].status, "PENDING");

  await processOnce();

  const stored = await pool.query(
    "SELECT document_number, storage_key, size_bytes, checksum_sha256 FROM procurement_documents WHERE entity_id = $1",
    [ipoId],
  );
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].document_number, ipoNumber);
  assert.ok(stored.rows[0].size_bytes > 1000);
  assert.match(stored.rows[0].checksum_sha256, /^[0-9a-f]{64}$/);

  // Running the worker again must not produce a second document or a second
  // delivery — it re-derives "already done?" from durable state.
  await processOnce();
  const again = await pool.query("SELECT count(*)::int AS n FROM procurement_documents WHERE entity_id = $1", [
    ipoId,
  ]);
  assert.equal(again.rows[0].n, 1);
  const deliveries = await pool.query(
    "SELECT count(*)::int AS n FROM notification_outbox WHERE channel = 'WHATSAPP' AND entity_id = $1",
    [ipoId],
  );
  assert.equal(deliveries.rows[0].n, 1);
});

test("WhatsApp delivery being disabled never blocks or rolls back the business record", async () => {
  assert.equal(isWhatsAppDeliveryEnabled(), false, "this suite runs with WhatsApp deliberately unconfigured");

  const { ipoId, ipoNumber } = await buildApprovedIpo(ctx, { uomId });
  await processOnce();

  // The IPO exists and is untouched.
  const ipo = await pool.query("SELECT status, ipo_number FROM ipos WHERE id = $1", [ipoId]);
  assert.equal(ipo.rowCount, 1);
  assert.equal(ipo.rows[0].ipo_number, ipoNumber);

  // The delivery is recorded as deliberately not attempted — never PENDING
  // (which would retry forever) and never FAILED (which would misreport a
  // configuration choice as an error).
  const delivery = await pool.query(
    `SELECT status, attempts, payload, idempotency_key FROM notification_outbox
     WHERE channel = 'WHATSAPP' AND entity_id = $1`,
    [ipoId],
  );
  assert.equal(delivery.rowCount, 1);
  assert.equal(delivery.rows[0].status, "DISABLED");
  assert.equal(delivery.rows[0].attempts, 0);
  assert.equal(delivery.rows[0].payload.skippedReason, "DISABLED");
  assert.equal(delivery.rows[0].idempotency_key, `whatsapp-document:IPO:${ipoId}`);

  // The audit says so too, and the document is still downloadable by hand.
  const audit = await pool.query(
    "SELECT action FROM procurement_audit_log WHERE entity_id = $1 AND action LIKE 'DOCUMENT_%' ORDER BY created_at",
    [ipoId],
  );
  assert.deepEqual(audit.rows.map((row) => row.action), ["DOCUMENT_GENERATED", "DOCUMENT_DELIVERY_SKIPPED"]);

  const download = await fetch(`${ctx.baseUrl}/api/v1/ipos/${ipoId}/pdf`, {
    headers: { Origin: "http://localhost:5173", Cookie: ctx.tokens.siteManager },
  });
  assert.equal(download.status, 200);
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.equal(bytes.subarray(0, 5).toString(), "%PDF-");
});

test("a WhatsApp caption never carries commercial values", async () => {
  const { ipoId } = await buildApprovedIpo(ctx, { uomId, prices: ["1234.56", "99.99"] });
  await processOnce();

  const delivery = await pool.query(
    "SELECT payload FROM notification_outbox WHERE channel = 'WHATSAPP' AND entity_id = $1",
    [ipoId],
  );
  const caption = delivery.rows[0].payload.caption;
  assert.ok(!caption.includes("1234.56"));
  assert.ok(!caption.includes("99.99"));
  assert.ok(!/total|price|amount|pkr/i.test(caption), `caption leaked commercial wording: ${caption}`);
});

test("a finalized Delivery Challan queues its own document job for the department", async () => {
  const built = await buildApprovedIpo(ctx, { uomId });
  await recordPurchase(ctx, built.ipoId, [
    { ipoLineId: built.ipoLines[0].id, quantity: "40", actualUnitPrice: "48.00" },
  ]);
  const { dcId } = await createFinalizedDc(ctx, built.ipoId, [
    { ipoLineId: built.ipoLines[0].id, quantity: "40" },
  ]);

  await processOnce();

  const stored = await pool.query(
    "SELECT entity_type, document_number FROM procurement_documents WHERE entity_id = $1",
    [dcId],
  );
  assert.equal(stored.rowCount, 1);
  assert.equal(stored.rows[0].entity_type, "DELIVERY_CHALLAN");

  const delivery = await pool.query(
    "SELECT status, payload FROM notification_outbox WHERE channel = 'WHATSAPP' AND entity_id = $1",
    [dcId],
  );
  assert.equal(delivery.rowCount, 1);
  assert.equal(delivery.rows[0].status, "DISABLED");
  assert.match(delivery.rows[0].payload.filename, /^ESET-DC-\d{4}-\d+\.pdf$/);
});

test("a document for a cancelled IPO is never generated or shared", async () => {
  const { ipoId } = await buildApprovedIpo(ctx, { uomId });
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/cancel`, {
      token: ctx.tokens.ceo,
      body: { reason: "Raised in error" },
    })).status,
    200,
  );

  await processOnce();

  const stored = await pool.query("SELECT count(*)::int AS n FROM procurement_documents WHERE entity_id = $1", [
    ipoId,
  ]);
  assert.equal(stored.rows[0].n, 0);
  const job = await pool.query(
    "SELECT status FROM notification_outbox WHERE event_type = 'GENERATE_IPO_DOCUMENT' AND entity_id = $1",
    [ipoId],
  );
  assert.equal(job.rows[0].status, "VOID");
});

test("the full chain closes only when every quantity is resolved", async () => {
  const built = await buildApprovedIpo(ctx, { uomId, quantities: [100, 20] });

  // Procurement can only buy 60 of the approved 100, and all 20 of line two.
  await recordPurchase(ctx, built.ipoId, [
    { ipoLineId: built.ipoLines[0].id, quantity: "60", actualUnitPrice: "48.00" },
    { ipoLineId: built.ipoLines[1].id, quantity: "20", actualUnitPrice: "9.50" },
  ]);

  const { dcId, lines } = await createFinalizedDc(ctx, built.ipoId, [
    { ipoLineId: built.ipoLines[0].id, quantity: "60" },
    { ipoLineId: built.ipoLines[1].id, quantity: "20" },
  ]);

  const received = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/challans/${dcId}/receipts`, {
    token: ctx.tokens.teamLead,
    body: {
      operationId: randomUUID(), lines: lines.map((line) => ({ dcLineId: line.id, receivedQuantity: line.quantity })) },
  });
  assert.equal(received.status, 201);
  await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${received.body.data.receipt.id}/confirm`, {
    token: ctx.tokens.teamLead,
  });

  // Everything delivered is received and confirmed, but 40 approved units
  // were never purchased — the chain must NOT close on its own.
  let ipo = await pool.query("SELECT status, completed_at FROM ipos WHERE id = $1", [built.ipoId]);
  assert.equal(ipo.rows[0].status, "PURCHASING");
  let demand = await pool.query("SELECT status FROM material_demands WHERE id = $1", [built.demandId]);
  assert.equal(demand.rows[0].status, "IPO_GENERATED");

  // Procurement explicitly closes purchasing: the outstanding 40 is now a
  // deliberate, traceable carry-forward rather than an open-ended promise.
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${built.ipoId}/close-purchasing`, {
      token: ctx.tokens.ceo,
    })).status,
    200,
  );

  ipo = await pool.query("SELECT status, completed_at FROM ipos WHERE id = $1", [built.ipoId]);
  assert.equal(ipo.rows[0].status, "COMPLETED");
  assert.ok(ipo.rows[0].completed_at);
  demand = await pool.query("SELECT status FROM material_demands WHERE id = $1", [built.demandId]);
  assert.equal(demand.rows[0].status, "COMPLETED");

  // Every distinct quantity survives the closure — none is collapsed.
  const line = await pool.query(
    "SELECT approved_quantity, purchased_quantity FROM ipo_lines WHERE id = $1",
    [built.ipoLines[0].id],
  );
  assert.equal(line.rows[0].approved_quantity, "100.00");
  assert.equal(line.rows[0].purchased_quantity, "60.00");

  const dcLine = await pool.query(
    "SELECT quantity FROM delivery_challan_lines WHERE ipo_line_id = $1",
    [built.ipoLines[0].id],
  );
  assert.equal(dcLine.rows[0].quantity, "60.00");

  const receiptLine = await pool.query(
    `SELECT mrl.received_quantity, mrl.discrepancy_quantity FROM material_receipt_lines mrl
     JOIN delivery_challan_lines dcl ON dcl.id = mrl.dc_line_id WHERE dcl.ipo_line_id = $1`,
    [built.ipoLines[0].id],
  );
  assert.equal(receiptLine.rows[0].received_quantity, "60.00");
  assert.equal(receiptLine.rows[0].discrepancy_quantity, "0.00");

  // "Completed" is a workflow statement, not an inventory statement.
  const completionAudit = await pool.query(
    "SELECT count(*)::int AS n FROM material_demand_audit_log WHERE demand_id = $1 AND action = 'COMPLETED'",
    [built.demandId],
  );
  assert.equal(completionAudit.rows[0].n, 1);
});

test("the Demand List document carries no pricing for anyone, including management", async () => {
  const built = await buildApprovedIpo(ctx, { uomId, prices: ["777.77", "88.88"] });

  for (const token of [ctx.tokens.teamLead, ctx.tokens.ceo, ctx.tokens.siteManager]) {
    const response = await fetch(`${ctx.baseUrl}/api/v1/demands/${built.demandId}/pdf`, {
      headers: { Origin: "http://localhost:5173", Cookie: token },
    });
    assert.equal(response.status, 200);
    const text = Buffer.from(await response.arrayBuffer()).toString("latin1");
    assert.ok(!text.includes("777.77"), "the Demand List PDF is unpriced for every viewer");
    assert.ok(!text.includes("88.88"));
  }

  const guard = await apiRequest(ctx.baseUrl, "GET", `/api/v1/demands/${built.demandId}/pdf`, {
    token: ctx.tokens.guard,
  });
  assert.equal(guard.status, 403);
});

test("closing purchasing concurrently with the final confirmation never deadlocks", async () => {
  const built = await buildApprovedIpo(ctx, { uomId, quantities: [10, 5] });
  await recordPurchase(ctx, built.ipoId, [
    { ipoLineId: built.ipoLines[0].id, quantity: "10", actualUnitPrice: "5.00" },
    { ipoLineId: built.ipoLines[1].id, quantity: "5", actualUnitPrice: "2.00" },
  ]);
  const { dcId, lines } = await createFinalizedDc(ctx, built.ipoId, [
    { ipoLineId: built.ipoLines[0].id, quantity: "10" },
    { ipoLineId: built.ipoLines[1].id, quantity: "5" },
  ]);
  const received = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/challans/${dcId}/receipts`, {
    token: ctx.tokens.teamLead,
    body: {
      operationId: randomUUID(), lines: lines.map((line) => ({ dcLineId: line.id, receivedQuantity: line.quantity })) },
  });
  assert.equal(received.status, 201);

  // These two writers touch the same Demand/IPO/DC/Receipt chain from
  // opposite ends. Both take their row locks in the one documented order
  // (Demand -> IPO -> DC -> Receipt), so they serialize instead of
  // deadlocking — a lock-order inversion here would surface as a 500.
  const [closed, confirmed] = await Promise.all([
    apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${built.ipoId}/close-purchasing`, { token: ctx.tokens.ceo }),
    apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${received.body.data.receipt.id}/confirm`, {
      token: ctx.tokens.teamLead,
    }),
  ]);

  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.body));

  // Whichever landed second observed the other's committed state, so the
  // chain closes exactly once.
  const ipo = await pool.query("SELECT status FROM ipos WHERE id = $1", [built.ipoId]);
  assert.equal(ipo.rows[0].status, "COMPLETED");
  const completions = await pool.query(
    "SELECT count(*)::int AS n FROM procurement_audit_log WHERE ipo_id = $1 AND action = 'IPO_COMPLETED'",
    [built.ipoId],
  );
  assert.equal(completions.rows[0].n, 1);
  const demandCompletions = await pool.query(
    "SELECT count(*)::int AS n FROM material_demand_audit_log WHERE demand_id = $1 AND action = 'COMPLETED'",
    [built.demandId],
  );
  assert.equal(demandCompletions.rows[0].n, 1);
});
