import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers, TEST_PASSWORD } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { buildApprovedIpo, createFinalizedDc, recordPurchase } from "./procurement-chain-helpers.js";
import { setOverride, clearOverride } from "./procurement-chain-helpers.js";

// Fallback custody is a physical act, not an organizational promotion. An
// Admin who takes temporary custody of another department's delivery must be
// able to follow the handover they are personally responsible for — and must
// still be unable to browse that department. The two are not in tension: one
// is about a specific receipt, the other about a department.

let ctx;
let users;
let uomId;
let adminDeptId;
let adminA;
let adminB;

async function makeUser(email, name, roleName, departmentId, siteId) {
  const hash = await argon2.hash(TEST_PASSWORD);
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role_id, department_id, site_id)
     VALUES ($1, $2, $3, (SELECT id FROM roles WHERE name = $4), $5, $6)
     ON CONFLICT (email) DO UPDATE SET
       password_hash = EXCLUDED.password_hash, role_id = EXCLUDED.role_id,
       department_id = EXCLUDED.department_id, site_id = EXCLUDED.site_id, is_active = true
     RETURNING id`,
    [email, hash, name, roleName, departmentId, siteId],
  );
  return result.rows[0].id;
}

before(async () => {
  const server = await startTestServer();
  users = await seedUsers();

  const siteId = (
    await pool.query("SELECT site_id FROM departments WHERE id = $1", [users.departmentA])
  ).rows[0].site_id;

  // The point of this fixture: a REAL Admin, assigned to a real Admin
  // department — not an Admin with department_id NULL, which is the shape the
  // defect happened to be invisible under.
  //
  // An EXISTING seeded department, never a new one: seedUsers picks its
  // departmentA/departmentB with `ORDER BY name LIMIT 2`, so inserting a
  // department here would silently become another file's fixture — and
  // hard-coding a name would collide with that same LIMIT 2 on a clean
  // database, where the alphabetically-first department IS departmentA.
  adminDeptId = (
    await pool.query(
      `SELECT id FROM departments
       WHERE site_id = $1 AND id <> $2 AND id <> $3
       ORDER BY name LIMIT 1`,
      [siteId, users.departmentA, users.departmentB],
    )
  ).rows[0].id;

  adminA = await makeUser("hist-admin-a@test.eset.local", "History Admin A", "ADMIN", adminDeptId, siteId);
  adminB = await makeUser("hist-admin-b@test.eset.local", "History Admin B", "ADMIN", adminDeptId, siteId);
  await makeUser("hist-admin-lead@test.eset.local", "Admin Dept Lead", "TEAM_LEAD", adminDeptId, siteId);

  const tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    siteManager: await authHeader(server.baseUrl, "manager@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    teamLeadOtherDept: await authHeader(server.baseUrl, "teamlead2@test.eset.local"),
    adminA: await authHeader(server.baseUrl, "hist-admin-a@test.eset.local"),
    adminB: await authHeader(server.baseUrl, "hist-admin-b@test.eset.local"),
    adminDeptLead: await authHeader(server.baseUrl, "hist-admin-lead@test.eset.local"),
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
  // Guarded: a `before` that throws would otherwise leave the HTTP server and
  // pool handles open and hang the whole run instead of reporting the failure.
  if (ctx) await ctx.close();
});

// A finalized delivery for whichever department the creating Team Lead is in.
async function deliveryFor(creatorToken) {
  const ipo = await buildApprovedIpo(ctx, { uomId, quantities: [50], creatorToken });
  assert.equal(
    (await recordPurchase(ctx, ipo.ipoId, [
      { ipoLineId: ipo.ipoLines[0].id, quantity: "50", actualUnitPrice: "10.00" },
    ])).status,
    200,
  );
  const dc = await createFinalizedDc(ctx, ipo.ipoId, [{ ipoLineId: ipo.ipoLines[0].id, quantity: "50" }]);
  return { dcId: dc.dcId, dcLineId: dc.lines[0].id };
}

async function fallbackReceive(delivery, token, quantity = "50") {
  const response = await apiRequest(
    ctx.baseUrl,
    "POST",
    `/api/v1/receiving/challans/${delivery.dcId}/receipts`,
    {
      token,
      body: {
        operationId: randomUUID(),
        fallback: true,
        lines: [{ dcLineId: delivery.dcLineId, receivedQuantity: quantity }],
      },
    },
  );
  assert.equal(response.status, 201, JSON.stringify(response.body));
  return response.body.data.receipt.id;
}

// Pages through the WHOLE history rather than assuming a fixture sits on page
// one — the failure mode a previous pass shipped and had to correct.
async function allReceiptIds(token, extraQuery = "") {
  const ids = [];
  for (let page = 1; page <= 200; page += 1) {
    const response = await apiRequest(
      ctx.baseUrl,
      "GET",
      `/api/v1/receiving/receipts?page=${page}&pageSize=100${extraQuery}`,
      { token },
    );
    assert.equal(response.status, 200, JSON.stringify(response.body));
    ids.push(...response.body.data.map((row) => row.id));
    if (ids.length >= response.body.meta.total || response.body.data.length === 0) break;
  }
  return ids;
}

test("1+2+3 — a department-assigned Admin sees their own department's receipts AND the ones they personally handled", async () => {
  // Receipt 1: ordinary Admin-department receiving, handled by the OTHER Admin.
  const adminDelivery = await deliveryFor(ctx.tokens.adminDeptLead);
  const adminDeptReceipt = await fallbackReceive(adminDelivery, ctx.tokens.adminB);

  // Receipt 2: WTG material, fallback-received by Admin A personally.
  const wtgDelivery = await deliveryFor(ctx.tokens.teamLead);
  const ownFallbackReceipt = await fallbackReceive(wtgDelivery, ctx.tokens.adminA);

  // The fixture is realistic: Admin A has a real department, and the receipt
  // they handled belongs to a different one.
  assert.equal(
    (await pool.query("SELECT department_id FROM users WHERE id = $1", [adminA])).rows[0].department_id,
    adminDeptId,
  );
  assert.equal(
    (await pool.query("SELECT department_id FROM material_receipts WHERE id = $1", [ownFallbackReceipt]))
      .rows[0].department_id,
    users.departmentA,
  );

  const history = await allReceiptIds(ctx.tokens.adminA);
  assert.ok(history.includes(ownFallbackReceipt), "the receipt Admin A personally handled is missing");
  assert.ok(
    history.includes(adminDeptReceipt),
    "normal Admin-department history was replaced by personal-only history",
  );
});

test("4+5+6 — history does not become a window onto other departments", async () => {
  const ownFallback = await fallbackReceive(await deliveryFor(ctx.tokens.teamLead), ctx.tokens.adminA);
  // Same department, same site, handled entirely by the other Admin.
  const otherAdminsWtg = await fallbackReceive(await deliveryFor(ctx.tokens.teamLead), ctx.tokens.adminB);
  // A different department again.
  const ebop = await fallbackReceive(await deliveryFor(ctx.tokens.teamLeadOtherDept), ctx.tokens.adminB);

  const history = await allReceiptIds(ctx.tokens.adminA);
  assert.ok(history.includes(ownFallback));
  assert.ok(!history.includes(otherAdminsWtg), "another Admin's WTG receipt is enumerable");
  assert.ok(!history.includes(ebop), "an E-BOP receipt is enumerable");

  // And symmetrically for Admin B, which is what proves the exception is
  // actor-specific rather than Admin-department-wide.
  const historyB = await allReceiptIds(ctx.tokens.adminB);
  assert.ok(historyB.includes(otherAdminsWtg));
  assert.ok(!historyB.includes(ownFallback), "Admin B inherited Admin A's personal receipt");

  // Nothing outside Admin A's own department leaked in beyond what they handled.
  const departments = await pool.query(
    "SELECT DISTINCT department_id FROM material_receipts WHERE id = ANY($1::uuid[])",
    [history],
  );
  const personallyHandled = await pool.query(
    `SELECT id FROM material_receipts
     WHERE id = ANY($1::uuid[]) AND department_id <> $2
       AND (received_by_user_id = $3 OR handover_to_user_id = $3)`,
    [history, adminDeptId, adminA],
  );
  const foreign = history.filter(
    (id) => !personallyHandled.rows.some((r) => r.id === id),
  );
  const foreignDepartments = await pool.query(
    "SELECT DISTINCT department_id FROM material_receipts WHERE id = ANY($1::uuid[])",
    [foreign],
  );
  assert.deepEqual(
    foreignDepartments.rows.map((r) => r.department_id),
    foreign.length > 0 ? [adminDeptId] : [],
    "a receipt outside Admin A's department appeared without their personal involvement",
  );
  assert.ok(departments.rowCount <= 2);
});

test("7+8 — detail follows the same rule: their own receipt opens, another's does not", async () => {
  const own = await fallbackReceive(await deliveryFor(ctx.tokens.teamLead), ctx.tokens.adminA);
  const strangers = await fallbackReceive(await deliveryFor(ctx.tokens.teamLead), ctx.tokens.adminB);

  const mine = await apiRequest(ctx.baseUrl, "GET", `/api/v1/receiving/receipts/${own}`, {
    token: ctx.tokens.adminA,
  });
  assert.equal(mine.status, 200);

  const theirs = await apiRequest(ctx.baseUrl, "GET", `/api/v1/receiving/receipts/${strangers}`, {
    token: ctx.tokens.adminA,
  });
  assert.equal(theirs.status, 404, "a guessed WTG receipt id was readable");
  assert.ok(!JSON.stringify(theirs.body).includes(strangers.slice(0, 8)));
});

test("9 — handover does not erase the custodian's own history", async () => {
  const delivery = await deliveryFor(ctx.tokens.teamLead);
  const receiptId = await fallbackReceive(delivery, ctx.tokens.adminA);

  // The receiving department person acknowledges custody — the Admin does not
  // hand it to themselves.
  const handover = await apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/receipts/${receiptId}/handover`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(handover.status, 200, JSON.stringify(handover.body));

  const after = await pool.query(
    "SELECT received_by_user_id, handover_to_user_id, status FROM material_receipts WHERE id = $1",
    [receiptId],
  );
  assert.equal(after.rows[0].received_by_user_id, adminA, "the original receiver identity was rewritten");
  assert.equal(after.rows[0].handover_to_user_id, users.teamLead);

  assert.ok(
    (await allReceiptIds(ctx.tokens.adminA)).includes(receiptId),
    "handover removed the receipt from the custodian's history",
  );
  // The receiving department sees it too, by ordinary department scope.
  assert.ok((await allReceiptIds(ctx.tokens.teamLead)).includes(receiptId));
});

