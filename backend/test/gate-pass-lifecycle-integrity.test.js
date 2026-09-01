import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { apiRequest, authHeader, buildCreatePayload, buildPhotoForm } from "./gate-pass-helpers.js";
import { GATE_PASS_STATUS } from "../src/modules/gate-pass/gate-pass.constants.js";

// Gate Pass lifecycle validity used to live only in application code:
//
//   UPDATE gate_passes SET status = 'DRAFT' WHERE status = 'COMPLETED';  -- succeeded
//
// These tests hold the database-level guarantee, and — just as importantly —
// prove the guard did not narrow any transition the product actually uses.

const ALL_STATUSES = Object.values(GATE_PASS_STATUS);

const ALLOWED = [
  ["DRAFT", "PENDING_APPROVAL"],
  ["DRAFT", "APPROVED"],
  ["DRAFT", "REJECTED"],
  ["DRAFT", "CANCELLED"],
  ["PENDING_APPROVAL", "APPROVED"],
  ["PENDING_APPROVAL", "REJECTED"],
  ["PENDING_APPROVAL", "CANCELLED"],
  ["APPROVED", "VEHICLE_OUTSIDE"],
  ["APPROVED", "CANCELLED"],
  ["VEHICLE_OUTSIDE", "COMPLETED"],
];

let server;
let users;

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
});

after(async () => {
  await server.close();
  await pool.end();
});

async function nextGatePassNumber() {
  const year = new Date().getFullYear();
  const result = await pool.query(
    `INSERT INTO gate_pass_number_counters (year, last_value)
     VALUES ($1, 1)
     ON CONFLICT (year) DO UPDATE SET last_value = gate_pass_number_counters.last_value + 1
     RETURNING last_value`,
    [year],
  );
  return `ESD-${year}-${String(result.rows[0].last_value).padStart(6, "0")}`;
}

// Inserts straight through the repository layer, so a test can put a row in
// any state without driving the whole workflow for each case.
async function insertDraftGatePass() {
  const result = await pool.query(
    `INSERT INTO gate_passes
       (gate_pass_number, issuing_department_id, requested_by, destination,
        driver_name, driver_phone, vehicle_registration, purpose, created_by_user_id, site_id)
     VALUES ($1, $2, 'Lifecycle Requester', 'Test Site', 'Test Driver', '+10000000000', 'ABC-123', 'SAMPLE', $3, $4)
     RETURNING id`,
    [await nextGatePassNumber(), users.departmentA, users.teamLead, users.mainSite],
  );
  return result.rows[0].id;
}

// Fields the status-coherence CHECK requires for each state, so a test can
// place a row in any state directly and exercise the lifecycle trigger in
// isolation from the rest of the workflow.
function coherenceColumns(status, actorId, gatePassId) {
  const approved = {
    approved_by_user_id: actorId,
    approved_at: "CURRENT_TIMESTAMP",
    // Unique per pass: verification_token_hash carries a UNIQUE constraint.
    verification_token_hash: `'${crypto.createHash("sha256").update(gatePassId).digest("hex")}'`,
  };
  const departed = {
    departure_odometer: "100",
    departure_at: "CURRENT_TIMESTAMP",
    departure_by_user_id: actorId,
  };

  switch (status) {
    case "APPROVED":
      return approved;
    case "VEHICLE_OUTSIDE":
      return { ...approved, ...departed };
    case "COMPLETED":
      return {
        ...approved,
        ...departed,
        return_odometer: "200",
        return_at: "CURRENT_TIMESTAMP",
        return_by_user_id: actorId,
      };
    case "REJECTED":
      return {
        rejected_by_user_id: actorId,
        rejected_at: "CURRENT_TIMESTAMP",
        rejection_reason: "'test'",
      };
    case "CANCELLED":
      return {
        cancelled_by_user_id: actorId,
        cancelled_at: "CURRENT_TIMESTAMP",
        cancellation_reason: "'test'",
      };
    default:
      return {};
  }
}

// VEHICLE_OUTSIDE and COMPLETED additionally require a departure/return photo
// file id, which must reference a real gate_pass_files row.
async function attachEvidence(gatePassId, fileType) {
  const result = await pool.query(
    `INSERT INTO gate_pass_files (gate_pass_id, file_type, storage_key, mime_type, size_bytes, checksum_sha256, created_by_user_id)
     VALUES ($1, $2, $3, 'image/png', 10, $4, $5) RETURNING id`,
    // storage_key and checksum are both UNIQUE; a pass can legitimately hold
    // several evidence files, so each needs its own value.
    [
      gatePassId,
      fileType,
      `test/${gatePassId}/${fileType}-${crypto.randomUUID()}.png`,
      crypto.randomBytes(32).toString("hex"),
      users.admin,
    ],
  );
  return result.rows[0].id;
}

