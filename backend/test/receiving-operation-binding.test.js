import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers, TEST_PASSWORD } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { buildApprovedIpo, createFinalizedDc, recordPurchase } from "./procurement-chain-helpers.js";

// An operation id makes a receipt retryable after a lost response. It does not
// make a different request succeed: answering "we received 30" with the receipt
// that booked 20 reports material that never arrived, with a success status, and
// the missing 10 surfaces only when somebody counts the yard.

let ctx;
let users;
let uomId;
let adminA;

before(async () => {
  const server = await startTestServer();
  users = await seedUsers();

  // A realistic Admin with a real department, so fallback custody is testable
  // without relying on a department-less account.
  const siteId = (await pool.query("SELECT site_id FROM departments WHERE id = $1", [users.departmentA]))
    .rows[0].site_id;
  const adminDeptId = (
    await pool.query(
      `SELECT id FROM departments WHERE site_id = $1 AND id <> $2 AND id <> $3 ORDER BY name LIMIT 1`,
      [siteId, users.departmentA, users.departmentB],
    )
  ).rows[0].id;
  const hash = await argon2.hash(TEST_PASSWORD);
  adminA = (
    await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role_id, department_id, site_id)
       VALUES ($1, $2, 'Receipt Binding Admin', (SELECT id FROM roles WHERE name = 'ADMIN'), $3, $4)
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash,
         department_id = EXCLUDED.department_id, site_id = EXCLUDED.site_id, is_active = true
       RETURNING id`,
      ["rx-binding-admin@test.eset.local", hash, adminDeptId, siteId],
    )
  ).rows[0].id;

  const tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    adminA: await authHeader(server.baseUrl, "rx-binding-admin@test.eset.local"),
  };
  const uoms = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: tokens.ceo,
  });
  uomId = uoms.body.data[0].id;
  ctx = { baseUrl: server.baseUrl, tokens, close: server.close };
});

after(async () => {
  if (ctx) await ctx.close();
});

// A finalized Delivery Challan with `quantities` on its lines.
async function deliveryOf(quantities = [100, 100]) {
  const ipo = await buildApprovedIpo(ctx, { uomId, quantities });
  assert.equal(
    (await recordPurchase(
      ctx,
      ipo.ipoId,
      ipo.ipoLines.map((line, index) => ({
        ipoLineId: line.id,
        quantity: String(quantities[index]),
        actualUnitPrice: "10.00",
      })),
    )).status,
    200,
  );
  return createFinalizedDc(
    ctx,
    ipo.ipoId,
    ipo.ipoLines.map((line, index) => ({ ipoLineId: line.id, quantity: String(quantities[index]) })),
  );
}

const receive = (delivery, operationId, lines, extra = {}, token) =>
  apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/challans/${delivery.dcId}/receipts`, {
    token: token || ctx.tokens.teamLead,
    body: { operationId, lines, ...extra },
  });

const one = (delivery, quantity, index = 0) => [
  { dcLineId: delivery.lines[index].id, receivedQuantity: quantity },
];

const booked = async (receiptId) =>
  (
    await pool.query(
      `SELECT COALESCE(SUM(received_quantity), 0)::numeric(12,2) AS received,
              COALESCE(SUM(discrepancy_quantity), 0)::numeric(12,2) AS discrepancy,
              count(*)::int AS lines
       FROM material_receipt_lines WHERE receipt_id = $1`,
      [receiptId],
    )
  ).rows[0];

const receiptsOn = async (dcId) =>
  (await pool.query("SELECT count(*)::int AS n FROM material_receipts WHERE dc_id = $1", [dcId])).rows[0].n;

// What the challan still has outstanding: its line quantities minus everything
// already received or recorded as a discrepancy against them.
const dcUnresolved = async (dcId) =>
  (
    await pool.query(
      `SELECT (COALESCE(SUM(dcl.quantity), 0)
               - COALESCE((SELECT SUM(rl.received_quantity + rl.discrepancy_quantity)
                           FROM material_receipt_lines rl
                           JOIN material_receipts r ON r.id = rl.receipt_id
                           WHERE r.dc_id = $1), 0))::numeric(12,2) AS q
       FROM delivery_challan_lines dcl WHERE dcl.dc_id = $1`,
      [dcId],
    )
  ).rows[0].q;

const auditsFor = async (receiptId) =>
  (
    await pool.query(
      "SELECT count(*)::int AS n FROM procurement_audit_log WHERE entity_id = $1 AND action IN ('RECEIPT_RECORDED','ADMIN_CUSTODY_RECORDED')",
      [receiptId],
    )
  ).rows[0].n;

const outboxFor = async (dcId) =>
  (
    await pool.query(
      `SELECT count(*)::int AS n FROM notification_outbox o
       JOIN material_receipts r ON r.id = o.entity_id WHERE r.dc_id = $1`,
      [dcId],
    )
  ).rows[0].n;

test("1 — an exact replay returns the same receipt and books nothing further", async () => {
  const delivery = await deliveryOf();
  const op = randomUUID();

  const first = await receive(delivery, op, one(delivery, "20"));
  assert.equal(first.status, 201, JSON.stringify(first.body));
  const receiptId = first.body.data.receipt.id;

  const replay = await receive(delivery, op, one(delivery, "20"));
  assert.equal(replay.status, 201);
  assert.equal(replay.body.data.receipt.id, receiptId);

  assert.deepEqual(await booked(receiptId), { received: "20.00", discrepancy: "0.00", lines: 1 });
  assert.equal(await receiptsOn(delivery.dcId), 1);
  assert.equal(await auditsFor(receiptId), 1, "the replay wrote a second receipt audit");
});

test("2 — the same id with a different quantity conflicts", async () => {
  const delivery = await deliveryOf();
  const op = randomUUID();
  const receiptId = (await receive(delivery, op, one(delivery, "20"))).body.data.receipt.id;

  const mismatch = await receive(delivery, op, one(delivery, "30"));
  assert.equal(mismatch.status, 409, "a request to record 30 was answered with the 20 receipt");
  assert.notEqual(mismatch.body?.data?.receipt?.id, receiptId);
  assert.deepEqual(await booked(receiptId), { received: "20.00", discrepancy: "0.00", lines: 1 });
});

test("3 — the same id against a different Delivery Challan conflicts", async () => {
  const a = await deliveryOf();
  const b = await deliveryOf();
  const op = randomUUID();

  assert.equal((await receive(a, op, one(a, "20"))).status, 201);
  assert.equal((await receive(b, op, one(b, "20"))).status, 409);
  assert.equal(await receiptsOn(b.dcId), 0, "a receipt was created on the wrong challan");
});

test("4+5 — the line set and each line's quantity are part of the operation", async () => {
  const delivery = await deliveryOf();
  const op = randomUUID();
  const receiptId = (
    await receive(delivery, op, [
      { dcLineId: delivery.lines[0].id, receivedQuantity: "20" },
      { dcLineId: delivery.lines[1].id, receivedQuantity: "10" },
    ])
  ).body.data.receipt.id;

  // One line's quantity changed.
  assert.equal(
    (await receive(delivery, op, [
      { dcLineId: delivery.lines[0].id, receivedQuantity: "20" },
      { dcLineId: delivery.lines[1].id, receivedQuantity: "15" },
    ])).status,
    409,
  );
  // A line dropped.
  assert.equal((await receive(delivery, op, one(delivery, "20"))).status, 409);
  // A different line entirely.
  assert.equal((await receive(delivery, op, one(delivery, "20", 1))).status, 409);

  // Order carries no meaning, so a reordered identical set is still a replay.
  const reordered = await receive(delivery, op, [
    { dcLineId: delivery.lines[1].id, receivedQuantity: "10" },
    { dcLineId: delivery.lines[0].id, receivedQuantity: "20" },
  ]);
  assert.equal(reordered.status, 201, "a reordered identical payload was refused");
  assert.equal(reordered.body.data.receipt.id, receiptId);

  assert.deepEqual(await booked(receiptId), { received: "30.00", discrepancy: "0.00", lines: 2 });
});

test("6 — discrepancy facts are part of the operation", async () => {
  const delivery = await deliveryOf();
  const op = randomUUID();
  const receiptId = (
    await receive(delivery, op, [
      {
        dcLineId: delivery.lines[0].id,
        receivedQuantity: "15",
        discrepancyQuantity: "5",
        discrepancyType: "SHORT",
      },
    ])
  ).body.data.receipt.id;

  // Discrepancy dropped.
  assert.equal((await receive(delivery, op, one(delivery, "15"))).status, 409);
  // Discrepancy quantity changed.
  assert.equal(
    (await receive(delivery, op, [
      { dcLineId: delivery.lines[0].id, receivedQuantity: "15", discrepancyQuantity: "3", discrepancyType: "SHORT" },
    ])).status,
    409,
  );
  // Same quantities, different KIND of discrepancy — a short delivery and a
  // damaged one are not the same fact.
  assert.equal(
    (await receive(delivery, op, [
      { dcLineId: delivery.lines[0].id, receivedQuantity: "15", discrepancyQuantity: "5", discrepancyType: "DAMAGED" },
    ])).status,
    409,
  );

  const state = await booked(receiptId);
  assert.equal(state.received, "15.00");
  assert.equal(state.discrepancy, "5.00");
  assert.equal(
    (await pool.query("SELECT discrepancy_type FROM material_receipt_lines WHERE receipt_id = $1", [receiptId]))
      .rows[0].discrepancy_type,
    "SHORT",
  );
});

test("7 — custody mode is part of the operation, and Admin authority is unchanged", async () => {
  const delivery = await deliveryOf();
  const op = randomUUID();
  const receiptId = (await receive(delivery, op, one(delivery, "20"))).body.data.receipt.id;

  // Same id, same quantity, but claimed as temporary Admin custody.
  const asFallback = await receive(delivery, op, one(delivery, "20"), { fallback: true }, ctx.tokens.adminA);
  assert.equal(asFallback.status, 409, "an ordinary receipt was replayed as Admin custody");

  assert.equal(
    (await pool.query("SELECT receipt_type FROM material_receipts WHERE id = $1", [receiptId])).rows[0]
      .receipt_type,
    "DEPARTMENT",
  );
  // And the reverse: a fallback receipt cannot be replayed as a department one.
  const other = await deliveryOf();
  const fallbackOp = randomUUID();
  assert.equal(
    (await receive(other, fallbackOp, one(other, "20"), { fallback: true }, ctx.tokens.adminA)).status,
    201,
  );
  assert.equal((await receive(other, fallbackOp, one(other, "20"))).status, 409);
});

test("8 — two concurrent exact replays produce exactly one receipt", async () => {
  const delivery = await deliveryOf();
  const op = randomUUID();

  const results = await Promise.all([
    receive(delivery, op, one(delivery, "20")),
    receive(delivery, op, one(delivery, "20")),
  ]);
  assert.ok(results.every((r) => [201, 409].includes(r.status)), JSON.stringify(results.map((r) => r.status)));

  assert.equal(await receiptsOn(delivery.dcId), 1);
  const receiptId = (
    await pool.query("SELECT id FROM material_receipts WHERE dc_id = $1", [delivery.dcId])
  ).rows[0].id;
  assert.deepEqual(await booked(receiptId), { received: "20.00", discrepancy: "0.00", lines: 1 });
  assert.equal(await auditsFor(receiptId), 1);
});

test("9 — concurrent differing payloads leave one winner and never 50 units", async () => {
  const delivery = await deliveryOf();
  const op = randomUUID();

  const [a, b] = await Promise.all([
    receive(delivery, op, one(delivery, "20")),
    receive(delivery, op, one(delivery, "30")),
  ]);
  assert.equal([a, b].filter((r) => r.status === 201).length, 1, "both payloads claimed the same id");
  assert.equal([a, b].filter((r) => r.status === 409).length, 1);

  assert.equal(await receiptsOn(delivery.dcId), 1);
  const receiptId = (
    await pool.query("SELECT id FROM material_receipts WHERE dc_id = $1", [delivery.dcId])
  ).rows[0].id;
  const state = await booked(receiptId);
  assert.ok(["20.00", "30.00"].includes(state.received), `booked ${state.received}`);
});

test("10+11+12 — a refused mismatch has zero business side effects", async () => {
  const delivery = await deliveryOf();
  const op = randomUUID();
  const receiptId = (await receive(delivery, op, one(delivery, "20"))).body.data.receipt.id;

  const before = {
    booked: await booked(receiptId),
    receipts: await receiptsOn(delivery.dcId),
    unresolved: await dcUnresolved(delivery.dcId),
    audits: await auditsFor(receiptId),
    outbox: await outboxFor(delivery.dcId),
    dcStatus: (await pool.query("SELECT status FROM delivery_challans WHERE id = $1", [delivery.dcId]))
      .rows[0].status,
    handover: (
      await pool.query("SELECT handover_to_user_id, status FROM material_receipts WHERE id = $1", [receiptId])
    ).rows[0],
  };

  assert.equal((await receive(delivery, op, one(delivery, "30"))).status, 409);

  assert.deepEqual(await booked(receiptId), before.booked);
  assert.equal(await receiptsOn(delivery.dcId), before.receipts);
  assert.equal(await dcUnresolved(delivery.dcId), before.unresolved, "the challan aggregate moved");
  assert.equal(await auditsFor(receiptId), before.audits, "a mismatched replay was audited");
  assert.equal(await outboxFor(delivery.dcId), before.outbox, "a mismatched replay notified somebody");
  assert.equal(
    (await pool.query("SELECT status FROM delivery_challans WHERE id = $1", [delivery.dcId])).rows[0].status,
    before.dcStatus,
  );
  assert.deepEqual(
    (await pool.query("SELECT handover_to_user_id, status FROM material_receipts WHERE id = $1", [receiptId]))
      .rows[0],
    before.handover,
  );
});

test("13 — the conflict discloses nothing about the operation's real owner", async () => {
  const a = await deliveryOf();
  const b = await deliveryOf();
  const op = randomUUID();

  const owned = await receive(a, op, one(a, "37"));
  assert.equal(owned.status, 201);
  const receiptId = owned.body.data.receipt.id;
  const receiptNumber = owned.body.data.receipt.receipt_number || "";

  const conflict = await receive(b, op, one(b, "20"));
  assert.equal(conflict.status, 409);

  const body = JSON.stringify(conflict.body);
  for (const secret of [a.dcId, receiptId, receiptNumber, "37.00", "37"]) {
    if (secret) assert.ok(!body.includes(secret), `the conflict leaked ${secret}`);
  }
  assert.match(conflict.body.error.message, /already been used/i);
});

test("14 — a different operation id is still a genuine second partial receipt", async () => {
  const delivery = await deliveryOf([100]);

  assert.equal((await receive(delivery, randomUUID(), one(delivery, "20"))).status, 201);
  assert.equal((await receive(delivery, randomUUID(), one(delivery, "30"))).status, 201);

  assert.equal(await receiptsOn(delivery.dcId), 2, "a genuine second partial receipt was swallowed");
  const total = await pool.query(
    `SELECT COALESCE(SUM(rl.received_quantity), 0)::numeric(12,2) AS q
     FROM material_receipt_lines rl JOIN material_receipts r ON r.id = rl.receipt_id
     WHERE r.dc_id = $1`,
    [delivery.dcId],
  );
  assert.equal(total.rows[0].q, "50.00");

  // Over-receipt protection is untouched.
  assert.equal((await receive(delivery, randomUUID(), one(delivery, "60"))).status, 400);
});