test("10 — fallback authority does not reach across sites", async () => {
  const own = await fallbackReceive(await deliveryFor(ctx.tokens.teamLead), ctx.tokens.adminA);

  // An Admin at the other site holds identical capabilities and still cannot
  // see or open it.
  assert.ok(!(await allReceiptIds(ctx.tokens.otherSiteAdmin)).includes(own));
  assert.equal(
    (await apiRequest(ctx.baseUrl, "GET", `/api/v1/receiving/receipts/${own}`, {
      token: ctx.tokens.otherSiteAdmin,
    })).status,
    404,
  );

  // And Admin A cannot reach the other site's deliveries to create one there.
  const otherSiteDelivery = await apiRequest(ctx.baseUrl, "GET", "/api/v1/receiving/challans?pageSize=100", {
    token: ctx.tokens.adminA,
  });
  const siteId = (await pool.query("SELECT site_id FROM users WHERE id = $1", [adminA])).rows[0].site_id;
  const sites = await pool.query(
    "SELECT DISTINCT site_id FROM delivery_challans WHERE id = ANY($1::uuid[])",
    [otherSiteDelivery.body.data.map((row) => row.id)],
  );
  assert.deepEqual(sites.rows.map((r) => r.site_id), sites.rowCount ? [siteId] : []);
});

