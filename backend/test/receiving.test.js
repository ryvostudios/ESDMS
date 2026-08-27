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
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    teamLeadOtherDept: await authHeader(server.baseUrl, "teamlead2@test.eset.local"),
    employee: await authHeader(server.baseUrl, "employee@test.eset.local"),
    guard: await authHeader(server.baseUrl, "guard@test.eset.local"),
    otherSiteAdmin: await authHeader(server.baseUrl, "admin-othersite@test.eset.local"),
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

// A finalized delivery of `quantity` units of the first line, ready to receive.
async function deliveryReadyToReceive(quantity = "60") {
  const built = await buildApprovedIpo(ctx, { uomId });
  assert.equal(
    (await recordPurchase(ctx, built.ipoId, [
      { ipoLineId: built.ipoLines[0].id, quantity: quantity, actualUnitPrice: "48.00" },
    ])).status,
    200,
  );
  const dc = await createFinalizedDc(ctx, built.ipoId, [{ ipoLineId: built.ipoLines[0].id, quantity }]);
  return { ...built, dcId: dc.dcId, dcLines: dc.lines, quantity };
}

// A fresh operation id per call by default, so each is a genuinely new
// logical receipt; the idempotency tests pass one explicitly to replay.
const receive = (dcId, body, token, operationId) =>
  apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/challans/${dcId}/receipts`, {
    token,
    body: { operationId: operationId || randomUUID(), ...body },
  });

test("any authorized member of the owning department may receive directly, with no Admin approval", async () => {
  const { dcId, dcLines } = await deliveryReadyToReceive("60");

  // An ordinary EMPLOYEE of the owning department — not a Team Lead, not
  // Admin — records the physical receipt.
  const received = await receive(dcId, { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "60" }] }, ctx.tokens.employee);
  assert.equal(received.status, 201, JSON.stringify(received.body));
  assert.equal(received.body.data.receipt.receipt_type, "DEPARTMENT");
  assert.equal(received.body.data.receipt.status, "PENDING_CONFIRMATION");
  assert.equal(received.body.data.lines[0].received_quantity, "60.00");

  const receiptId = received.body.data.receipt.id;

  // The department's Team Lead is notified to close the cycle — nobody else.
  const notified = await pool.query(
    `SELECT recipient_user_id FROM notification_outbox
     WHERE entity_type = 'MATERIAL_RECEIPT' AND entity_id = $1 AND event_type = 'MATERIAL_RECEIVED'`,
    [receiptId],
  );
  const recipients = notified.rows.map((row) => row.recipient_user_id);
  assert.ok(recipients.includes(users.teamLead), "the owning department's Team Lead is notified");
  assert.ok(!recipients.includes(users.teamLeadOtherDept), "an unrelated department's lead is never notified");

  // Team Lead confirmation closes it. No Admin is involved at any point.
  const confirmed = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/confirm`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.receipt.status, "COMPLETED");
  assert.equal(confirmed.body.data.receipt.confirmed_by_name, "Test Team Lead");
});

test("ordinary department receiving never crosses a department or site boundary", async () => {
  const { dcId, dcLines } = await deliveryReadyToReceive("60");
  const body = { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "10" }] };

  const otherDepartment = await receive(dcId, body, ctx.tokens.teamLeadOtherDept);
  assert.equal(otherDepartment.status, 404, "knowing the Delivery Challan id grants nothing");

  const otherSite = await receive(dcId, body, ctx.tokens.otherSiteTeamLead);
  assert.equal(otherSite.status, 404);

  const guard = await receive(dcId, body, ctx.tokens.guard);
  assert.equal(guard.status, 403, "Gate Guard holds no receiving capability");

  // Admin holds receiving.fallback_receive but NOT receiving.receive, so the
  // ordinary path is refused even at their own site.
  const adminOrdinary = await receive(dcId, body, ctx.tokens.admin);
  assert.equal(adminOrdinary.status, 403);
});

