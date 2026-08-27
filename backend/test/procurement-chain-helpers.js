import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import pool from "../src/config/database.js";
import { apiRequest } from "./gate-pass-helpers.js";

export function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

export async function permissionId(code) {
  const result = await pool.query("SELECT id FROM permissions WHERE code = $1", [code]);
  if (!result.rows[0]) throw new Error(`Unknown permission code in test fixture: ${code}`);
  return result.rows[0].id;
}

export async function setOverride(userId, code, effect, grantedBy) {
  await pool.query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by_user_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, permission_id) DO UPDATE SET effect = EXCLUDED.effect`,
    [userId, await permissionId(code), effect, grantedBy],
  );
}

export async function clearOverride(userId, code) {
  await pool.query("DELETE FROM user_permission_overrides WHERE user_id = $1 AND permission_id = $2", [
    userId,
    await permissionId(code),
  ]);
}

// Drives the already-implemented Checkpoint 1-5 workflow end to end so the
// new checkpoints have a realistic, fully-approved starting point: catalog
// entry -> Demand -> initial gate -> pricing -> final gate -> automatic IPO.
export async function buildApprovedIpo(
  ctx,
  { quantities = [100, 20], prices = ["50.00", "10.00"], creatorToken, uomId } = {},
) {
  const { baseUrl, tokens } = ctx;
  const token = creatorToken || tokens.teamLead;

  const entries = [];
  for (let index = 0; index < quantities.length; index += 1) {
    const response = await apiRequest(baseUrl, "POST", "/api/v1/material-catalog", {
      token,
      body: { newItem: { name: unique("Chain material") }, defaultUomId: uomId },
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
    entries.push(response.body.data.id);
  }

  const created = await apiRequest(baseUrl, "POST", "/api/v1/demands", {
    token,
    body: { lines: entries.map((catalogEntryId, index) => ({ catalogEntryId, quantity: quantities[index] })) },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const demandId = created.body.data.demand.id;

  assert.equal((await apiRequest(baseUrl, "POST", `/api/v1/demands/${demandId}/submit`, { token })).status, 200);
  assert.equal(
    (await apiRequest(baseUrl, "POST", `/api/v1/demands/${demandId}/reviews`, {
      token: tokens.siteManager,
      body: { decision: "APPROVED" },
    })).status,
    200,
  );
  assert.equal(
    (await apiRequest(baseUrl, "POST", `/api/v1/demands/${demandId}/approvals`, {
      token: tokens.ceo,
      body: { decision: "APPROVED" },
    })).status,
    200,
  );

  const pricingDetail = await apiRequest(baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, {
    token: tokens.ceo,
  });
  assert.equal(pricingDetail.status, 200);
  assert.equal(
    (await apiRequest(baseUrl, "PUT", `/api/v1/procurement/pricing/${demandId}`, {
      token: tokens.ceo,
      body: {
        revision: 1,
        pricingVersion: 1,
        currency: "PKR",
        lines: pricingDetail.body.data.lines.map((line, index) => ({
          demandLineId: line.demand_line_id,
          estimatedUnitPrice: prices[index],
        })),
      },
    })).status,
    200,
  );
  assert.equal(
    (await apiRequest(baseUrl, "POST", `/api/v1/procurement/pricing/${demandId}/submit`, {
      token: tokens.ceo,
      body: { revision: 1, pricingVersion: 1 },
    })).status,
    200,
  );

  const pricingId = pricingDetail.body.data.pricing?.id
    || (await apiRequest(baseUrl, "GET", `/api/v1/procurement/pricing/${demandId}`, { token: tokens.ceo }))
      .body.data.pricing.id;

  assert.equal(
    (await apiRequest(baseUrl, "POST", `/api/v1/demands/${demandId}/final-reviews`, {
      token: tokens.siteManager,
      body: { pricingId, decision: "APPROVED" },
    })).status,
    200,
  );
  const finalApproval = await apiRequest(baseUrl, "POST", `/api/v1/demands/${demandId}/final-approvals`, {
    token: tokens.ceo,
    body: { pricingId, decision: "APPROVED" },
  });
  assert.equal(finalApproval.status, 200, JSON.stringify(finalApproval.body));
  assert.equal(finalApproval.body.data.demand.status, "IPO_GENERATED");

  const ipo = await pool.query(
    "SELECT id, ipo_number, status FROM ipos WHERE demand_id = $1 AND demand_revision = 1",
    [demandId],
  );
  assert.equal(ipo.rowCount, 1);

  const lines = await pool.query("SELECT id, line_no, approved_quantity FROM ipo_lines WHERE ipo_id = $1 ORDER BY line_no", [
    ipo.rows[0].id,
  ]);

  return { demandId, pricingId, ipoId: ipo.rows[0].id, ipoNumber: ipo.rows[0].ipo_number, ipoLines: lines.rows };
}

// Every write in this chain is idempotency-keyed. Helpers mint a fresh
// operation id by default so each call is a genuinely new operation; a test
// exercising replay passes the same one twice explicitly.
export async function recordPurchase(ctx, ipoId, lines, token, operationId) {
  return apiRequest(ctx.baseUrl, "POST", `/api/v1/ipos/${ipoId}/purchases`, {
    token: token || ctx.tokens.ceo,
    body: { operationId: operationId || randomUUID(), lines },
  });
}

export async function createFinalizedDc(ctx, ipoId, lines, token, operationId) {
  const created = await apiRequest(ctx.baseUrl, "POST", "/api/v1/delivery-challans", {
    token: token || ctx.tokens.ceo,
    body: { operationId: operationId || randomUUID(), ipoId, lines },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const dcId = created.body.data.deliveryChallan.id;

  const finalized = await apiRequest(ctx.baseUrl, "POST", `/api/v1/delivery-challans/${dcId}/finalize`, {
    token: token || ctx.tokens.ceo,
  });
  assert.equal(finalized.status, 200, JSON.stringify(finalized.body));
  return { dcId, lines: finalized.body.data.lines };
}

// Records a receipt with a fresh operation id unless one is supplied.
export async function recordReceipt(ctx, dcId, body, token, operationId) {
  return apiRequest(ctx.baseUrl, "POST", `/api/v1/receiving/challans/${dcId}/receipts`, {
    token,
    body: { operationId: operationId || randomUUID(), ...body },
  });
}