test("11 — seeing a receipt is not seeing its money", async () => {
  const delivery = await deliveryFor(ctx.tokens.teamLead);
  const receiptId = await fallbackReceive(delivery, ctx.tokens.adminA);

  const detail = await apiRequest(ctx.baseUrl, "GET", `/api/v1/receiving/receipts/${receiptId}`, {
    token: ctx.tokens.adminA,
  });
  assert.equal(detail.status, 200);

  const body = JSON.stringify(detail.body);
  for (const field of [
    "unit_price",
    "actual_unit_price",
    "estimated_unit_price",
    "previous_unit_price",
    "estimated_line_total",
    "estimated_total",
    "actual_total",
    "procurement_note",
  ]) {
    assert.ok(!body.includes(field), `${field} reached a price-blind custodian`);
  }
  assert.ok(!body.includes("10.00"), "a purchase price reached a price-blind custodian");

  const list = await apiRequest(ctx.baseUrl, "GET", "/api/v1/receiving/receipts?pageSize=100", {
    token: ctx.tokens.adminA,
  });
  assert.ok(!JSON.stringify(list.body).includes("unit_price"));
});

test("12 — personal receipt history grants no Procurement reach", async () => {
  const delivery = await deliveryFor(ctx.tokens.teamLead);
  const receiptId = await fallbackReceive(delivery, ctx.tokens.adminA);
  const ipoId = (
    await pool.query(
      "SELECT ipo_id FROM delivery_challans WHERE id = (SELECT dc_id FROM material_receipts WHERE id = $1)",
      [receiptId],
    )
  ).rows[0].ipo_id;

  // The IPO behind a receipt they personally handled is still out of reach.
  assert.equal(
    (await apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/${ipoId}`, { token: ctx.tokens.adminA })).status,
    404,
  );

  const ipoList = await apiRequest(ctx.baseUrl, "GET", "/api/v1/ipos?pageSize=100", {
    token: ctx.tokens.adminA,
  });
  assert.ok([200, 403].includes(ipoList.status));
  if (ipoList.status === 200) {
    assert.ok(!ipoList.body.data.some((row) => row.id === ipoId));
  }

  const exportAttempt = await apiRequest(
    ctx.baseUrl,
    "GET",
    `/api/v1/reports/procurement/receiving?departmentId=${users.departmentA}`,
    { token: ctx.tokens.adminA },
  );
  assert.ok([403, 404].includes(exportAttempt.status), `export returned ${exportAttempt.status}`);
});

test("13 — an explicit DENY still wins", async () => {
  const receiptId = await fallbackReceive(await deliveryFor(ctx.tokens.teamLead), ctx.tokens.adminA);
  assert.ok((await allReceiptIds(ctx.tokens.adminA)).includes(receiptId));

  await setOverride(adminA, "receiving.fallback_receive", "DENY", users.ceo);
  try {
    const denied = await authHeader(ctx.baseUrl, "hist-admin-a@test.eset.local");
    const history = await allReceiptIds(denied);
    assert.ok(
      !history.includes(receiptId),
      "a denied capability still produced the personal-history exception",
    );
    // Their ordinary department history is unaffected by the denial.
    const adminDeptReceipts = await pool.query(
      "SELECT count(*)::int AS n FROM material_receipts WHERE department_id = $1",
      [adminDeptId],
    );
    if (adminDeptReceipts.rows[0].n > 0) assert.ok(history.length > 0);
  } finally {
    await clearOverride(adminA, "receiving.fallback_receive");
  }
});

test("14 — a department filter narrows and never carries the exception", async () => {
  const own = await fallbackReceive(await deliveryFor(ctx.tokens.teamLead), ctx.tokens.adminA);

  // Filtering to a department they have no scope over is refused outright,
  // exactly as before this fix.
  const foreign = await apiRequest(
    ctx.baseUrl,
    "GET",
    `/api/v1/receiving/receipts?departmentId=${users.departmentA}&pageSize=100`,
    { token: ctx.tokens.adminA },
  );
  assert.equal(foreign.status, 404);

  // Filtering to their own department returns their own department only —
  // the personal WTG receipt is not smuggled in by the exception.
  const ownDepartment = await allReceiptIds(ctx.tokens.adminA, `&departmentId=${adminDeptId}`);
  assert.ok(!ownDepartment.includes(own), "a department filter widened instead of narrowing");
  const departments = await pool.query(
    "SELECT DISTINCT department_id FROM material_receipts WHERE id = ANY($1::uuid[])",
    [ownDepartment],
  );
  assert.deepEqual(departments.rows.map((r) => r.department_id), ownDepartment.length ? [adminDeptId] : []);

  // An ordinary Team Lead is unchanged: no fallback authority, no exception.
  const leadHistory = await allReceiptIds(ctx.tokens.teamLead);
  const leadDepartments = await pool.query(
    "SELECT DISTINCT department_id FROM material_receipts WHERE id = ANY($1::uuid[])",
    [leadHistory],
  );
  assert.deepEqual(
    leadDepartments.rows.map((r) => r.department_id),
    leadHistory.length ? [users.departmentA] : [],
  );
});
