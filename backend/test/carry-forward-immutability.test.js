import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { buildApprovedIpo, recordPurchase } from "./procurement-chain-helpers.js";

// The allocation ledger is what makes a carried quantity a claim rather than a
// note. A claim that can be restated afterwards is not a claim: rewriting 25 to
// 10 frees 15 that a second Demand already spent, and repointing a source or a
// department moves the same history somewhere it never happened. Only release
// may move, and only once.

let ctx;
let uomId;

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

// An IPO whose purchasing closed 40 short on line one — a real source.
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
  return { catalogEntryId, sourceId: built.ipoLines[0].id };
}

async function carryForward(catalogEntryId, sourceId, quantity, sourceType = "UNPURCHASED_IPO_QUANTITY") {
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
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const demandId = created.body.data.demand.id;
  const submitted = await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/submit`, {
    token: ctx.tokens.teamLead,
  });
  assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
  return demandId;
}

// An ACTIVE allocation of 25 from an unpurchased-IPO source.
async function activeAllocation(quantity = "25") {
  const { catalogEntryId, sourceId } = await shortfallOf40();
  const demandId = await carryForward(catalogEntryId, sourceId, quantity);
  const row = (
    await pool.query("SELECT * FROM carry_forward_allocations WHERE target_demand_id = $1", [demandId])
  ).rows[0];
  assert.equal(row.status, "ACTIVE");
  return { row, demandId, catalogEntryId, sourceId };
}

const rowById = async (id) =>
  (await pool.query("SELECT * FROM carry_forward_allocations WHERE id = $1", [id])).rows[0];

const outstandingFor = (catalogEntryId) =>
  apiRequest(ctx.baseUrl, "GET", `/api/v1/ipos/outstanding?catalogEntryIds=${catalogEntryId}`, {
    token: ctx.tokens.teamLead,
  });

// Every attempt runs in its own transaction so a rejection cannot be mistaken
// for a rollback of something that partially applied.
async function attempt(sql, params) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(sql, params);
    await client.query("COMMIT");
    return null;
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    return error.message;
  } finally {
    client.release();
  }
}

const RELEASE = "status = 'RELEASED', released_at = CURRENT_TIMESTAMP";

test("1 — the allocated quantity cannot be rewritten, with or without a release", async () => {
  const { row } = await activeAllocation("25");

  assert.match(
    await attempt("UPDATE carry_forward_allocations SET allocated_quantity = 10 WHERE id = $1", [row.id]),
    /may only be released/,
  );
  // Smuggled inside an otherwise legitimate release — this is the frozen-field
  // rule itself, not the "only release" rule.
  assert.match(
    await attempt(
      `UPDATE carry_forward_allocations SET ${RELEASE}, allocated_quantity = 10 WHERE id = $1`,
      [row.id],
    ),
    /source, target and quantity are immutable/,
  );
  assert.match(
    await attempt(`UPDATE carry_forward_allocations SET ${RELEASE}, source_quantity = 999 WHERE id = $1`, [
      row.id,
    ]),
    /source, target and quantity are immutable/,
  );

  assert.equal((await rowById(row.id)).allocated_quantity, "25.00");
  assert.equal((await rowById(row.id)).status, "ACTIVE");
});

test("2+3 — the source type and source id cannot be repointed", async () => {
  const { row } = await activeAllocation();
  const otherSource = (await shortfallOf40()).sourceId;
  const disposition = (await pool.query("SELECT id FROM material_demand_line_dispositions LIMIT 1")).rows[0];

  assert.match(
    await attempt(
      `UPDATE carry_forward_allocations SET ${RELEASE}, source_ipo_line_id = $2 WHERE id = $1`,
      [row.id, otherSource],
    ),
    /source, target and quantity are immutable/,
  );

  if (disposition) {
    assert.match(
      await attempt(
        `UPDATE carry_forward_allocations
         SET ${RELEASE}, source_type = 'OUT_OF_BUDGET', source_ipo_line_id = NULL, source_disposition_id = $2
         WHERE id = $1`,
        [row.id, disposition.id],
      ),
      /source, target and quantity are immutable/,
    );
  }

  const after = await rowById(row.id);
  assert.equal(after.source_type, "UNPURCHASED_IPO_QUANTITY");
  assert.equal(after.source_ipo_line_id, row.source_ipo_line_id);
});

test("4+5 — the target Demand and target line cannot be repointed", async () => {
  const { row } = await activeAllocation();
  const other = await activeAllocation();

  assert.match(
    await attempt(
      `UPDATE carry_forward_allocations
       SET ${RELEASE}, target_demand_id = $2, target_demand_line_id = $3 WHERE id = $1`,
      [row.id, other.row.target_demand_id, other.row.target_demand_line_id],
    ),
    /source, target and quantity are immutable|carry_forward_allocations_target_line_key/,
  );
  assert.match(
    await attempt(`UPDATE carry_forward_allocations SET ${RELEASE}, target_demand_id = $2 WHERE id = $1`, [
      row.id,
      other.row.target_demand_id,
    ]),
    /source, target and quantity are immutable|target_line_fkey/,
  );

  const after = await rowById(row.id);
  assert.equal(after.target_demand_id, row.target_demand_id);
  assert.equal(after.target_demand_line_id, row.target_demand_line_id);
});

test("6 — a historical allocation cannot be moved between departments or sites", async () => {
  const { row } = await activeAllocation();
  const otherDept = (
    await pool.query("SELECT id FROM departments WHERE id <> $1 LIMIT 1", [row.department_id])
  ).rows[0];
  const otherSite = (await pool.query("SELECT id FROM sites WHERE id <> $1 LIMIT 1", [row.site_id])).rows[0];

  assert.match(
    await attempt(`UPDATE carry_forward_allocations SET ${RELEASE}, department_id = $2 WHERE id = $1`, [
      row.id,
      otherDept.id,
    ]),
    /source, target and quantity are immutable/,
  );
  if (otherSite) {
    assert.match(
      await attempt(`UPDATE carry_forward_allocations SET ${RELEASE}, site_id = $2 WHERE id = $1`, [
        row.id,
        otherSite.id,
      ]),
      /source, target and quantity are immutable/,
    );
  }

  const after = await rowById(row.id);
  assert.equal(after.department_id, row.department_id);
  assert.equal(after.site_id, row.site_id);
});

test("7 — the creator and creation time cannot be rewritten", async () => {
  const { row } = await activeAllocation();
  const otherUser = (
    await pool.query("SELECT id FROM users WHERE id <> $1 LIMIT 1", [row.created_by_user_id])
  ).rows[0];

  assert.match(
    await attempt(`UPDATE carry_forward_allocations SET ${RELEASE}, created_by_user_id = $2 WHERE id = $1`, [
      row.id,
      otherUser.id,
    ]),
    /source, target and quantity are immutable/,
  );
  assert.match(
    await attempt(
      `UPDATE carry_forward_allocations SET ${RELEASE}, created_at = now() - interval '5 years' WHERE id = $1`,
      [row.id],
    ),
    /source, target and quantity are immutable/,
  );
  assert.match(
    await attempt(`UPDATE carry_forward_allocations SET ${RELEASE}, id = gen_random_uuid() WHERE id = $1`, [
      row.id,
    ]),
    /source, target and quantity are immutable/,
  );

  const after = await rowById(row.id);
  assert.equal(after.created_by_user_id, row.created_by_user_id);
  assert.deepEqual(after.created_at, row.created_at);
});

test("8 — an allocation cannot be deleted, released or not", async () => {
  const { row, demandId } = await activeAllocation();

  assert.match(
    await attempt("DELETE FROM carry_forward_allocations WHERE id = $1", [row.id]),
    /historical records and cannot be deleted/,
  );

  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/reviews`, {
      token: ctx.tokens.siteManager,
      body: { decision: "REJECTED", reason: "Not needed" },
    })).status,
    200,
  );
  assert.equal((await rowById(row.id)).status, "RELEASED");

  assert.match(
    await attempt("DELETE FROM carry_forward_allocations WHERE id = $1", [row.id]),
    /historical records and cannot be deleted/,
  );
  assert.ok(await rowById(row.id));
});