test("Admin fallback custody is a separate capability, and the original receiver is never rewritten", async () => {
  const { dcId, dcLines } = await deliveryReadyToReceive("60");

  // A department user cannot claim temporary custody — that is Admin's
  // explicitly separate authority.
  const teamLeadFallback = await receive(
    dcId,
    { fallback: true, lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "60" }] },
    ctx.tokens.teamLead,
  );
  assert.equal(teamLeadFallback.status, 403);

  const custody = await receive(
    dcId,
    { fallback: true, note: "Nobody from the department on site", lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "60" }] },
    ctx.tokens.admin,
  );
  assert.equal(custody.status, 201, JSON.stringify(custody.body));
  const receiptId = custody.body.data.receipt.id;
  assert.equal(custody.body.data.receipt.receipt_type, "ADMIN_FALLBACK");
  assert.equal(custody.body.data.receipt.status, "AWAITING_HANDOVER");
  assert.equal(custody.body.data.receipt.received_by_name, "Test Admin");
  // The intended owning department is preserved, not replaced by the Admin
  // receiver's own department affiliation.
  const dcDepartment = await pool.query("SELECT department_id FROM delivery_challans WHERE id = $1", [dcId]);
  assert.equal(custody.body.data.receipt.department_id, dcDepartment.rows[0].department_id);
  const adminUser = await pool.query("SELECT department_id FROM users WHERE id = $1", [users.admin]);
  assert.notEqual(custody.body.data.receipt.department_id, adminUser.rows[0].department_id);

  // It cannot be confirmed while still in Admin's hands.
  const prematureConfirm = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/confirm`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(prematureConfirm.status, 409);

  // The DEPARTMENT acknowledges the handover — Admin cannot declare it.
  const adminHandover = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/handover`, {
    token: ctx.tokens.admin,
  });
  assert.equal(adminHandover.status, 403);

  const handover = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/handover`, {
    token: ctx.tokens.employee,
  });
  assert.equal(handover.status, 200, JSON.stringify(handover.body));
  assert.equal(handover.body.data.receipt.status, "PENDING_CONFIRMATION");
  // Both custody events survive: Admin as the original receiver AND the
  // department employee as the eventual recipient.
  assert.equal(handover.body.data.receipt.received_by_name, "Test Admin");
  assert.equal(handover.body.data.receipt.handover_to_name, "Test Employee");
  assert.ok(handover.body.data.receipt.received_at);
  assert.ok(handover.body.data.receipt.handover_at);

  // Replayed handover is a successful no-op, and the database refuses to
  // rewrite a completed handover even directly.
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/handover`, {
      token: ctx.tokens.employee,
    })).status,
    200,
  );
  const handoverEvents = await pool.query(
    "SELECT count(*)::int AS n FROM procurement_audit_log WHERE entity_id = $1 AND action = 'HANDOVER_COMPLETED'",
    [receiptId],
  );
  assert.equal(handoverEvents.rows[0].n, 1);

  await assert.rejects(
    pool.query("UPDATE material_receipts SET received_by_user_id = $2 WHERE id = $1", [receiptId, users.teamLead]),
    /original receipt record is immutable/,
  );
  await assert.rejects(
    pool.query("UPDATE material_receipts SET handover_at = now() WHERE id = $1", [receiptId]),
    /completed handover cannot be rewritten/,
  );

  const confirmed = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/confirm`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(confirmed.status, 200);
  assert.equal(confirmed.body.data.receipt.status, "COMPLETED");
});

test("Admin fallback custody stays inside the Admin's own site", async () => {
  const { dcId, dcLines } = await deliveryReadyToReceive("60");

  const crossSite = await receive(
    dcId,
    { fallback: true, lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "60" }] },
    ctx.tokens.otherSiteAdmin,
  );
  assert.equal(crossSite.status, 404, "fallback custody is cross-department, never cross-site");
});

test("partial receipt is traceable and over-receipt is rejected", async () => {
  const { dcId, dcLines } = await deliveryReadyToReceive("60");

  const tooMuch = await receive(dcId, { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "61" }] }, ctx.tokens.teamLead);
  assert.equal(tooMuch.status, 400);

  const first = await receive(dcId, { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "25" }] }, ctx.tokens.teamLead);
  assert.equal(first.status, 201);

  const delivery = await apiRequest(ctx.baseUrl, "GET", `/api/v1/receiving/challans/${dcId}`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(delivery.body.data.lines[0].quantity, "60.00");
  assert.equal(delivery.body.data.lines[0].received_quantity, "25.00");
  assert.equal(delivery.body.data.lines[0].unresolved_quantity, "35.00");

  const overRemaining = await receive(dcId, { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "36" }] }, ctx.tokens.teamLead);
  assert.equal(overRemaining.status, 400, "cannot exceed the unresolved challan quantity");

  const second = await receive(dcId, { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "35" }] }, ctx.tokens.teamLead);
  assert.equal(second.status, 201);

  // Even a direct database write cannot push the total past the challan.
  await assert.rejects(
    pool.query(
      `INSERT INTO material_receipt_lines
         (receipt_id, dc_id, dc_line_id, line_no, item_name_snapshot, uom_code_snapshot, uom_name_snapshot,
          dc_quantity, received_quantity)
       VALUES ($1, $2, $3, 99, 'x', 'x', 'x', 60, 1)`,
      [second.body.data.receipt.id, dcId, dcLines[0].id],
    ),
    /exceeds the unresolved delivery challan quantity/,
  );
});

test("concurrent receivers of the same line cannot both take the last quantity", async () => {
  const { dcId, dcLines } = await deliveryReadyToReceive("60");
  const body = { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "60" }] };

  const [a, b] = await Promise.all([
    receive(dcId, body, ctx.tokens.teamLead),
    receive(dcId, body, ctx.tokens.employee),
  ]);
  assert.equal([a, b].filter((response) => response.status === 201).length, 1);

  const total = await pool.query(
    `SELECT COALESCE(SUM(received_quantity + discrepancy_quantity), 0)::numeric(12,2) AS total
     FROM material_receipt_lines WHERE dc_line_id = $1`,
    [dcLines[0].id],
  );
  assert.equal(total.rows[0].total, "60.00");
});

test("a discrepancy is recorded, notified, and never counted as received", async () => {
  const { dcId, dcLines } = await deliveryReadyToReceive("60");

  const received = await receive(
    dcId,
    {
      lines: [
        {
          dcLineId: dcLines[0].id,
          receivedQuantity: "50",
          discrepancyQuantity: "10",
          discrepancyType: "DAMAGED",
          discrepancyNote: "Ten bags torn in transit",
        },
      ],
    },
    ctx.tokens.teamLead,
  );
  assert.equal(received.status, 201, JSON.stringify(received.body));
  const receiptId = received.body.data.receipt.id;
  assert.equal(received.body.data.receipt.has_discrepancy, true);
  assert.equal(received.body.data.lines[0].received_quantity, "50.00");
  assert.equal(received.body.data.lines[0].discrepancy_quantity, "10.00");
  assert.equal(received.body.data.lines[0].discrepancy_type, "DAMAGED");

  // Received and discrepant quantities are never collapsed into one number.
  assert.notEqual(received.body.data.lines[0].received_quantity, received.body.data.lines[0].dc_quantity);

  const notified = await pool.query(
    `SELECT DISTINCT recipient_user_id FROM notification_outbox
     WHERE entity_id = $1 AND event_type = 'RECEIVING_DISCREPANCY'`,
    [receiptId],
  );
  const recipients = notified.rows.map((row) => row.recipient_user_id);
  assert.ok(recipients.includes(users.teamLead), "the department's confirming authority is told");
  assert.ok(recipients.includes(users.ceo), "Procurement/management is told");
  assert.ok(!recipients.includes(users.guard), "unrelated users are never notified");

  // A recorded receipt line is history: never edited, never deleted.
  await assert.rejects(
    pool.query("UPDATE material_receipt_lines SET received_quantity = 60 WHERE receipt_id = $1", [receiptId]),
    /append-only/i,
  );
});

test("a replayed confirmation never double-closes, and closure requires every quantity resolved", async () => {
  const { ipoId, dcId, dcLines } = await deliveryReadyToReceive("60");

  const partial = await receive(dcId, { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "30" }] }, ctx.tokens.teamLead);
  const receiptId = partial.body.data.receipt.id;
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/confirm`, {
      token: ctx.tokens.teamLead,
    })).status,
    200,
  );

  // Half the challan is still outstanding, so nothing closes.
  let dc = await pool.query("SELECT status FROM delivery_challans WHERE id = $1", [dcId]);
  assert.equal(dc.rows[0].status, "RECEIVING");
  let ipo = await pool.query("SELECT status FROM ipos WHERE id = $1", [ipoId]);
  assert.equal(ipo.rows[0].status, "PURCHASING");

  // Replaying the confirmation is a no-op, not a second closure evaluation.
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/confirm`, {
      token: ctx.tokens.teamLead,
    })).status,
    200,
  );
  const confirmations = await pool.query(
    "SELECT count(*)::int AS n FROM procurement_audit_log WHERE entity_id = $1 AND action = 'RECEIPT_CONFIRMED'",
    [receiptId],
  );
  assert.equal(confirmations.rows[0].n, 1);

  const rest = await receive(dcId, { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "30" }] }, ctx.tokens.teamLead);
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${rest.body.data.receipt.id}/confirm`, {
      token: ctx.tokens.teamLead,
    })).status,
    200,
  );

  // The challan is now fully received and confirmed.
  dc = await pool.query("SELECT status FROM delivery_challans WHERE id = $1", [dcId]);
  assert.equal(dc.rows[0].status, "COMPLETED");

  // The IPO still does NOT close: purchasing was never explicitly closed, so
  // the approved-but-unpurchased balance is not yet resolved.
  ipo = await pool.query("SELECT status FROM ipos WHERE id = $1", [ipoId]);
  assert.equal(ipo.rows[0].status, "PURCHASING");
});

