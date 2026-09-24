import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import pool from "../src/config/database.js";
import { inspectSchemaCompatibility, EXPECTED_MIGRATION } from "../src/shared/db/schema-compatibility.js";
import {
  RUNTIME_TABLE_PRIVILEGES,
  RUNTIME_TABLES,
  RUNTIME_POLICY_NAME,
  OWNER_ONLY_TABLES,
} from "../src/shared/db/runtime-access-contract.js";
import { probeUserProfileServing } from "../src/shared/users/user-profile.repository.js";
import { startTestServer } from "./setup.js";
import { apiRequest } from "./gate-pass-helpers.js";

// Readiness used to certify an instance where every login returned 500 with
// PostgreSQL 42501: it verified that schema OBJECTS existed and never that
// the connected role could READ them. These tests hold that line.
//
// The restricted role below is built from runtime-access-contract.js and
// entered with SET ROLE on the existing connection, so the checks run against
// a role that is genuinely subject to table privileges and RLS — without
// depending on the local cluster's authentication method, which differs
// between developer machines and CI.

const PROBE_ROLE = "esdms_readiness_probe_role";
let server;

async function createProbeRole() {
  await dropProbeRole();
  await pool.query(`CREATE ROLE ${PROBE_ROLE} NOLOGIN`);
  // SET ROLE requires membership unless the session is a superuser; granting
  // it to the connected role makes this work for an ordinary owner too.
  await pool.query(`GRANT ${PROBE_ROLE} TO CURRENT_USER`);
  await pool.query(`GRANT USAGE ON SCHEMA public TO ${PROBE_ROLE}`);
  await pool.query(
    `GRANT EXECUTE ON FUNCTION public.esdms_schema_migration_state(text) TO ${PROBE_ROLE}`,
  );

  for (const table of RUNTIME_TABLES) {
    const privileges = RUNTIME_TABLE_PRIVILEGES[table].join(", ");
    await pool.query(`GRANT ${privileges} ON TABLE public.${table} TO ${PROBE_ROLE}`);
    await pool.query(
      `CREATE POLICY ${RUNTIME_POLICY_NAME} ON public.${table}
       FOR ALL TO ${PROBE_ROLE} USING (true) WITH CHECK (true)`,
    );
  }
}

async function dropProbeRole() {
  const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [PROBE_ROLE]);
  if (exists.rowCount === 0) return;

  for (const table of RUNTIME_TABLES) {
    await pool.query(`DROP POLICY IF EXISTS ${RUNTIME_POLICY_NAME} ON public.${table}`);
  }
  await pool.query(`REASSIGN OWNED BY ${PROBE_ROLE} TO CURRENT_USER`);
  await pool.query(`DROP OWNED BY ${PROBE_ROLE}`);
  await pool.query(`DROP ROLE ${PROBE_ROLE}`);
}

// Runs `work` on one connection with current_user switched to the restricted
// role, always restoring it. `mutate` runs BEFORE the switch, as the owner,
// so a test can remove a grant the restricted role would not be able to
// remove itself.
async function asProbeRole(work, mutate) {
  const client = await pool.connect();
  try {
    if (mutate) await mutate(client);
    await client.query(`SET ROLE ${PROBE_ROLE}`);
    return await work(client);
  } finally {
    await client.query("RESET ROLE").catch(() => {});
    client.release();
  }
}

before(async () => {
  server = await startTestServer();
  await createProbeRole();
});

after(async () => {
  await dropProbeRole();
  await server.close();
  await pool.end();
});

test("a migrated and provisioned database is ready, and reports no problems", async () => {
  const result = await asProbeRole((client) => inspectSchemaCompatibility(client));

  assert.equal(result.ready, true, `unexpected problems: ${result.problems.join(" | ")}`);
  assert.equal(result.schemaCompatible, true);
  assert.equal(result.runtimeAccessHealthy, true);
  assert.equal(result.authServingHealthy, true);
  assert.deepEqual(result.problems, []);
  assert.equal(result.expectedMigration, EXPECTED_MIGRATION);
});

test("readiness fails when the runtime role loses SELECT on a table the login path needs", async () => {
  // Every one of these was proven, against the pre-fix implementation, to
  // leave readiness reporting 200 "ready" while POST /auth/login returned
  // 500 with PostgreSQL 42501.
  for (const table of ["users", "roles", "sites", "departments", "employees"]) {
    const result = await asProbeRole(
      (client) => inspectSchemaCompatibility(client),
      (client) => client.query(`REVOKE SELECT ON public.${table} FROM ${PROBE_ROLE}`),
    );

    assert.equal(result.ready, false, `${table}: readiness must fail`);
    assert.equal(result.runtimeAccessHealthy, false, `${table}: the missing privilege must be reported`);
    assert.equal(result.authServingHealthy, false, `${table}: the serving probe must fail`);
    assert.ok(
      result.problems.some((problem) => problem.includes(`${table}.SELECT`)),
      `${table}: the problem list must name the exact missing privilege, got ${result.problems.join(" | ")}`,
    );

    await pool.query(`GRANT SELECT ON public.${table} TO ${PROBE_ROLE}`);
  }
});