test("9+12 — a legitimate release succeeds and restores availability without losing history", async () => {
  const { row, demandId, catalogEntryId, sourceId } = await activeAllocation("40");

  assert.equal(
    (await outstandingFor(catalogEntryId)).body.data.find((r) => r.source_id === sourceId),
    undefined,
    "nothing should remain while the claim is active",
  );

  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/reviews`, {
      token: ctx.tokens.siteManager,
      body: { decision: "REJECTED", reason: "Not needed" },
    })).status,
    200,
  );

  const after = await rowById(row.id);
  assert.equal(after.id, row.id, "release created a new row instead of moving this one");
  assert.equal(after.status, "RELEASED");
  assert.ok(after.released_at);
  // Only the release lifecycle moved.
  for (const column of [
    "source_type",
    "source_ipo_line_id",
    "source_quantity",
    "allocated_quantity",
    "target_demand_id",
    "target_demand_line_id",
    "department_id",
    "site_id",
    "created_by_user_id",
  ]) {
    assert.deepEqual(after[column], row[column], `${column} changed during release`);
  }
  assert.deepEqual(after.created_at, row.created_at);

  const available = (await outstandingFor(catalogEntryId)).body.data.find((r) => r.source_id === sourceId);
  assert.ok(available, "the released quantity is claimable again");
  assert.equal(available.available_quantity, "40.00");
});

test("10+11 — release is one-way and its timestamp cannot be moved", async () => {
  const { row, demandId } = await activeAllocation();
  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${demandId}/reviews`, {
      token: ctx.tokens.siteManager,
      body: { decision: "REJECTED", reason: "Not needed" },
    })).status,
    200,
  );
  const released = await rowById(row.id);

  for (const sql of [
    "UPDATE carry_forward_allocations SET status = 'ACTIVE', released_at = NULL WHERE id = $1",
    "UPDATE carry_forward_allocations SET released_at = now() - interval '1 year' WHERE id = $1",
    "UPDATE carry_forward_allocations SET released_at = NULL WHERE id = $1",
    "UPDATE carry_forward_allocations SET allocated_quantity = 1 WHERE id = $1",
  ]) {
    assert.match(await attempt(sql, [row.id]), /a released carry-forward allocation is immutable/);
  }

  const after = await rowById(row.id);
  assert.equal(after.status, "RELEASED");
  assert.deepEqual(after.released_at, released.released_at);
  assert.equal(after.allocated_quantity, released.allocated_quantity);
});

