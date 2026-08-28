// MD-HF-04/05 — the upgrade boundary.
//
// A Demand created under the OLD schema could legitimately leave DRAFT and
// then be forced back to DRAFT by direct SQL, because nothing forbade that
// yet. After the hotfix migration its current status is indistinguishable
// from an untouched DRAFT, and the rollback trigger cannot reconstruct
// history it was not present for. The persistent draft_delete_eligible flag
// is what closes this, and this suite proves it by actually migrating
// through the real baseline rather than simulating one.
//
// Runs against its own throwaway database so the migrate-down/up sequence
// cannot disturb the shared test database or any other suite.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import pg from "pg";

const BASELINE_MIGRATION = "1787423000000"; // the migration immediately before the hotfix
const HOTFIX_MIGRATION = "1787424000000_demand-draft-delete";
const DB_NAME = `eset_upgrade_boundary_${process.pid}`;
const DB_URL = `postgresql://localhost:5432/${DB_NAME}`;
const backendRoot = path.resolve(import.meta.dirname, "..");

let admin;
let db;

function migrate(...args) {
  execFileSync("npx", ["node-pg-migrate", ...args], {
    cwd: backendRoot,
    env: { ...process.env, DATABASE_URL: DB_URL },
    stdio: "pipe",
  });
}

async function seedIds() {
  await db.query("INSERT INTO sites (code, name) VALUES ('UB', 'Upgrade Boundary Site')");
  await db.query(
    "INSERT INTO departments (name, site_id) SELECT 'Upgrade Boundary Dept', id FROM sites WHERE code = 'UB'",
  );
  await db.query(`
    INSERT INTO users (email, password_hash, full_name, role_id, site_id)
    SELECT 'ub@test.local', 'x', 'Upgrade Boundary', r.id, s.id
    FROM roles r, sites s WHERE r.name = 'CEO' AND s.code = 'UB'
  `);
}

// A Demand that reaches "currently DRAFT" only by way of a rollback the old
// schema allowed — the exact shape the flag has to catch.
async function createLegacyRolledBackDraft(demandNumber) {
  await db.query(
    `INSERT INTO material_demands (demand_number, site_id, department_id, created_by_user_id, status)
     SELECT $1, s.id, d.id, u.id, 'DRAFT'
     FROM sites s, departments d, users u
     WHERE s.code = 'UB' AND d.name = 'Upgrade Boundary Dept' AND u.email = 'ub@test.local'`,
    [demandNumber],
  );
  const { rows } = await db.query("SELECT id FROM material_demands WHERE demand_number = $1", [demandNumber]);
  const id = rows[0].id;

  await db.query(
    `INSERT INTO material_demand_audit_log (demand_id, actor_user_id, action, previous_status, new_status)
     SELECT $1, id, 'CREATE', NULL, 'DRAFT' FROM users WHERE email = 'ub@test.local'`,
    [id],
  );

  // C — leave DRAFT through the ordinary lifecycle, with its audit event.
  await db.query("UPDATE material_demands SET status = 'PENDING_INITIAL_REVIEW' WHERE id = $1", [id]);
  await db.query(
    `INSERT INTO material_demand_audit_log (demand_id, actor_user_id, action, previous_status, new_status)
     SELECT $1, id, 'SUBMIT', 'DRAFT', 'PENDING_INITIAL_REVIEW' FROM users WHERE email = 'ub@test.local'`,
    [id],
  );

  // D — force it back to DRAFT, which the baseline schema permits.
  await db.query("UPDATE material_demands SET status = 'DRAFT' WHERE id = $1", [id]);
  return id;
}

before(async () => {
  admin = new pg.Client({ connectionString: "postgresql://localhost:5432/postgres" });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
  await admin.query(`CREATE DATABASE ${DB_NAME}`);

  // A — baseline only: every migration up to, but excluding, the hotfix.
  migrate("up", BASELINE_MIGRATION, "--timestamp");

  db = new pg.Client({ connectionString: DB_URL });
  await db.connect();
  await seedIds();
});

after(async () => {
  if (db) await db.end();
  if (admin) {
    await admin.query(`DROP DATABASE IF EXISTS ${DB_NAME}`);
    await admin.end();
  }
});

test("the baseline schema really does allow the rollback this hotfix later forbids", async () => {
  const applied = await db.query("SELECT count(*)::int AS n FROM pgmigrations WHERE name = $1", [HOTFIX_MIGRATION]);
  assert.equal(applied.rows[0].n, 0, "the hotfix must not be applied yet, or this proves nothing");

  const id = await createLegacyRolledBackDraft("UB-LEGACY-1");

  // E — the history exists and the row now looks like an ordinary DRAFT.
  const row = await db.query("SELECT status FROM material_demands WHERE id = $1", [id]);
  assert.equal(row.rows[0].status, "DRAFT", "the old schema permitted the rollback");
  const audit = await db.query("SELECT action FROM material_demand_audit_log WHERE demand_id = $1 ORDER BY action", [id]);
  assert.deepEqual(audit.rows.map((r) => r.action), ["CREATE", "SUBMIT"], "its submit history is on record");
});

