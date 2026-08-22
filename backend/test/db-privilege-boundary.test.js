import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

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
});