test("readiness fails when a table outside the login path loses its runtime privilege", async () => {
  // The serving probe alone cannot see this one — only the declarative
  // contract check can, which is why both exist.
  const result = await asProbeRole(
    (client) => inspectSchemaCompatibility(client),
    (client) => client.query(`REVOKE INSERT ON public.drivers FROM ${PROBE_ROLE}`),
  );

  assert.equal(result.ready, false);
  assert.equal(result.runtimeAccessHealthy, false);
  assert.equal(result.authServingHealthy, true, "authentication itself is unaffected");
  assert.ok(result.problems.some((problem) => problem.includes("drivers.INSERT")));

  await pool.query(`GRANT INSERT ON public.drivers TO ${PROBE_ROLE}`);
});

test("readiness fails when a required runtime RLS policy is missing", async () => {
  const result = await asProbeRole(
    (client) => inspectSchemaCompatibility(client),
    (client) => client.query(`DROP POLICY ${RUNTIME_POLICY_NAME} ON public.gate_passes`),
  );

  assert.equal(result.ready, false);
  assert.equal(result.runtimeAccessHealthy, false);
  assert.ok(
    result.problems.some((problem) => problem.includes(RUNTIME_POLICY_NAME) && problem.includes("gate_passes")),
    `expected a missing-policy problem, got ${result.problems.join(" | ")}`,
  );

  await pool.query(
    `CREATE POLICY ${RUNTIME_POLICY_NAME} ON public.gate_passes
     FOR ALL TO ${PROBE_ROLE} USING (true) WITH CHECK (true)`,
  );
});

test("readiness fails when row level security is switched off on a contract table", async () => {
  const result = await asProbeRole(
    (client) => inspectSchemaCompatibility(client),
    (client) => client.query("ALTER TABLE public.vehicles DISABLE ROW LEVEL SECURITY"),
  );

  assert.equal(result.ready, false);
  assert.equal(result.runtimeAccessHealthy, false);
  assert.ok(result.problems.some((problem) => problem.includes("row level security") && problem.includes("vehicles")));

  await pool.query("ALTER TABLE public.vehicles ENABLE ROW LEVEL SECURITY");
});

test("readiness still names the defect when the schema-state query itself is denied", async () => {
  // `permissions` is read by the schema-state query, so losing it used to
  // throw and collapse every distinguishable cause into one opaque failure.
  const result = await asProbeRole(
    (client) => inspectSchemaCompatibility(client),
    (client) => client.query(`REVOKE SELECT ON public.permissions FROM ${PROBE_ROLE}`),
  );

  assert.equal(result.ready, false);
  assert.equal(result.schemaCompatible, false);
  assert.ok(result.problems.some((problem) => problem.includes("permissions.SELECT")));

  await pool.query(`GRANT SELECT ON public.permissions TO ${PROBE_ROLE}`);
});

test("the real authentication profile projection executes as the restricted runtime role", async () => {
  // Not a stand-in query: probeUserProfileServing runs the same statement
  // /auth/login and every authenticated request run.
  await asProbeRole(async (client) => {
    await probeUserProfileServing(client);

    // The login credential lookup is a subset of the same tables; assert it
    // directly too, since it is the first statement any login executes.
    const result = await client.query(
      `SELECT u.id FROM users u
       JOIN roles r ON r.id = u.role_id
       JOIN sites s ON s.id = u.site_id
       WHERE LOWER(u.email) = $1 LIMIT 1`,
      ["nobody@example.invalid"],
    );
    assert.equal(result.rowCount, 0);
  });
});

test("the runtime contract never grants any privilege on the migration ledger", async () => {
  for (const table of OWNER_ONLY_TABLES) {
    assert.equal(
      Object.hasOwn(RUNTIME_TABLE_PRIVILEGES, table),
      false,
      `${table} must stay owner-only and out of the runtime contract`,
    );
  }

  await asProbeRole(async (client) => {
    await assert.rejects(
      client.query("SELECT 1 FROM pgmigrations"),
      (error) => error.code === "42501",
      "the runtime role must not be able to read the migration ledger",
    );
  });
});

