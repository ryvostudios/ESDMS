import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import pg from "pg";
import argon2 from "argon2";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const storageRoot=fs.mkdtempSync(path.join(os.tmpdir(),"esdms-reset-storage-"));

function runReset(env = {}, args = []) {
  const childEnv = {
    ...process.env,
    DATABASE_URL: targetUrl,
    STORAGE_PROVIDER:"local",
    STORAGE_DIR:storageRoot,
    ESDMS_RESET_CONFIRM: databaseName,
    ESDMS_RESET_BACKUP_CONFIRMED: databaseName,
    ESDMS_ORIGINAL_CEO_EMAIL: "bootstrap-ceo@test.eset.local",
    ...env,
  };
  for (const [name, value] of Object.entries(childEnv)) {
    if (value === undefined) delete childEnv[name];
  }
  return spawnSync(process.execPath, ["scripts/reset-operational-data.js", ...args], {
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
     SELECT 'bootstrap-ceo@test.eset.local', $2, 'Bootstrap CEO', r.id, $1
     FROM roles r WHERE r.name = 'CEO'
     RETURNING id`,
    [site.rows[0].id, await argon2.hash("Reset-Rehearsal-Password-123!")],
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
  fs.rmSync(storageRoot,{recursive:true,force:true});
  if (target) await target.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    await admin.end();
  }
});

test("the reset refuses production, an unconfirmed target, and a production-looking database", async () => {
  assert.match(runReset({ DATABASE_URL:"postgresql://example.invalid/demo" }).stderr,/only a verified local environment/);
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
  assert.ok(await count("gate_passes"), "refusals leave the data alone");
});

test("dry run is read-only, includes current storage/configuration and never exposes encrypted credentials", async () => {
  const before = await count("gate_passes");
  const result = runReset({ ESDMS_RESET_CONFIRM: undefined }, ["--dry-run"]);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout.slice(result.stdout.indexOf("{")));
  assert.equal(report.remove.gate_passes, before);
  assert.ok(report.preserve.departments > 0);
  assert.equal(report.preserve.cms_settings, 10);
  assert.equal(report.connections.length, 2);
  assert.equal(await count("gate_passes"), before);
});

test("cloud dependencies and missing backup confirmation refuse before deleting any business rows", async () => {
  const before = await count("gate_passes");
  await target.query("UPDATE cloud_storage_connections SET credentials='encrypted-test-placeholder',status='connected' WHERE provider='dropbox'");
  let result = runReset();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cloud objects\/connections/);
  assert.doesNotMatch(result.stdout + result.stderr, /encrypted-test-placeholder/);
  assert.equal(await count("gate_passes"), before);
  await target.query("UPDATE cloud_storage_connections SET credentials=NULL,status='disconnected' WHERE provider='dropbox'");
  result = runReset({ ESDMS_RESET_BACKUP_CONFIRMED: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /freshly verified backup/);
  assert.equal(await count("gate_passes"), before);
});

test("unclassified tables and undeleted cloud objects fail closed", async () => {
  await target.query("CREATE TABLE unclassified_reset_fixture(id integer)");
  let result=runReset({},["--dry-run"]);
  assert.notEqual(result.status,0); assert.match(result.stderr,/unclassified public tables/);
  await target.query("DROP TABLE unclassified_reset_fixture");
  await target.query("INSERT INTO cloud_storage_objects(connection_id,account_id,kind,logical_path) SELECT id,'test-account','folder','ESDMS/reset-test' FROM cloud_storage_connections WHERE provider='dropbox'");
  result=runReset();
  assert.notEqual(result.status,0); assert.match(result.stderr,/cloud objects\/connections/);
  assert.ok(await count("gate_passes"));
  await target.query("UPDATE cloud_storage_objects SET state='deleted'");
  await target.query("INSERT INTO user_permission_overrides(user_id,permission_id,effect,granted_by_user_id) SELECT $1,id,'DENY',$1 FROM permissions LIMIT 1",[originalCeoBefore.id]);
  result=runReset();
  assert.notEqual(result.status,0); assert.match(result.stderr,/individual authority assignments/);
  await target.query("DELETE FROM user_permission_overrides WHERE user_id=$1",[originalCeoBefore.id]);
  const gatePass=(await target.query("SELECT id FROM gate_passes LIMIT 1")).rows[0];
  fs.writeFileSync(path.join(storageRoot,"reset-fixture.pdf"),"test-file");
  await target.query(`INSERT INTO gate_pass_files(gate_pass_id,file_type,storage_key,mime_type,size_bytes,checksum_sha256,created_by_user_id)
    VALUES ($1,'APPROVED_PDF','reset-fixture.pdf','application/pdf',9,$2,$3)`,[gatePass.id,"a".repeat(64),originalCeoBefore.id]);
  result=runReset();
  assert.notEqual(result.status,0); assert.match(result.stderr,/referenced local files still exist/);
  assert.ok(fs.existsSync(path.join(storageRoot,"reset-fixture.pdf")),"refusal never deletes bytes");
  assert.equal(await count("gate_pass_files"),1,"refusal retains the owning metadata");
  fs.unlinkSync(path.join(storageRoot,"reset-fixture.pdf"));
  await target.query("UPDATE cms_settings SET updated_by_user_id=(SELECT id FROM users WHERE email='demo-lead@test.eset.local') WHERE key='login.heading'");
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
    "company_items",
    "notification_outbox",
    "governance_audit_log",
    "cloud_storage_objects",
    "cloud_storage_oauth_states",
  ]) {
    assert.equal(await count(table), 0, `${table} must be empty after the reset`);
  }

  for (const table of ["roles", "permissions", "role_permissions", "permission_bundles", "units_of_measure", "departments", "positions", "cms_settings"]) {
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

test("post-reset release verification, restricted-runtime CEO login and readiness remain healthy", () => {
  const runtimePassword = crypto.randomBytes(32).toString("hex");
  const runtimeUrl = new URL(targetUrl);
  runtimeUrl.username = "esdms_runtime"; runtimeUrl.password = runtimePassword;
  const env = { ...process.env, MIGRATION_DATABASE_URL:targetUrl, DATABASE_URL:runtimeUrl.toString(), ESDMS_RUNTIME_PASSWORD:runtimePassword };
  const release = spawnSync(process.execPath,["scripts/release-database.js"],{encoding:"utf8",env});
  assert.equal(release.status,0,release.stderr);
  assert.ok(!(release.stdout+release.stderr).includes(runtimePassword));
  const smoke = spawnSync(process.execPath,["test/fixtures/runtime-auth-smoke.mjs"],{encoding:"utf8",env:{...env,
    ESDMS_RUNTIME_SMOKE_EMAIL:"bootstrap-ceo@test.eset.local",ESDMS_RUNTIME_SMOKE_PASSWORD:"Reset-Rehearsal-Password-123!"}});
  assert.equal(smoke.status,0,smoke.stderr);
  const result=JSON.parse(smoke.stdout.trim().split("\n").at(-1));
  assert.equal(result.loginStatus,200); assert.equal(result.meStatus,200);
  assert.equal(result.invalidLoginStatus,401); assert.equal(result.readinessStatus,200);
  assert.equal(result.appliedMigrationCount,48); assert.equal(result.runtimeProvisioningCompatible,true);
  const cms=spawnSync(process.execPath,["--input-type=module","-e",`
    import app from './src/app.js'; import pool from './src/config/database.js';
    const server=app.listen(0,'127.0.0.1'); await new Promise(r=>server.once('listening',r));
    try {
      const base='http://127.0.0.1:'+server.address().port+'/api/v1';
      const login=await fetch(base+'/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({email:process.env.ESDMS_RUNTIME_SMOKE_EMAIL,password:process.env.ESDMS_RUNTIME_SMOKE_PASSWORD})});
      const cookie=login.headers.get('set-cookie')?.split(';')[0]; const codes=[];
      for(const route of ['/cms','/cms/settings/branding','/cms/permissions']) codes.push((await fetch(base+route,{headers:{Cookie:cookie||''}})).status);
      console.log(JSON.stringify(codes));
    } finally { await new Promise(r=>server.close(r)); await pool.end(); }
  `],{encoding:"utf8",env:{...env,ESDMS_RUNTIME_SMOKE_EMAIL:"bootstrap-ceo@test.eset.local",ESDMS_RUNTIME_SMOKE_PASSWORD:"Reset-Rehearsal-Password-123!"}});
  assert.equal(cms.status,0,cms.stderr);
  assert.deepEqual(JSON.parse(cms.stdout.trim().split("\n").at(-1)),[200,200,200]);
});

test("the reset is repeatable", async () => {
  // The previous reset test left a department and a Gate Pass behind.
  // The next run clears the operational pass while retaining configuration.
  const result = runReset();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await count("gate_passes"), 0);
  assert.ok(await count("departments"));

  const third = runReset();
  assert.equal(third.status, 0, third.stderr);
  assert.match(third.stdout, /Removed: nothing \(already reset\)\./);
  assert.match(third.stdout, /permanent original CEO login/);
});
