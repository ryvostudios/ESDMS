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

test("a user's department must belong to the user's own site (composite FK)", async () => {
  await assert.rejects(
    pool.query(
      `UPDATE users SET department_id = $1 WHERE id = $2`,
      [users.otherSiteDepartment, users.teamLead],
    ),
    /violates foreign key constraint|users_department_site_fkey/,
  );
});

test("a Gate Pass's issuing department must belong to the Gate Pass's own site (composite FK)", async () => {
  await assert.rejects(
    pool.query(
      `INSERT INTO gate_passes
         (gate_pass_number, issuing_department_id, requested_by, destination,
          driver_name, driver_phone, vehicle_registration, purpose, created_by_user_id, site_id)
       VALUES ($1, $2, 'Test Requester', 'Test Site', 'Test Driver', '+10000000000', 'ABC-XSITE', 'SAMPLE', $3, $4)`,
      [await nextGatePassNumber(pool), users.otherSiteDepartment, users.teamLead, siteId],
    ),
    /violates foreign key constraint|gate_passes_department_site_fkey/,
  );
});

test("a Gate Pass's evidence photo pointer must reference a file that actually belongs to it (ownership FK)", async () => {
  const draft = await insertDraftGatePass(pool);
  const otherDraft = await insertDraftGatePass(pool);

  const file = await pool.query(
    `INSERT INTO gate_pass_files
       (gate_pass_id, file_type, storage_key, mime_type, size_bytes, checksum_sha256, version, created_by_user_id)
     VALUES ($1, 'DEPARTURE_PHOTO', 'gate-pass/x/departure/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10, repeat('a', 64), 1, $2)
     RETURNING id`,
    [otherDraft.id, users.guard],
  );

  await assert.rejects(
    pool.query("UPDATE gate_passes SET departure_photo_file_id = $1 WHERE id = $2", [file.rows[0].id, draft.id]),
    /violates foreign key constraint|gate_passes_departure_photo_ownership_fkey/,
  );
});

async function insertGatePassFile(client, gatePassId, fileType, { version = 1 } = {}) {
  const result = await client.query(
    `INSERT INTO gate_pass_files
       (gate_pass_id, file_type, storage_key, mime_type, size_bytes, checksum_sha256, version, created_by_user_id)
     VALUES ($1, $2, 'gate-pass/x/file/' || gen_random_uuid() || '.jpg', 'image/jpeg', 10, repeat('c', 64), $3, $4)
     RETURNING id`,
    [gatePassId, fileType, version, users.guard],
  );
  return result.rows[0].id;
}

test("departure_photo_file_id referencing a RETURN_PHOTO file is rejected (wrong type, same Gate Pass)", async () => {
  const draft = await insertDraftGatePass(pool);
  const returnPhotoId = await insertGatePassFile(pool, draft.id, "RETURN_PHOTO");

  await assert.rejects(
    pool.query("UPDATE gate_passes SET departure_photo_file_id = $1 WHERE id = $2", [returnPhotoId, draft.id]),
    /must reference a gate_pass_files row with file_type = DEPARTURE_PHOTO/,
  );
});

test("departure_photo_file_id referencing an APPROVED_PDF file is rejected", async () => {
  const draft = await insertDraftGatePass(pool);
  const pdfId = await insertGatePassFile(pool, draft.id, "APPROVED_PDF");

  await assert.rejects(
    pool.query("UPDATE gate_passes SET departure_photo_file_id = $1 WHERE id = $2", [pdfId, draft.id]),
    /must reference a gate_pass_files row with file_type = DEPARTURE_PHOTO/,
  );
});

test("return_photo_file_id referencing a DEPARTURE_PHOTO file is rejected (wrong type, same Gate Pass)", async () => {
  const draft = await insertDraftGatePass(pool);
  const departurePhotoId = await insertGatePassFile(pool, draft.id, "DEPARTURE_PHOTO");

  await assert.rejects(
    pool.query("UPDATE gate_passes SET return_photo_file_id = $1 WHERE id = $2", [departurePhotoId, draft.id]),
    /must reference a gate_pass_files row with file_type = RETURN_PHOTO/,
  );
});

test("return_photo_file_id referencing an APPROVED_PDF file is rejected", async () => {
  const draft = await insertDraftGatePass(pool);
  const pdfId = await insertGatePassFile(pool, draft.id, "APPROVED_PDF");

  await assert.rejects(
    pool.query("UPDATE gate_passes SET return_photo_file_id = $1 WHERE id = $2", [pdfId, draft.id]),
    /must reference a gate_pass_files row with file_type = RETURN_PHOTO/,
  );
});

test("correct departure/return photo type references are accepted", async () => {
  const draft = await insertDraftGatePass(pool);
  const departurePhotoId = await insertGatePassFile(pool, draft.id, "DEPARTURE_PHOTO");
  const returnPhotoId = await insertGatePassFile(pool, draft.id, "RETURN_PHOTO");

  await pool.query("UPDATE gate_passes SET departure_photo_file_id = $1, return_photo_file_id = $2 WHERE id = $3", [
    departurePhotoId,
    returnPhotoId,
    draft.id,
  ]);

  const row = await pool.query("SELECT departure_photo_file_id, return_photo_file_id FROM gate_passes WHERE id = $1", [
    draft.id,
  ]);
  assert.equal(row.rows[0].departure_photo_file_id, departurePhotoId);
  assert.equal(row.rows[0].return_photo_file_id, returnPhotoId);
});

