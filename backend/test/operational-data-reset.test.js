import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";

// This suite runs against a database of its OWN, created and dropped here.
//
// It has to: the thing under test deletes almost every operational row, and
// every other test file in this run shares one disposable database. Pointing
// the reset at that shared database would wipe the fixtures of whichever
// files happen to run afterwards — the test would "pass" while breaking its
// neighbours. Running the script exactly as an operator does, against a
// database only this file owns, keeps it honest and contained.

const { Client } = pg;

const adminUrl = process.env.DATABASE_URL;
const databaseName = `esdms_test_reset_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`;
const targetUrl = (() => {
  const url = new URL(adminUrl);
  url.pathname = `/${databaseName}`;
  return url.toString();
})();

let admin;
let target;
let originalCeoBefore;

function runReset(env = {}) {
  const childEnv = {
    ...process.env,
    DATABASE_URL: targetUrl,
    ESDMS_RESET_CONFIRM: databaseName,
    ESDMS_ORIGINAL_CEO_EMAIL: "bootstrap-ceo@test.eset.local",
    ...env,
  };
  for (const [name, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[name];
  }
  return spawnSync(process.execPath, ["scripts/reset-operational-data.js"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: childEnv,
  });
}

async function count(table) {
  const result = await target.query(`SELECT count(*)::int AS total FROM ${table}`);
  return result.rows[0].total;
}

before(async () => {
  admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`CREATE DATABASE "${databaseName}"`);

  const migrated = spawnSync(
    process.execPath,
    ["node_modules/node-pg-migrate/bin/node-pg-migrate", "up"],
    { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, DATABASE_URL: targetUrl } },
  );
  assert.equal(migrated.status, 0, migrated.stderr);

  target = new Client({ connectionString: targetUrl });
  await target.connect();

  // The permanent original CEO plus operational data spanning the protected tables — a
  // Gate Pass carries a forbid-delete trigger and an append-only audit log,
  // which is exactly what a naive reset fails on.
  const site = await target.query("SELECT id FROM sites LIMIT 1");
  const department = await target.query("SELECT id FROM departments LIMIT 1");

  const ceo = await target.query(
    `INSERT INTO users (email, password_hash, full_name, role_id, site_id)
     SELECT 'bootstrap-ceo@test.eset.local', 'x', 'Bootstrap CEO', r.id, $1
     FROM roles r WHERE r.name = 'CEO'
     RETURNING id`,
    [site.rows[0].id],
  );
  const ceoId = ceo.rows[0].id;
  originalCeoBefore = (
    await target.query(
      `SELECT id, email, password_hash, full_name, role_id, is_active, site_id,
              session_version, must_change_password
       FROM users WHERE id = $1`,
      [ceoId],
    )
  ).rows[0];

  // This second CEO is deliberately older. A timestamp heuristic would keep
  // the wrong identity; the reset must preserve the configured original CEO.
  await target.query(
    `INSERT INTO users (email, password_hash, full_name, role_id, site_id, created_at)
     SELECT 'older-other-ceo@test.eset.local', 'x', 'Older Other CEO', r.id, $1, '2000-01-01T00:00:00Z'
     FROM roles r WHERE r.name = 'CEO'`,
    [site.rows[0].id],
  );

  await target.query(
    `INSERT INTO users (email, password_hash, full_name, role_id, site_id, department_id)
     SELECT 'demo-lead@test.eset.local', 'x', 'Demo Lead', r.id, $1, $2
     FROM roles r WHERE r.name = 'TEAM_LEAD'`,
    [site.rows[0].id, department.rows[0].id],
  );

  const gatePass = await target.query(
    `INSERT INTO gate_passes (gate_pass_number, issuing_department_id, requested_by, destination,
                              driver_name, driver_phone, vehicle_registration, purpose,
                              created_by_user_id, site_id)
     VALUES ('ESD-2026-000001', $1, 'Demo', 'Demo destination', 'Demo Driver', '+920000000000',
             'DEMO-1', 'SAMPLE', $2, $3)
     RETURNING id`,
    [department.rows[0].id, ceoId, site.rows[0].id],
  );

  await target.query(
    `INSERT INTO gate_pass_audit_log (gate_pass_id, actor_user_id, action, new_status)
     VALUES ($1, $2, 'CREATE', 'DRAFT')`,
    [gatePass.rows[0].id, ceoId],
  );
  await target.query(
    `INSERT INTO drivers (site_id, name, phone, created_by_user_id) VALUES ($1, 'Demo Driver', '+920000000000', $2)`,
    [site.rows[0].id, ceoId],
  );
  await target.query(
    `INSERT INTO vehicles (site_id, registration_number, created_by_user_id) VALUES ($1, 'DEMO-1', $2)`,
    [site.rows[0].id, ceoId],
  );
});

after(async () => {
  if (target) await target.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
});

