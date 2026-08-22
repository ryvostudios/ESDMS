import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pool from "../src/config/database.js";

// The actual GRANT/REVOKE effect on a live Postgres role is exercised
// manually against a real instance (see docs/SECURITY.md §8.2) — running it
// here would mean creating cluster-wide roles from the test suite, which
// behaves differently across local pg_hba.conf setups. This is a narrower,
// environment-independent regression guard: the provisioning script itself
// must never grant more than the documented DML-only boundary, so a future
// edit can't silently reintroduce SUPERUSER/CREATEDB/CREATEROLE/DDL rights.
test("the runtime DB role provisioning script never grants superuser/DDL privileges", async () => {
  const scriptPath = path.resolve(import.meta.dirname, "../scripts/provision-db-roles.sql");
  const sql = await fs.readFile(scriptPath, "utf8");

  for (const forbidden of ["SUPERUSER", "CREATEDB", "CREATEROLE", "BYPASSRLS", "REPLICATION"]) {
    assert.ok(
      sql.includes(`NO${forbidden}`),
      `provisioning script must explicitly deny ${forbidden} (found no "NO${forbidden}")`,
    );
  }

  for (const ddlVerb of [/GRANT\s+CREATE\b/i, /GRANT\s+ALL\s+PRIVILEGES/i, /\bDROP\s+TABLE\b/i]) {
    assert.ok(!ddlVerb.test(sql), `provisioning script must never grant DDL rights (matched ${ddlVerb})`);
  }

  assert.match(sql, /GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM esdms_runtime/);
  assert.match(sql, /REVOKE CREATE ON SCHEMA public FROM PUBLIC/);
});

// Runs the actual script against the disposable test database, on a
// throwaway role dropped at the end — proves the grants really produce the
// effective privileges the SQL comments claim, not just that the script
// text looks right.
test("provisioning the runtime role actually produces DML-only effective privileges", async () => {
  const scriptPath = path.resolve(import.meta.dirname, "../scripts/provision-db-roles.sql");
  const sql = await fs.readFile(scriptPath, "utf8");

  try {
    await pool.query(sql);

    const role = await pool.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls
       FROM pg_roles WHERE rolname = 'esdms_runtime'`,
    );
    assert.deepEqual(role.rows[0], {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
    });

    const schemaPrivileges = await pool.query(
      `SELECT has_schema_privilege('esdms_runtime', 'public', 'USAGE') AS has_usage,
              has_schema_privilege('esdms_runtime', 'public', 'CREATE') AS has_create`,
    );
    assert.equal(schemaPrivileges.rows[0].has_usage, true);
    assert.equal(schemaPrivileges.rows[0].has_create, false, "the runtime role must never be able to CREATE");

    const tablePrivilege = await pool.query(
      `SELECT has_table_privilege('esdms_runtime', 'gate_passes', 'SELECT') AS can_select,
              has_table_privilege('esdms_runtime', 'gate_passes', 'INSERT') AS can_insert,
              has_table_privilege('esdms_runtime', 'gate_passes', 'TRUNCATE') AS can_truncate`,
    );
    assert.equal(tablePrivilege.rows[0].can_select, true);
    assert.equal(tablePrivilege.rows[0].can_insert, true);
    assert.equal(tablePrivilege.rows[0].can_truncate, false, "DML grants must not imply TRUNCATE");
  } finally {
    // DROP OWNED clears every privilege this role was ever granted (table,
    // schema, default-privilege entries) in this database — Postgres
    // refuses DROP ROLE while any of that is still outstanding.
    await pool.query(`DROP OWNED BY esdms_runtime`);
    await pool.query(`DROP ROLE IF EXISTS esdms_runtime`);
  }
});
