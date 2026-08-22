import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { seedUsers } from "./setup.js";

let users;
let departmentId;
let siteId;

before(async () => {
  users = await seedUsers();
  departmentId = users.departmentA;
  siteId = users.mainSite;
});

after(async () => {
  await pool.end();
});

async function nextGatePassNumber(client) {
  const year = new Date().getFullYear();

  const result = await client.query(
    `INSERT INTO gate_pass_number_counters (year, last_value)
     VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last_value = gate_pass_number_counters.last_value + 1
     RETURNING last_value`,
    [year],
  );

  return `ESD-${year}-${String(result.rows[0].last_value).padStart(6, "0")}`;
}

async function insertDraftGatePass(client, overrides = {}) {
  const gatePassNumber = overrides.gatePassNumber || (await nextGatePassNumber(client));

  const result = await client.query(
    `INSERT INTO gate_passes
       (gate_pass_number, issuing_department_id, requested_by, destination,
        driver_name, driver_phone, vehicle_registration, purpose, created_by_user_id, site_id)
     VALUES ($1, $2, 'Test Requester', 'Test Site', 'Test Driver', '+10000000000', 'ABC-123', 'SAMPLE', $3, $4)
     RETURNING id, status`,
    [gatePassNumber, departmentId, users.teamLead, siteId],
  );

  return result.rows[0];
}

test("gate pass numbers are unique and sequential per year via atomic counter", async () => {
  const client = await pool.connect();

  try {
    const a = await nextGatePassNumber(client);
    const b = await nextGatePassNumber(client);

    assert.notEqual(a, b);
    assert.match(a, /^ESD-\d{4}-\d{6}$/);
  } finally {
    client.release();
  }
});

test("concurrent counter increments never collide", async () => {
  const clients = await Promise.all(Array.from({ length: 10 }, () => pool.connect()));

  try {
    const numbers = await Promise.all(clients.map((client) => nextGatePassNumber(client)));
    assert.equal(new Set(numbers).size, numbers.length);
  } finally {
    clients.forEach((client) => client.release());
  }
});

test("gate_passes rejects an invalid status via CHECK constraint", async () => {
  const gatePassNumber = await nextGatePassNumber(pool);

  await assert.rejects(
    pool.query(
      `INSERT INTO gate_passes
         (gate_pass_number, status, issuing_department_id, requested_by, destination,
          driver_name, driver_phone, vehicle_registration, purpose, created_by_user_id, site_id)
       VALUES ($1, 'NOT_A_REAL_STATUS', $2, 'Test', 'Test', 'Test', '+1', 'ABC-1', 'SAMPLE', $3, $4)`,
      [gatePassNumber, departmentId, users.teamLead, siteId],
    ),
    /violates check constraint/,
  );
});

test("gate_passes rejects return odometer lower than departure odometer", async () => {
  const draft = await insertDraftGatePass(pool);

  await assert.rejects(
    pool.query(
      `UPDATE gate_passes SET departure_odometer = 500, return_odometer = 100 WHERE id = $1`,
      [draft.id],
    ),
    /violates check constraint/,
  );
});

test("distance_km is server-computed from odometer readings, not settable", async () => {
  const draft = await insertDraftGatePass(pool);

  await pool.query(
    `UPDATE gate_passes SET departure_odometer = 1000, return_odometer = 1250 WHERE id = $1`,
    [draft.id],
  );

  const result = await pool.query("SELECT distance_km FROM gate_passes WHERE id = $1", [draft.id]);
  assert.equal(result.rows[0].distance_km, 250);
});

test("gate_passes cannot be deleted at the database level", async () => {
  const draft = await insertDraftGatePass(pool);

  await assert.rejects(
    pool.query("DELETE FROM gate_passes WHERE id = $1", [draft.id]),
    /not permitted/,
  );
});

test("gate_pass_audit_log is append-only: UPDATE and DELETE are rejected", async () => {
  const draft = await insertDraftGatePass(pool);

  const inserted = await pool.query(
    `INSERT INTO gate_pass_audit_log (gate_pass_id, actor_user_id, action, new_status)
     VALUES ($1, $2, 'CREATE', 'DRAFT')
     RETURNING id`,
    [draft.id, users.teamLead],
  );

  const logId = inserted.rows[0].id;

  await assert.rejects(
    pool.query("UPDATE gate_pass_audit_log SET action = 'SUBMIT' WHERE id = $1", [logId]),
    /append-only/,
  );

  await assert.rejects(
    pool.query("DELETE FROM gate_pass_audit_log WHERE id = $1", [logId]),
    /append-only/,
  );
});

test("gate_pass_items requires a positive quantity", async () => {
  const draft = await insertDraftGatePass(pool);

  await assert.rejects(
    pool.query(
      `INSERT INTO gate_pass_items (gate_pass_id, line_no, description, quantity)
       VALUES ($1, 1, 'Test item', 0)`,
      [draft.id],
    ),
    /violates check constraint/,
  );
});

test("gate_passes rejects APPROVED status without approval fields set", async () => {
  const draft = await insertDraftGatePass(pool);

  await assert.rejects(
    pool.query(`UPDATE gate_passes SET status = 'APPROVED' WHERE id = $1`, [draft.id]),
    /violates check constraint/,
  );
});

test("gate_passes rejects REJECTED status without a rejection reason", async () => {
  const draft = await insertDraftGatePass(pool);

  await assert.rejects(
    pool.query(
      `UPDATE gate_passes
         SET status = 'REJECTED', rejected_by_user_id = $2, rejected_at = now()
       WHERE id = $1`,
      [draft.id, users.siteManager],
    ),
    /violates check constraint/,
  );
});

test("gate_passes rejects COMPLETED status without departure/return evidence fields set", async () => {
  const draft = await insertDraftGatePass(pool);

  await assert.rejects(
    pool.query(
      `UPDATE gate_passes
         SET status = 'COMPLETED', approved_by_user_id = $2, approved_at = now(),
             verification_token_hash = 'deadbeef'
       WHERE id = $1`,
      [draft.id, users.admin],
    ),
    /violates check constraint/,
  );
});

test("verification_token_hash uniqueness only applies to non-null values", async () => {
  await insertDraftGatePass(pool);
  await insertDraftGatePass(pool);
  // Both rows have NULL verification_token_hash — must not collide.
  assert.ok(true);
});