// Places an existing draft directly into `status`, bypassing the API, using
// one UPDATE the trigger must accept (it is a legal transition or a chain of
// legal transitions from DRAFT).
async function placeInStatus(gatePassId, status) {
  const path = {
    DRAFT: [],
    PENDING_APPROVAL: ["PENDING_APPROVAL"],
    APPROVED: ["APPROVED"],
    REJECTED: ["REJECTED"],
    CANCELLED: ["CANCELLED"],
    VEHICLE_OUTSIDE: ["APPROVED", "VEHICLE_OUTSIDE"],
    COMPLETED: ["APPROVED", "VEHICLE_OUTSIDE", "COMPLETED"],
  }[status];

  // gate_pass_files is unique on (gate_pass_id, file_type, version), so each
  // evidence row is created once and carried forward through later steps.
  let departurePhotoId = null;

  for (const step of path) {
    const columns = coherenceColumns(step, `'${users.admin}'`, gatePassId);
    if (step === "VEHICLE_OUTSIDE" || step === "COMPLETED") {
      departurePhotoId ??= await attachEvidence(gatePassId, "DEPARTURE_PHOTO");
      columns.departure_photo_file_id = `'${departurePhotoId}'`;
    }
    if (step === "COMPLETED") {
      columns.return_photo_file_id = `'${await attachEvidence(gatePassId, "RETURN_PHOTO")}'`;
    }

    const assignments = Object.entries(columns)
      .map(([column, value]) => `${column} = ${value}`)
      .join(", ");
    await pool.query(
      `UPDATE gate_passes SET status = $2${assignments ? `, ${assignments}` : ""} WHERE id = $1`,
      [gatePassId, step],
    );
  }
}

test("every transition the product actually performs is accepted by the database", async () => {
  for (const [from, to] of ALLOWED) {
    const id = await insertDraftGatePass();
    await placeInStatus(id, from);

    const columns = coherenceColumns(to, `'${users.admin}'`, id);
    if (to === "VEHICLE_OUTSIDE") {
      columns.departure_photo_file_id = `'${await attachEvidence(id, "DEPARTURE_PHOTO")}'`;
    }
    if (to === "COMPLETED") {
      columns.return_photo_file_id = `'${await attachEvidence(id, "RETURN_PHOTO")}'`;
    }
    const assignments = Object.entries(columns)
      .map(([column, value]) => `${column} = ${value}`)
      .join(", ");

    await pool.query(
      `UPDATE gate_passes SET status = $2${assignments ? `, ${assignments}` : ""} WHERE id = $1`,
      [id, to],
    );

    const check = await pool.query("SELECT status FROM gate_passes WHERE id = $1", [id]);
    assert.equal(check.rows[0].status, to, `${from} -> ${to} must be allowed`);
  }
});

test("no transition outside the reconstructed matrix is accepted, including COMPLETED -> DRAFT", async () => {
  const allowedKeys = new Set(ALLOWED.map(([from, to]) => `${from}->${to}`));
  let rejected = 0;

  for (const from of ALL_STATUSES) {
    const id = await insertDraftGatePass();
    await placeInStatus(id, from);

    for (const to of ALL_STATUSES) {
      if (from === to || allowedKeys.has(`${from}->${to}`)) continue;

      await assert.rejects(
        pool.query("UPDATE gate_passes SET status = $2 WHERE id = $1", [id, to]),
        (error) => /cannot move from/i.test(error.message),
        `${from} -> ${to} must be refused by the database`,
      );
      rejected += 1;
    }
  }

  // 7 statuses x 6 other statuses = 42 ordered pairs, minus the 10 legal ones.
  assert.equal(rejected, 32, "every illegal ordered pair must have been exercised");
});

test("a COMPLETED Gate Pass cannot be rewound to DRAFT, the exact reported defect", async () => {
  const id = await insertDraftGatePass();
  await placeInStatus(id, "COMPLETED");

  await assert.rejects(
    pool.query("UPDATE gate_passes SET status = 'DRAFT' WHERE status = 'COMPLETED' AND id = $1", [id]),
    /cannot move from COMPLETED to DRAFT/i,
  );

  const check = await pool.query("SELECT status FROM gate_passes WHERE id = $1", [id]);
  assert.equal(check.rows[0].status, "COMPLETED", "the row must be untouched");
});