test("the reset refuses production, an unconfirmed target, and a production-looking database", () => {
  assert.match(runReset({ NODE_ENV: "production" }).stderr, /NODE_ENV is production/);
  assert.match(runReset({ ESDMS_RESET_CONFIRM: "" }).stderr, /set ESDMS_RESET_CONFIRM/);
  assert.match(runReset({ ESDMS_RESET_CONFIRM: "not-the-database" }).stderr, /set ESDMS_RESET_CONFIRM/);
  assert.match(
    runReset({
      DATABASE_URL: "postgresql://localhost:5432/esdms_production",
      ESDMS_RESET_CONFIRM: "esdms_production",
    }).stderr,
    /looks like a production target/,
  );
  assert.match(runReset({ ESDMS_ORIGINAL_CEO_EMAIL: "" }).stderr, /ESDMS_ORIGINAL_CEO_EMAIL is required/);
  assert.match(
    runReset({ ESDMS_ORIGINAL_CEO_EMAIL: "not-the-original@test.eset.local" }).stderr,
    /configured permanent original CEO is missing/,
  );

  // A refused run must not have touched anything.
  assert.ok(count("gate_passes"), "refusals leave the data alone");
});

test("the reset clears operational data, preserves the security model, and keeps the permanent original CEO", async () => {
  assert.ok((await count("gate_passes")) > 0, "there is real data to clear");

  const result = runReset();
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /Removed:/);
  assert.match(result.stdout, /gate_passes: 1/);

  for (const table of [
    "gate_passes",
    "gate_pass_files",
    "gate_pass_audit_log",
    "drivers",
    "vehicles",
    "employees",
    "departments",
    "positions",
    "company_items",
    "notification_outbox",
    "governance_audit_log",
  ]) {
    assert.equal(await count(table), 0, `${table} must be empty after the reset`);
  }

  for (const table of ["roles", "permissions", "role_permissions", "permission_bundles", "units_of_measure"]) {
    assert.ok((await count(table)) > 0, `${table} must be preserved`);
  }

  const remainingUsers = await target.query(
    `SELECT u.id, u.email, u.password_hash, u.full_name, u.role_id, u.is_active,
            u.site_id, u.session_version, u.must_change_password, r.name AS role
     FROM users u JOIN roles r ON r.id = u.role_id`,
  );
  assert.equal(remainingUsers.rowCount, 1, "exactly one permanent original CEO remains");
  assert.equal(remainingUsers.rows[0].role, "CEO");
  assert.equal(remainingUsers.rows[0].email, "bootstrap-ceo@test.eset.local");
  const { role: _role, ...preservedCeo } = remainingUsers.rows[0];
  assert.deepEqual(preservedCeo, originalCeoBefore, "identity, credentials, status, and authority must be unchanged");
  assert.equal(await count("sites"), 1, "exactly one Site remains");

  // The protective triggers are restored, not left disabled — the whole point
  // of scoping the disable to the reset transaction. Checked against
  // pg_trigger rather than by attempting a DELETE, because a DELETE matching
  // no rows never fires a BEFORE DELETE trigger and would pass either way.
  const disabled = await target.query(
    `SELECT c.relname, t.tgname FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
     WHERE NOT t.tgisinternal AND t.tgenabled = 'D'`,
  );
  assert.equal(
    disabled.rowCount,
    0,
    `no trigger may be left disabled: ${disabled.rows.map((r) => `${r.relname}.${r.tgname}`).join(", ")}`,
  );

  // And the guarantee still bites on a real row inserted after the reset.
  const site = await target.query("SELECT id FROM sites LIMIT 1");
  const ceo = await target.query("SELECT id FROM users LIMIT 1");
  const department = await target.query(
    "INSERT INTO departments (name, site_id) VALUES ('Rebuilt', $1) RETURNING id",
    [site.rows[0].id],
  );
  const rebuilt = await target.query(
    `INSERT INTO gate_passes (gate_pass_number, issuing_department_id, requested_by, destination,
                              driver_name, driver_phone, vehicle_registration, purpose,
                              created_by_user_id, site_id)
     VALUES ('ESD-2026-000002', $1, 'x', 'x', 'x', 'x', 'x', 'SAMPLE', $2, $3)
     RETURNING id`,
    [department.rows[0].id, ceo.rows[0].id, site.rows[0].id],
  );
  await assert.rejects(
    target.query("DELETE FROM gate_passes WHERE id = $1", [rebuilt.rows[0].id]),
    /not permitted/i,
    "gate_passes must still refuse DELETE after a reset",
  );
});

test("the reset is repeatable", async () => {
  // The previous test deliberately left one department and one Gate Pass
  // behind, so this proves a second run clears them too rather than only
  // proving a no-op against an already-empty database.
  const result = runReset();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await count("gate_passes"), 0);
  assert.equal(await count("departments"), 0);

  const third = runReset();
  assert.equal(third.status, 0, third.stderr);
  assert.match(third.stdout, /Removed: nothing \(already reset\)\./);
  assert.match(third.stdout, /permanent original CEO login/);
});