test("confirmation requires receiving.confirm and stays within the owning department", async () => {
  const { dcId, dcLines } = await deliveryReadyToReceive("60");
  const received = await receive(dcId, { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "60" }] }, ctx.tokens.teamLead);
  const receiptId = received.body.data.receipt.id;

  // An EMPLOYEE may receive but may not close the cycle.
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/confirm`, {
      token: ctx.tokens.employee,
    })).status,
    403,
  );
  // Another department's lead holds the capability but not the scope.
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/confirm`, {
      token: ctx.tokens.teamLeadOtherDept,
    })).status,
    404,
  );

  await setOverride(users.teamLead, "receiving.confirm", "DENY", users.ceo);
  try {
    assert.equal(
      (await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/confirm`, {
        token: ctx.tokens.teamLead,
      })).status,
      403,
      "an individual DENY still wins",
    );
  } finally {
    await clearOverride(users.teamLead, "receiving.confirm");
  }
});

test("receiving records physical arrival only — no stock or inventory table exists", async () => {
  const forbidden = await pool.query(
    `SELECT table_name FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN ('stock_movements', 'stock_balances', 'inventory_batches',
                          'material_issues', 'material_usage', 'material_returns',
                          'stock_adjustments', 'stock_transfers')`,
  );
  assert.equal(forbidden.rowCount, 0, "V1 must not introduce any inventory-balance schema");

  const { dcId, dcLines } = await deliveryReadyToReceive("60");
  const received = await receive(dcId, { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "60" }] }, ctx.tokens.teamLead);
  const serialized = JSON.stringify(received.body);
  assert.ok(!/current_stock|stock_balance|available_quantity/i.test(serialized));
});

test("receiving carries no commercial data for the department that receives it", async () => {
  const { dcId, dcLines } = await deliveryReadyToReceive("60");
  const received = await receive(dcId, { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "60" }] }, ctx.tokens.teamLead);

  const detail = await apiRequest(
    ctx.baseUrl,
    "GET",
    `/api/v1/receiving/receipts/${received.body.data.receipt.id}`,
    { token: ctx.tokens.employee },
  );
  assert.equal(detail.status, 200);
  const serialized = JSON.stringify(detail.body);
  assert.ok(!serialized.includes("48.00"), "the actual purchase price is never exposed to a receiver");
  assert.ok(!/unit_price|estimated_total|actual_unit_price/.test(serialized));
});

test("a retried receipt books the same physical delivery only once", async () => {
  const { dcId, dcLines } = await deliveryReadyToReceive("100");
  const operationId = randomUUID();
  const body = { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "20" }] };

  const first = await receive(dcId, body, ctx.tokens.teamLead, operationId);
  assert.equal(first.status, 201);
  const receiptId = first.body.data.receipt.id;

  const countAudit = async () =>
    (await pool.query(
      "SELECT count(*)::int AS n FROM procurement_audit_log WHERE entity_id = $1 AND action = 'RECEIPT_RECORDED'",
      [receiptId],
    )).rows[0].n;
  // One row per eligible recipient is correct routing; what must not change is
  // the total, so it is compared before and after the retry.
  const countNotifications = async () =>
    (await pool.query(
      "SELECT count(*)::int AS n FROM notification_outbox WHERE entity_id = $1 AND event_type = 'MATERIAL_RECEIVED'",
      [receiptId],
    )).rows[0].n;

  const auditBefore = await countAudit();
  const notificationsBefore = await countNotifications();
  assert.equal(auditBefore, 1);
  assert.ok(notificationsBefore >= 1);

  // The response was lost; the receiver's device retries the same request.
  const replay = await receive(dcId, body, ctx.tokens.teamLead, operationId);
  assert.equal(replay.status, 201);
  assert.equal(replay.body.data.receipt.id, receiptId, "the same logical receipt is returned");

  const totals = await pool.query(
    `SELECT COUNT(*)::int AS receipts,
            COALESCE(SUM(received_quantity), 0)::numeric(12,2) AS received
     FROM material_receipt_lines WHERE dc_line_id = $1`,
    [dcLines[0].id],
  );
  assert.equal(totals.rows[0].receipts, 1, "one logical receipt, not two");
  assert.equal(totals.rows[0].received, "20.00", "physical reality is 20, and so is the system");

  // Nothing actually happened the second time, so nothing was audited or
  // notified again.
  assert.equal(await countAudit(), auditBefore);
  assert.equal(await countNotifications(), notificationsBefore);

  // A genuinely separate partial receipt carries its own operation id.
  const second = await receive(dcId, body, ctx.tokens.teamLead);
  assert.equal(second.status, 201);
  assert.notEqual(second.body.data.receipt.id, receiptId);
  const after = await pool.query(
    "SELECT COALESCE(SUM(received_quantity), 0)::numeric(12,2) AS received FROM material_receipt_lines WHERE dc_line_id = $1",
    [dcLines[0].id],
  );
  assert.equal(after.rows[0].received, "40.00");
});

test("two concurrent retries of one receipt still produce a single receipt", async () => {
  const { dcId, dcLines } = await deliveryReadyToReceive("100");
  const operationId = randomUUID();
  const body = { lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "30" }] };

  await Promise.all([
    receive(dcId, body, ctx.tokens.teamLead, operationId),
    receive(dcId, body, ctx.tokens.teamLead, operationId),
  ]);

  const totals = await pool.query(
    `SELECT COUNT(DISTINCT receipt_id)::int AS receipts,
            COALESCE(SUM(received_quantity), 0)::numeric(12,2) AS received
     FROM material_receipt_lines WHERE dc_line_id = $1`,
    [dcLines[0].id],
  );
  assert.equal(totals.rows[0].receipts, 1);
  assert.equal(totals.rows[0].received, "30.00");
});

test("Admin fallback authority reaches the delivery it must receive, and nothing else", async () => {
  // A delivery for the Civil department; Admin belongs to no department.
  const { ipoId, dcId, dcLines } = await deliveryReadyToReceive("60");

  // Admin CAN see and act on the open delivery at their own site. Looked up by
  // its own number rather than scanning page one: the shared test database
  // accumulates open deliveries across the suite, and paging is not what this
  // test is about.
  const dcNumber = (await pool.query("SELECT dc_number FROM delivery_challans WHERE id = $1", [dcId]))
    .rows[0].dc_number;
  const queue = await apiRequest(
    ctx.baseUrl,
    "GET",
    `/api/v1/receiving/challans?search=${encodeURIComponent(dcNumber)}`,
    { token: ctx.tokens.admin },
  );
  assert.equal(queue.status, 200);
  assert.ok(queue.body.data.some((row) => row.id === dcId), "the fallback custodian sees actionable deliveries");

  const delivery = await apiRequest(ctx.baseUrl, "GET", `/api/v1/receiving/challans/${dcId}`, {
    token: ctx.tokens.admin,
  });
  assert.equal(delivery.status, 200);

  const custody = await receive(
    dcId,
    { fallback: true, lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "60" }] },
    ctx.tokens.admin,
  );
  assert.equal(custody.status, 201, JSON.stringify(custody.body));

  // ...but that authority does NOT become general cross-department access.
  const forbiddenSurfaces = [
    `/api/v1/ipos/${ipoId}`,
    "/api/v1/ipos?pageSize=100",
    `/api/v1/delivery-challans/${dcId}`,
    "/api/v1/delivery-challans?pageSize=100",
  ];
  for (const path of forbiddenSurfaces) {
    const response = await apiRequest(ctx.baseUrl, "GET", path, { token: ctx.tokens.admin });
    if (response.status === 200 && Array.isArray(response.body.data)) {
      assert.equal(
        response.body.data.filter((row) => row.id === ipoId || row.id === dcId).length,
        0,
        `${path} exposed another department's record to the fallback custodian`,
      );
    } else {
      assert.ok([403, 404].includes(response.status), `${path} returned ${response.status}`);
    }
  }

  // Receiving HISTORY is not widened either. A receipt the DEPARTMENT recorded
  // on a different delivery must not appear in the fallback custodian's list.
  const otherDelivery = await deliveryReadyToReceive("30");
  const departmentReceipt = await receive(
    otherDelivery.dcId,
    { lines: [{ dcLineId: otherDelivery.dcLines[0].id, receivedQuantity: "30" }] },
    ctx.tokens.teamLead,
  );
  assert.equal(departmentReceipt.status, 201);

  const adminReceipts = await apiRequest(ctx.baseUrl, "GET", "/api/v1/receiving/receipts?pageSize=100", {
    token: ctx.tokens.admin,
  });
  assert.equal(adminReceipts.status, 200);
  assert.ok(
    adminReceipts.body.data.some((row) => row.id === custody.body.data.receipt.id),
    "the custodian still sees the receipt they are responsible for",
  );
  assert.ok(
    !adminReceipts.body.data.some((row) => row.id === departmentReceipt.body.data.receipt.id),
    "but never a receipt the department recorded itself",
  );

  // Carry-forward and Procurement exports stay closed to Admin.
  const carryForward = await apiRequest(
    ctx.baseUrl,
    "GET",
    `/api/v1/ipos/outstanding?catalogEntryIds=${"00000000-0000-0000-0000-000000000000"}`,
    { token: ctx.tokens.admin },
  );
  assert.ok(carryForward.status !== 200 || carryForward.body.data.length === 0);
});

test("Admin fallback custody cannot cross a site boundary", async () => {
  const { dcId, dcLines } = await deliveryReadyToReceive("60");

  const crossSite = await receive(
    dcId,
    { fallback: true, lines: [{ dcLineId: dcLines[0].id, receivedQuantity: "60" }] },
    ctx.tokens.otherSiteAdmin,
  );
  assert.equal(crossSite.status, 404);

  // The other site's Admin cannot even see the delivery in their queue —
  // asked for by name, so this is a real absence rather than a paging effect.
  const dcNumber = (await pool.query("SELECT dc_number FROM delivery_challans WHERE id = $1", [dcId]))
    .rows[0].dc_number;
  const queue = await apiRequest(
    ctx.baseUrl,
    "GET",
    `/api/v1/receiving/challans?search=${encodeURIComponent(dcNumber)}`,
    { token: ctx.tokens.otherSiteAdmin },
  );
  assert.equal(queue.status, 200);
  assert.ok(!queue.body.data.some((row) => row.id === dcId));
});