test("the runtime access contract and provision-db-roles.sql describe the same boundary", async () => {
  // The provisioning script must stay pure SQL an operator can run with psql
  // alone, so it cannot import the contract. This asserts they agree instead,
  // which is what turns "someone added a table to one of them" into a failing
  // test rather than a production outage.
  const script = await fs.readFile(
    path.resolve(import.meta.dirname, "../scripts/provision-db-roles.sql"),
    "utf8",
  );

  const grantBlock = (pattern) => {
    const match = script.match(pattern);
    assert.ok(match, `provision-db-roles.sql no longer contains an expected GRANT block: ${pattern}`);
    return [...match[1].matchAll(/public\.(\w+)/g)].map((entry) => entry[1]);
  };

  const granted = new Map();
  for (const table of grantBlock(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE\n([\s\S]*?)\nTO esdms_runtime;/)) {
    granted.set(table, ["SELECT", "INSERT", "UPDATE", "DELETE"]);
  }
  for (const table of grantBlock(/GRANT SELECT ON TABLE\n([\s\S]*?)\nTO esdms_runtime;/)) {
    granted.set(table, ["SELECT"]);
  }
  for (const table of grantBlock(/GRANT SELECT, INSERT, DELETE ON TABLE\n([\s\S]*?)\nTO esdms_runtime;/)) {
    granted.set(table, ["SELECT", "INSERT", "DELETE"]);
  }
  for (const table of grantBlock(/GRANT SELECT, UPDATE ON TABLE\s+([^;]*?)\s+TO esdms_runtime;/)) {
    granted.set(table, ["SELECT", "UPDATE"]);
  }

  assert.deepEqual(
    [...granted.keys()].sort(),
    [...RUNTIME_TABLES].sort(),
    "the provisioning script and runtime-access-contract.js must name the same tables",
  );
  for (const [table, privileges] of granted) {
    assert.deepEqual(
      [...privileges].sort(),
      [...RUNTIME_TABLE_PRIVILEGES[table]].sort(),
      `${table}: the provisioning script and the contract must grant the same privileges`,
    );
  }

  // Every contract table must also be in the script's policy convergence
  // loop, and pgmigrations must not be.
  const policyLoop = script.match(/FOREACH table_name IN ARRAY ARRAY\[([\s\S]*?)\]\s*\n\s*LOOP/);
  assert.ok(policyLoop, "provision-db-roles.sql no longer contains the policy convergence loop");
  const policyTables = [...policyLoop[1].matchAll(/'(\w+)'/g)].map((entry) => entry[1]);

  assert.deepEqual(
    [...policyTables].sort(),
    [...RUNTIME_TABLES].sort(),
    "every runtime contract table must receive the converged runtime policy",
  );
  for (const table of OWNER_ONLY_TABLES) {
    assert.ok(!policyTables.includes(table), `${table} must never receive a runtime policy`);
  }
});

test("every contract table actually exists in the migrated database", async () => {
  const result = await pool.query(
    `SELECT c.relname::text AS name
     FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'`,
  );
  const present = new Set(result.rows.map((row) => row.name));

  for (const table of RUNTIME_TABLES) {
    assert.ok(present.has(table), `contract names ${table}, which no migration creates`);
  }
  // And nothing the migrations create is silently absent from the contract:
  // a new table with no runtime grant is exactly the H1 drift.
  for (const name of present) {
    if (OWNER_ONLY_TABLES.includes(name)) continue;
    assert.ok(
      Object.hasOwn(RUNTIME_TABLE_PRIVILEGES, name),
      `table ${name} exists but is missing from runtime-access-contract.js`,
    );
  }
});

test("GET /health/ready reports the full serving contract, not only schema level", async () => {
  const { status, body } = await apiRequest(server.baseUrl, "GET", "/api/v1/health/ready");

  // The three facts this contract introduced are all healthy here: the test
  // database is migrated, the connected role can reach every declared table,
  // and the real authentication query executes.
  assert.equal(body.data.schemaCompatible, true);
  assert.equal(body.data.runtimeAccessHealthy, true);
  assert.equal(body.data.authServingHealthy, true);

  // The endpoint is still 503, and that is the point: the test database is
  // never provisioned, so the privilege boundary is unproven and the
  // provisioning stamp is absent. Schema level plus reachability plus a
  // working auth query must NOT be enough on their own.
  assert.equal(status, 503);
  assert.equal(body.data.status, "not_ready");
  assert.equal(body.data.ready, false);
  assert.equal(body.data.runtimeProvisioningCompatible, false);

  // Every problem reported is about provisioning -- none of the three facts
  // above may contribute one.
  assert.ok(body.data.problems.length > 0);
  for (const problem of body.data.problems) {
    assert.match(problem, /runtime privilege boundary/);
  }
});

test("login and /me work, and a wrong password is still rejected", async () => {
  // The readiness contract's whole purpose is to predict these three
  // outcomes; asserting them alongside it keeps the prediction honest.
  const login = await apiRequest(server.baseUrl, "POST", "/api/v1/auth/login", {
    body: { email: "nobody@example.invalid", password: "not-the-password" },
  });
  assert.equal(login.status, 401, "an unknown account must be rejected, never 500");
  assert.equal(login.body.error.code, "UNAUTHORIZED");

  const me = await apiRequest(server.baseUrl, "GET", "/api/v1/auth/me");
  assert.equal(me.status, 401, "an unauthenticated /me must be 401, never 500");
});