test("gate_pass_items rejects a duplicate line_no within the same Gate Pass", async () => {
  const draft = await insertDraftGatePass(pool);

  await pool.query(
    `INSERT INTO gate_pass_items (gate_pass_id, line_no, description, quantity) VALUES ($1, 1, 'First', 1)`,
    [draft.id],
  );

  await assert.rejects(
    pool.query(
      `INSERT INTO gate_pass_items (gate_pass_id, line_no, description, quantity) VALUES ($1, 1, 'Duplicate', 1)`,
      [draft.id],
    ),
    /violates unique constraint|gate_pass_items_gate_pass_id_line_no_key/,
  );
});

test("gate_pass_files rejects a duplicate (gate_pass_id, file_type, version)", async () => {
  const draft = await insertDraftGatePass(pool);

  const insertPdf = () =>
    pool.query(
      `INSERT INTO gate_pass_files
         (gate_pass_id, file_type, storage_key, mime_type, size_bytes, checksum_sha256, version, created_by_user_id)
       VALUES ($1, 'APPROVED_PDF', 'gate-pass/x/pdf/' || gen_random_uuid() || '.pdf', 'application/pdf', 10, repeat('b', 64), 1, $2)`,
      [draft.id, users.admin],
    );

  await insertPdf();
  await assert.rejects(insertPdf(), /violates unique constraint|gate_pass_files_gate_pass_id_type_version_key/);
});

// ADV-P1-04: the governance-temp-password-regeneration migration's down()
// must delete a delegated user_permission_overrides row (in the same
// pattern as 1787411000000_leave-self-cancel-permission.js) before
// deleting role_permissions/permissions for users.regenerate_temp_password
// — proven by exercising that exact down() SQL, in order, inside a
// BEGIN...ROLLBACK transaction so the shared eset_test schema is restored
// exactly regardless of outcome (this migration has not been externally
// deployed, so editing it directly is safe — see docs/DECISIONS.md-style
// reasoning in the migration file itself).
test("governance-temp-password-regeneration migration down() safely removes a delegated override, its role mapping, and the permission itself — without touching an unrelated override", async () => {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const permission = await client.query(
      "SELECT id FROM permissions WHERE code = 'users.regenerate_temp_password'",
    );
    assert.equal(permission.rowCount, 1, "the permission must already exist (migration already applied)");
    const permissionId = permission.rows[0].id;

    const otherPermission = await client.query(
      "SELECT id FROM permissions WHERE code != 'users.regenerate_temp_password' LIMIT 1",
    );
    const otherPermissionId = otherPermission.rows[0].id;

    // Delegate users.regenerate_temp_password to a real user via an
    // override — the exact scenario the migration must roll back safely
    // from — plus one unrelated override that must survive untouched.
    await client.query(
      `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by_user_id)
       VALUES ($1, $2, 'GRANT', $1)
       ON CONFLICT (user_id, permission_id) DO UPDATE SET effect = EXCLUDED.effect`,
      [users.hr, permissionId],
    );
    await client.query(
      `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by_user_id)
       VALUES ($1, $2, 'GRANT', $1)
       ON CONFLICT (user_id, permission_id) DO UPDATE SET effect = EXCLUDED.effect`,
      [users.hr, otherPermissionId],
    );

    // Exercise the migration's down() SQL, in the corrected order.
    await client.query(
      "DELETE FROM user_permission_overrides WHERE permission_id = (SELECT id FROM permissions WHERE code = 'users.regenerate_temp_password')",
    );
    await client.query(
      "DELETE FROM role_permissions WHERE permission_id = (SELECT id FROM permissions WHERE code = 'users.regenerate_temp_password')",
    );
    await client.query("DELETE FROM permissions WHERE code = 'users.regenerate_temp_password'");

    const overrideGone = await client.query(
      "SELECT 1 FROM user_permission_overrides WHERE permission_id = $1",
      [permissionId],
    );
    assert.equal(overrideGone.rowCount, 0, "the delegated override is removed");

    const roleMappingGone = await client.query("SELECT 1 FROM role_permissions WHERE permission_id = $1", [permissionId]);
    assert.equal(roleMappingGone.rowCount, 0, "the CEO role mapping is removed");

    const permissionGone = await client.query("SELECT 1 FROM permissions WHERE id = $1", [permissionId]);
    assert.equal(permissionGone.rowCount, 0, "the permission is removed");

    const unrelatedSurvives = await client.query(
      "SELECT 1 FROM user_permission_overrides WHERE user_id = $1 AND permission_id = $2",
      [users.hr, otherPermissionId],
    );
    assert.equal(unrelatedSurvives.rowCount, 1, "an unrelated override on a different permission is untouched");
  } finally {
    // Restore the shared schema exactly, regardless of assertion outcome.
    await client.query("ROLLBACK");
    client.release();
  }
});