test("applying the hotfix marks every pre-existing Demand ineligible and undeletable", async () => {
  const legacyId = await createLegacyRolledBackDraft("UB-LEGACY-2");
  const auditBefore = await db.query("SELECT id FROM material_demand_audit_log WHERE demand_id = $1", [legacyId]);
  assert.ok(auditBefore.rowCount >= 2);

  // F — apply the hotfix on top of live legacy data.
  migrate("up");
  assert.equal(
    (await db.query("SELECT count(*)::int AS n FROM pgmigrations WHERE name = $1", [HOTFIX_MIGRATION])).rows[0].n,
    1,
  );

  // G — conservative backfill: it is NOT trusted just because it reads DRAFT.
  const flagged = await db.query("SELECT status, draft_delete_eligible FROM material_demands WHERE id = $1", [legacyId]);
  assert.equal(flagged.rows[0].status, "DRAFT");
  assert.equal(flagged.rows[0].draft_delete_eligible, false, "a pre-existing Demand is never assumed safe");

  // Every pre-existing row, not just this one.
  const anyEligible = await db.query("SELECT count(*)::int AS n FROM material_demands WHERE draft_delete_eligible");
  assert.equal(anyEligible.rows[0].n, 0, "the backfill left nothing eligible");

  // H — the direct parent DELETE is refused.
  await assert.rejects(
    db.query("DELETE FROM material_demands WHERE id = $1", [legacyId]),
    /not eligible for draft deletion/i,
  );

  // J — and its audit history is entirely intact.
  const auditAfter = await db.query("SELECT id FROM material_demand_audit_log WHERE demand_id = $1", [legacyId]);
  assert.equal(auditAfter.rowCount, auditBefore.rowCount, "no historical audit row cascaded away");
});

test("a legacy ineligible DRAFT cannot be laundered back into an eligible one", async () => {
  const legacyId = (await db.query("SELECT id FROM material_demands WHERE demand_number = 'UB-LEGACY-2'")).rows[0].id;

  await assert.rejects(
    db.query("UPDATE material_demands SET draft_delete_eligible = true WHERE id = $1", [legacyId]),
    /never be restored/i,
  );

  // Nor by cycling it out of and back into DRAFT.
  await assert.rejects(
    db.query("UPDATE material_demands SET status = 'PENDING_INITIAL_REVIEW', draft_delete_eligible = true WHERE id = $1", [legacyId]),
    /never be restored/i,
  );

  const still = await db.query("SELECT draft_delete_eligible FROM material_demands WHERE id = $1", [legacyId]);
  assert.equal(still.rows[0].draft_delete_eligible, false);
});

test("a Demand created after the migration starts eligible, and loses it on leaving DRAFT", async () => {
  await db.query(`
    INSERT INTO material_demands (demand_number, site_id, department_id, created_by_user_id, status)
    SELECT 'UB-NEW-1', s.id, d.id, u.id, 'DRAFT'
    FROM sites s, departments d, users u
    WHERE s.code = 'UB' AND d.name = 'Upgrade Boundary Dept' AND u.email = 'ub@test.local'
  `);
  const id = (await db.query("SELECT id FROM material_demands WHERE demand_number = 'UB-NEW-1'")).rows[0].id;

  const fresh = await db.query("SELECT draft_delete_eligible FROM material_demands WHERE id = $1", [id]);
  assert.equal(fresh.rows[0].draft_delete_eligible, true, "a new DRAFT is eligible");

  await db.query("UPDATE material_demands SET status = 'PENDING_INITIAL_REVIEW' WHERE id = $1", [id]);
  const left = await db.query("SELECT draft_delete_eligible FROM material_demands WHERE id = $1", [id]);
  assert.equal(left.rows[0].draft_delete_eligible, false, "leaving DRAFT clears it permanently");
});

test("a direct INSERT cannot grant itself eligibility outside DRAFT", async () => {
  await db.query(`
    INSERT INTO material_demands (demand_number, site_id, department_id, created_by_user_id, status, draft_delete_eligible)
    SELECT 'UB-FORGED', s.id, d.id, u.id, 'PENDING_INITIAL_REVIEW', true
    FROM sites s, departments d, users u
    WHERE s.code = 'UB' AND d.name = 'Upgrade Boundary Dept' AND u.email = 'ub@test.local'
  `);
  const forged = await db.query("SELECT draft_delete_eligible FROM material_demands WHERE demand_number = 'UB-FORGED'");
  assert.equal(forged.rows[0].draft_delete_eligible, false, "the database overrode the supplied value");
});

test("an eligible new DRAFT still deletes cleanly and takes only its own rows", async () => {
  await db.query(`
    INSERT INTO material_demands (demand_number, site_id, department_id, created_by_user_id, status)
    SELECT 'UB-NEW-2', s.id, d.id, u.id, 'DRAFT'
    FROM sites s, departments d, users u
    WHERE s.code = 'UB' AND d.name = 'Upgrade Boundary Dept' AND u.email = 'ub@test.local'
  `);
  const id = (await db.query("SELECT id FROM material_demands WHERE demand_number = 'UB-NEW-2'")).rows[0].id;
  await db.query(
    `INSERT INTO material_demand_audit_log (demand_id, actor_user_id, action)
     SELECT $1, id, 'CREATE' FROM users WHERE email = 'ub@test.local'`,
    [id],
  );

  const legacyAudit = await db.query(
    "SELECT count(*)::int AS n FROM material_demand_audit_log a JOIN material_demands m ON m.id = a.demand_id WHERE m.demand_number = 'UB-LEGACY-2'",
  );

  await db.query("DELETE FROM material_demands WHERE id = $1", [id]);
  assert.equal((await db.query("SELECT id FROM material_demands WHERE id = $1", [id])).rowCount, 0);
  assert.equal(
    (await db.query("SELECT id FROM material_demand_audit_log WHERE demand_id = $1", [id])).rowCount,
    0,
    "its own audit rows cascaded with it",
  );

  const legacyAfter = await db.query(
    "SELECT count(*)::int AS n FROM material_demand_audit_log a JOIN material_demands m ON m.id = a.demand_id WHERE m.demand_number = 'UB-LEGACY-2'",
  );
  assert.equal(legacyAfter.rows[0].n, legacyAudit.rows[0].n, "the preserved legacy history was untouched");
});