test("terminal states are terminal", async () => {
  for (const terminal of ["COMPLETED", "REJECTED", "CANCELLED"]) {
    const id = await insertDraftGatePass();
    await placeInStatus(id, terminal);

    for (const to of ALL_STATUSES.filter((status) => status !== terminal)) {
      await assert.rejects(
        pool.query("UPDATE gate_passes SET status = $2 WHERE id = $1", [id, to]),
        /cannot move from/i,
        `${terminal} must never move to ${to}`,
      );
    }
  }
});

test("status-preserving updates stay allowed in every state", async () => {
  // Draft field edits, the column writes that accompany a transition, the
  // updated_at trigger, and late-arriving inbound evidence against a
  // COMPLETED pass all write the row without changing status.
  for (const status of ALL_STATUSES) {
    const id = await insertDraftGatePass();
    await placeInStatus(id, status);

    await pool.query("UPDATE gate_passes SET remarks = $2 WHERE id = $1", [id, `touched in ${status}`]);

    const check = await pool.query("SELECT status, remarks FROM gate_passes WHERE id = $1", [id]);
    assert.equal(check.rows[0].status, status);
    assert.equal(check.rows[0].remarks, `touched in ${status}`);
  }
});

test("deletion remains forbidden in every state", async () => {
  for (const status of ALL_STATUSES) {
    const id = await insertDraftGatePass();
    await placeInStatus(id, status);

    await assert.rejects(
      pool.query("DELETE FROM gate_passes WHERE id = $1", [id]),
      /not permitted/i,
      `a ${status} Gate Pass must not be deletable`,
    );
  }
});

test("the full application workflow still runs end to end through the API", async () => {
  // The guard must not have narrowed anything the product does. This drives
  // the real routes: create -> submit -> approve -> exit -> return.
  const teamLead = await authHeader(server.baseUrl, "teamlead@test.eset.local");
  const manager = await authHeader(server.baseUrl, "manager@test.eset.local");
  const guard = await authHeader(server.baseUrl, "guard@test.eset.local");

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA, purpose: "RETURNABLE" }),
  });
  assert.equal(created.status, 201);
  const id = created.body.data.gatePass?.id || created.body.data.id;

  assert.equal(
    (await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/submit`, { token: teamLead })).status,
    200,
  );
  assert.equal(
    (await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/approve`, { token: manager })).status,
    200,
  );

  const exited = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/exit`, {
    token: guard,
    body: buildPhotoForm({ odometer: "1000" }),
    isForm: true,
  });
  assert.equal(exited.status, 200, JSON.stringify(exited.body));
  assert.equal(exited.body.data.status, "VEHICLE_OUTSIDE");

  const returned = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/return`, {
    token: guard,
    body: buildPhotoForm({ odometer: "1200" }),
    isForm: true,
  });
  assert.equal(returned.status, 200, JSON.stringify(returned.body));
  assert.equal(returned.body.data.status, "COMPLETED");
});

test("direct approval from DRAFT still works, and a stale client cannot replay it", async () => {
  const teamLead = await authHeader(server.baseUrl, "teamlead@test.eset.local");
  const manager = await authHeader(server.baseUrl, "manager@test.eset.local");

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA }),
  });
  const id = created.body.data.gatePass?.id || created.body.data.id;

  // DRAFT -> APPROVED without passing through PENDING_APPROVAL is a real,
  // supported transition (gate-pass.constants.js), so the trigger must allow it.
  assert.equal(
    (await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/approve`, { token: manager })).status,
    200,
  );

  // And a replayed submit against the now-APPROVED pass is refused by the
  // application with a clean conflict, never a database error.
  const replay = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/submit`, { token: teamLead });
  assert.equal(replay.status, 409);
  assert.equal(replay.body.error.code, "CONFLICT");
});

test("concurrent lifecycle actions still resolve to exactly one winner", async () => {
  const teamLead = await authHeader(server.baseUrl, "teamlead@test.eset.local");
  const manager = await authHeader(server.baseUrl, "manager@test.eset.local");

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: teamLead,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA }),
  });
  const id = created.body.data.gatePass?.id || created.body.data.id;

  const outcomes = await Promise.all(
    Array.from({ length: 6 }, () =>
      apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${id}/approve`, { token: manager }),
    ),
  );

  assert.equal(outcomes.filter((response) => response.status === 200).length, 1, "exactly one approval may win");
  assert.equal(outcomes.filter((response) => response.status === 409).length, 5);

  // The trigger must not have turned a lost race into a 500, and the audit
  // trail must record exactly one approval.
  assert.equal(outcomes.filter((response) => response.status >= 500).length, 0);
  const audit = await pool.query(
    "SELECT count(*)::int AS total FROM gate_pass_audit_log WHERE gate_pass_id = $1 AND action = 'APPROVE'",
    [id],
  );
  assert.equal(audit.rows[0].total, 1);
});