test("13 — a released quantity can be legitimately claimed again, without resurrecting the old row", async () => {
  const { catalogEntryId, sourceId } = await shortfallOf40();
  const firstDemand = await carryForward(catalogEntryId, sourceId, "25");
  const first = (
    await pool.query("SELECT id FROM carry_forward_allocations WHERE target_demand_id = $1", [firstDemand])
  ).rows[0];

  assert.equal(
    (await apiRequest(ctx.baseUrl, "POST", `/api/v1/demands/${firstDemand}/reviews`, {
      token: ctx.tokens.siteManager,
      body: { decision: "REJECTED", reason: "Not needed" },
    })).status,
    200,
  );

  await carryForward(catalogEntryId, sourceId, "25");

  const history = await pool.query(
    `SELECT status, allocated_quantity FROM carry_forward_allocations
     WHERE source_ipo_line_id = $1 ORDER BY created_at`,
    [sourceId],
  );
  assert.deepEqual(
    history.rows.map((r) => r.status),
    ["RELEASED", "ACTIVE"],
    "history should show both the released claim and the new one",
  );
  assert.equal((await rowById(first.id)).status, "RELEASED", "the old claim was resurrected");
});

test("14 — concurrent claims still cannot over-allocate a source", async () => {
  const { catalogEntryId, sourceId } = await shortfallOf40();

  const results = await Promise.allSettled([
    carryForward(catalogEntryId, sourceId, "30"),
    carryForward(catalogEntryId, sourceId, "30"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "both 30s were allowed against 40");

  const active = await pool.query(
    `SELECT COALESCE(SUM(allocated_quantity), 0)::numeric(12,2) AS total
     FROM carry_forward_allocations WHERE source_ipo_line_id = $1 AND status = 'ACTIVE'`,
    [sourceId],
  );
  assert.ok(Number(active.rows[0].total) <= 40, `active claims exceeded the source: ${active.rows[0].total}`);
});

test("15 — the freeze is generic: it protects every source type, including ones not yet used", async () => {
  // Sampling whichever types the ledger happens to hold would depend on test
  // order, so genericity is proved structurally instead: the guard is a
  // table-level trigger whose body never looks at source_type, so it cannot
  // treat one source differently — or miss a source type this ledger has not
  // seen yet.
  const definition = await pool.query(
    "SELECT pg_get_functiondef(oid) AS body FROM pg_proc WHERE proname = 'carry_forward_allocations_forbid_history_change'",
  );
  assert.equal(definition.rowCount, 1, "the history guard function is missing");
  assert.ok(
    !definition.rows[0].body.includes("source_type"),
    "the guard branches on source_type, so it is not generic",
  );

  const trigger = await pool.query(
    `SELECT tgtype FROM pg_trigger
     WHERE tgrelid = 'carry_forward_allocations'::regclass
       AND tgname = 'carry_forward_allocations_forbid_history_change'`,
  );
  assert.equal(trigger.rowCount, 1, "the history trigger is not attached to the table");

  // And it does hold for each type actually present.
  const perType = await pool.query(
    `SELECT DISTINCT ON (source_type) id, source_type
     FROM carry_forward_allocations ORDER BY source_type, created_at`,
  );
  assert.ok(perType.rowCount > 0);
  for (const row of perType.rows) {
    const message = await attempt(
      "UPDATE carry_forward_allocations SET allocated_quantity = allocated_quantity + 1 WHERE id = $1",
      [row.id],
    );
    assert.ok(message, `${row.source_type} allowed a quantity rewrite`);
    assert.match(message, /immutable|may only be released/);
    assert.match(
      await attempt("DELETE FROM carry_forward_allocations WHERE id = $1", [row.id]),
      /cannot be deleted/,
      `${row.source_type} allowed a delete`,
    );
  }
});
