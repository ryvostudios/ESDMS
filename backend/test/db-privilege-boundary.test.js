import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import config from "../src/config/env.js";
import pool from "../src/config/database.js";

const APPLICATION_TABLES = [
  "departments",
  "gate_pass_audit_log",
  "gate_pass_files",
  "gate_pass_items",
  "gate_pass_number_counters",
  "gate_passes",
  "notification_outbox",
  "permissions",
  "role_permissions",
  "roles",
  "sites",
  "users",
];

const ALL_TABLES = [...APPLICATION_TABLES, "pgmigrations"];

// APPLICATION_TABLES/ALL_TABLES above intentionally stay pinned to exactly
// what migration 1787401000000_database-runtime-security-boundary.js's own
// source enables RLS on (see the first test below, which reads that file's
// text) — that migration predates this table and must never be edited to
// mention it. Everything that checks *live* database/provisioning-script
// state instead (i.e. the current, cumulative boundary after every
// migration, including 1787403000000_workforce-permission-foundation.js)
// uses these two instead.
const WORKFORCE_TABLES = [
  "positions",
  "employment_types",
  "employees",
  "employment_assignments",
  "temporary_assignments",
  "employee_profile_photos",
  "employee_personal_details",
  "employee_emergency_contacts",
  "employee_profile_sections",
  "employee_custom_fields",
  "employee_custom_field_values",
  "employee_document_types",
  "employee_documents",
  "employee_document_requests",
  "employee_compensation_records",
  "employee_contract_number_counters",
  "employee_contracts",
  "rotation_policies",
  "employee_rotation_ledger",
  "leave_types",
  "leave_requests",
  "employee_business_history",
];

// Material Catalog (Procurement & Material Receiving V1, Checkpoint 1) —
// see 1787412000000_material-catalog-foundation.js and
// docs/PROCUREMENT_RECEIVING_SPEC.md.
const MATERIAL_CATALOG_TABLES = ["units_of_measure", "company_items", "department_material_catalog"];

// Material Demand (Procurement & Material Receiving V1, Checkpoint 2) —
// see 1787413000000_material-demand-foundation.js.
const MATERIAL_DEMAND_TABLES = [
  "material_demand_number_counters",
  "material_demands",
  "material_demand_lines",
  "material_demand_audit_log",
];

// Material Demand initial approval gate (Checkpoint 3) — see
// 1787414000000_material-demand-initial-approval.js.
const MATERIAL_DEMAND_APPROVAL_TABLES = ["material_demand_approvals"];

// Management's line-level purchasing disposition (out-of-budget exclusion)
// — see 1787421000000_demand-line-disposition.js.
const LINE_DISPOSITION_TABLES = ["material_demand_line_dispositions"];

// Procurement estimated pricing (Checkpoint 4) is isolated in two
// sensitive tables — see 1787415000000_material-demand-procurement-pricing.js.
const PROCUREMENT_PRICING_TABLES = ["material_demand_pricing", "material_demand_pricing_lines"];

// Official IPO + Procurement purchasing (Checkpoint 6a) — see
// 1787417000000_ipo-and-purchasing.js. document_number_* is the shared,
// configurable numbering surface for IPO and Delivery Challan;
// procurement_audit_log is the append-only audit stream for the whole
// IPO -> DC -> Receiving chain.
const IPO_TABLES = [
  "document_number_settings",
  "document_number_counters",
  "ipos",
  "ipo_lines",
  // Each partial purchase is its own immutable event; the line-level total is
  // derived from them (see 1787417000000_ipo-and-purchasing.js).
  "ipo_purchase_events",
  "procurement_audit_log",
];

// Delivery Challan (Checkpoint 6b) — see 1787418000000_delivery-challan.js.
const DELIVERY_CHALLAN_TABLES = ["delivery_challans", "delivery_challan_lines"];

// Material Receiving, Admin fallback custody and department confirmation
// (Checkpoint 7) — see 1787419000000_material-receiving.js. No inventory
// balance/ledger/batch table exists or is expected here (spec §24).
const RECEIVING_TABLES = ["material_receipts", "material_receipt_lines"];

// Stored, historically stable IPO/DC renderings backing both download and
// official WhatsApp delivery — see 1787422000000_procurement-document-delivery.js.
const PROCUREMENT_DOCUMENT_TABLES = ["procurement_documents"];

// Authoritative claim of an unresolved prior quantity against its source, so
// the same shortage cannot be carried into several Demands — see
// 1787423000000_carry-forward-allocation.js.
const CARRY_FORWARD_TABLES = ["carry_forward_allocations"];

const RUNTIME_APPLICATION_TABLES = [
  ...APPLICATION_TABLES,
  "user_permission_overrides",
  "governance_audit_log",
  ...WORKFORCE_TABLES,
  ...MATERIAL_CATALOG_TABLES,
  ...MATERIAL_DEMAND_TABLES,
  ...MATERIAL_DEMAND_APPROVAL_TABLES,
  ...PROCUREMENT_PRICING_TABLES,
  ...IPO_TABLES,
  ...DELIVERY_CHALLAN_TABLES,
  ...RECEIVING_TABLES,
  ...LINE_DISPOSITION_TABLES,
  ...PROCUREMENT_DOCUMENT_TABLES,
  ...CARRY_FORWARD_TABLES,
];
const RUNTIME_ALL_TABLES = [...RUNTIME_APPLICATION_TABLES, "pgmigrations"];
const BROWSER_ROLES = ["anon", "authenticated"];
const TEST_SEQUENCE = "esdms_security_test_sequence";
const TEST_OTHER_OWNER = "esdms_security_other_owner";
const TEST_TRIGGER_TABLE = "esdms_security_trigger_table";
const TEST_TRIGGER_FUNCTION = "esdms_security_trigger_function";
const TEST_FUTURE_FUNCTION = "esdms_security_future_function";
const scriptPath = path.resolve(import.meta.dirname, "../scripts/provision-db-roles.sql");
const migrationPath = path.resolve(
  import.meta.dirname,
  "../migrations/1787401000000_database-runtime-security-boundary.js",
);
const functionMigrationPath = path.resolve(
  import.meta.dirname,
  "../migrations/1787402000000_public-function-execution-boundary.js",
);

function assertIsDisposableTestDatabase() {
  let databaseUrl;
  try {
    databaseUrl = new URL(config.databaseUrl);
  } catch {
    throw new Error("Refusing DB security integration test: DATABASE_URL is not a URL for the isolated test database.");
  }

  const databaseName = databaseUrl.pathname.replace(/^\//, "");
  if (databaseName !== "eset_test") {
    throw new Error("Refusing DB security integration test: DATABASE_URL is not the isolated eset_test database.");
  }

  if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseUrl.hostname)) {
    throw new Error("Refusing DB security integration test: eset_test is not hosted on the local machine.");
  }

  return databaseUrl;
}

function assertPsqlAvailable(t) {
  const result = spawnSync("psql", ["--version"], { encoding: "utf8" });
  if (result.error?.code === "ENOENT") {
    t.skip("psql is not installed; static provisioning checks still ran");
    return false;
  }
  assert.equal(result.status, 0, result.stderr);
  return true;
}

function buildPsqlEnv(databaseUrl, runtimePassword) {
  const env = {
    ...process.env,
    PGHOST: databaseUrl.hostname,
    PGPORT: databaseUrl.port || "5432",
    PGDATABASE: databaseUrl.pathname.replace(/^\//, ""),
    PGUSER: decodeURIComponent(databaseUrl.username),
    PGPASSWORD: decodeURIComponent(databaseUrl.password),
  };

  delete env.ESDMS_RUNTIME_PASSWORD;
  if (runtimePassword !== undefined) {
    env.ESDMS_RUNTIME_PASSWORD = runtimePassword;
  }
  return env;
}

function runProvisioning(databaseUrl, { runtimePassword, echoOption } = {}) {
  const args = ["--no-psqlrc"];
  if (echoOption) {
    args.push(echoOption);
  }
  args.push("--file", scriptPath);

  return spawnSync("psql", args, {
    env: buildPsqlEnv(databaseUrl, runtimePassword),
    encoding: "utf8",
    maxBuffer: 2 * 1024 * 1024,
  });
}

function assertSecretAbsent(result, secret) {
  assert.ok(!result.stdout.includes(secret), "psql stdout must never contain the runtime password");
  assert.ok(!result.stderr.includes(secret), "psql stderr must never contain the runtime password");
}

function assertProvisioningSucceeded(result, label) {
  assert.equal(result.status, 0, `${label} failed; captured psql output withheld to protect the test password`);
}

function authenticateAsRuntime(databaseUrl, password) {
  return spawnSync(
    "psql",
    ["--no-psqlrc", "--tuples-only", "--no-align", "--command", "SELECT current_user"],
    {
      env: {
        ...buildPsqlEnv(databaseUrl),
        PGUSER: "esdms_runtime",
        PGPASSWORD: password,
      },
      encoding: "utf8",
    },
  );
}

function runSqlAsRuntime(databaseUrl, password, sql) {
  return spawnSync("psql", ["--no-psqlrc", "--quiet", "--tuples-only", "--no-align", "--command", sql], {
    env: {
      ...buildPsqlEnv(databaseUrl),
      PGUSER: "esdms_runtime",
      PGPASSWORD: password,
    },
    encoding: "utf8",
  });
}

async function getFunctionExecution(functionName) {
  const result = await pool.query(
    `WITH target AS (
       SELECT p.oid, p.proacl, p.proowner
       FROM pg_proc p
       JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE n.nspname = 'public' AND p.proname = $1
     )
     SELECT
       EXISTS (
         SELECT 1
         FROM target f
         CROSS JOIN LATERAL aclexplode(COALESCE(f.proacl, acldefault('f', f.proowner))) a
         WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE'
       ) AS public_execute,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
         THEN has_function_privilege('anon', (SELECT oid FROM target), 'EXECUTE')
         ELSE false
       END AS anon_execute,
       CASE WHEN EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
         THEN has_function_privilege('authenticated', (SELECT oid FROM target), 'EXECUTE')
         ELSE false
       END AS authenticated_execute`,
    [functionName],
  );
  return result.rows[0];
}

async function cleanupRuntimeRole() {
  for (const table of RUNTIME_APPLICATION_TABLES) {
    await pool.query(`DROP POLICY IF EXISTS esdms_runtime_access ON public.${table}`);
  }
  await pool.query("DROP POLICY IF EXISTS esdms_runtime_access ON public.pgmigrations");

  const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'esdms_runtime'");
  if (exists.rowCount > 0) {
    await pool.query("ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TABLES FROM esdms_runtime");
    await pool.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM esdms_runtime");
    await pool.query("ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SEQUENCES FROM esdms_runtime");
    await pool.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM esdms_runtime",
    );
    await pool.query("DROP OWNED BY esdms_runtime");
    await pool.query("DROP ROLE esdms_runtime");
  }
}

async function cleanupBrowserRoles() {
  for (const role of BROWSER_ROLES) {
    const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    if (exists.rowCount > 0) {
      await pool.query(`ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON TABLES FROM ${role}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM ${role}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${role}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${role}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM ${role}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM ${role}`);
      await pool.query(`DROP OWNED BY ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  }
}

async function cleanupOtherOwner() {
  const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [TEST_OTHER_OWNER]);
  if (exists.rowCount === 0) {
    return;
  }

  for (const role of BROWSER_ROLES) {
    const targetExists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    if (targetExists.rowCount > 0) {
      await pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${TEST_OTHER_OWNER} IN SCHEMA public
         REVOKE ALL PRIVILEGES ON TABLES FROM ${role}`,
      );
      await pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${TEST_OTHER_OWNER} IN SCHEMA public
         REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${role}`,
      );
      await pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${TEST_OTHER_OWNER} IN SCHEMA public
         REVOKE EXECUTE ON FUNCTIONS FROM ${role}`,
      );
    }
  }
  await pool.query(`DROP OWNED BY ${TEST_OTHER_OWNER}`);
  await pool.query(`DROP ROLE ${TEST_OTHER_OWNER}`);
}

async function cleanupFunctionFixtures() {
  await pool.query(`DROP TABLE IF EXISTS public.${TEST_TRIGGER_TABLE}`);
  await pool.query(`DROP FUNCTION IF EXISTS public.${TEST_TRIGGER_FUNCTION}()`);
  await pool.query(`DROP FUNCTION IF EXISTS public.${TEST_FUTURE_FUNCTION}()`);
}

async function assertRuntimeRoleAbsentAndRlsIntact() {
  const role = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'esdms_runtime'");
  assert.equal(role.rowCount, 0);

  const policies = await pool.query(
    "SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'esdms_runtime_access'",
  );
  assert.equal(policies.rowCount, 0);

  const rls = await pool.query(
    `SELECT c.relrowsecurity
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])`,
    [RUNTIME_ALL_TABLES],
  );
  assert.equal(rls.rowCount, RUNTIME_ALL_TABLES.length);
  assert.ok(rls.rows.every((row) => row.relrowsecurity));
}

test("database runtime security migration enables RLS without depending on environment roles", async () => {
  const source = await fs.readFile(migrationPath, "utf8");

  for (const table of ALL_TABLES) {
    assert.match(
      source,
      new RegExp(`ALTER TABLE public\\.${table} ENABLE ROW LEVEL SECURITY`, "i"),
      `migration must enable RLS on public.${table}`,
    );
  }

  assert.doesNotMatch(source, /FORCE\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(source, /DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  assert.doesNotMatch(source, /CREATE\s+(ROLE|POLICY)\b/i);
  assert.match(source, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'anon'\)/);
  assert.match(source, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'\)/);
  for (const role of BROWSER_ROLES) {
    assert.match(source, new RegExp(`REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM ${role}`));
    assert.match(source, new RegExp(`REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM ${role}`));
    assert.match(
      source,
      new RegExp(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM ${role}`),
    );
    assert.match(
      source,
      new RegExp(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${role}`),
    );
  }
  assert.match(source, /intentionally irreversible/i);
  assert.match(source, /RAISE EXCEPTION/i);
});

test("public function migration removes current and future PUBLIC execution without runtime grants", async () => {
  const source = await fs.readFile(functionMigrationPath, "utf8");
  assert.match(source, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/i);
  assert.match(source, /ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/i);
  assert.match(source, /ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/i);
  assert.match(source, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'anon'\)/);
  assert.match(source, /IF EXISTS \(SELECT 1 FROM pg_roles WHERE rolname = 'authenticated'\)/);
  assert.doesNotMatch(source, /GRANT\s+EXECUTE[\s\S]+esdms_runtime/i);
  assert.match(source, /intentionally irreversible/i);
  assert.match(source, /RAISE EXCEPTION/i);

  const publicExecution = await pool.query(
    `SELECT 1
     FROM pg_proc p
     JOIN pg_namespace n ON n.oid = p.pronamespace
     CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a
     WHERE n.nspname = 'public'
       AND p.prokind <> 'p'
       AND a.grantee = 0
       AND a.privilege_type = 'EXECUTE'`,
  );
  assert.equal(publicExecution.rowCount, 0);

  await pool.query(
    `CREATE FUNCTION public.${TEST_FUTURE_FUNCTION}()
     RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
  );
  try {
    assert.deepEqual(await getFunctionExecution(TEST_FUTURE_FUNCTION), {
      public_execute: false,
      anon_execute: false,
      authenticated_execute: false,
    });
  } finally {
    await pool.query(`DROP FUNCTION public.${TEST_FUTURE_FUNCTION}()`);
  }
});

test("runtime provisioning SQL is secret-safe, explicit, and contains no legacy broad grant", async () => {
  const sql = await fs.readFile(scriptPath, "utf8");
  const executableSql = sql.replace(/--.*$/gm, "");

  assert.match(sql, /^\\set ON_ERROR_STOP on\r?\n\\set ECHO none/);
  assert.ok(
    sql.indexOf("\\set ECHO none") < sql.indexOf("\\getenv runtime_password ESDMS_RUNTIME_PASSWORD"),
    "psql echoing must be disabled before the runtime password enters a psql variable",
  );
  assert.match(sql, /\\getenv runtime_password ESDMS_RUNTIME_PASSWORD/);
  assert.doesNotMatch(sql, /CHANGE_ME|PASSWORD\s+'[^:]/i);
  assert.doesNotMatch(
    sql,
    /ALTER\s+ROLE\s+esdms_runtime[^;]*(NOSUPERUSER|NOCREATEDB|NOCREATEROLE|NOREPLICATION|NOBYPASSRLS)/i,
  );
  assert.match(sql, /rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls/);
  assert.match(sql, /AND rolcanlogin/);

  assert.doesNotMatch(executableSql, /GRANT[^;]+ON\s+ALL\s+TABLES\s+IN\s+SCHEMA\s+public/is);
  assert.doesNotMatch(executableSql, /GRANT[^;]+ON\s+ALL\s+SEQUENCES\s+IN\s+SCHEMA\s+public/is);
  assert.doesNotMatch(executableSql, /ALTER\s+DEFAULT\s+PRIVILEGES[^;]+GRANT/is);
  assert.doesNotMatch(executableSql, /GRANT\s+EXECUTE[^;]+esdms_runtime/is);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM esdms_runtime/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM esdms_runtime/);
  assert.match(sql, /REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC/);
  assert.match(sql, /ALTER DEFAULT PRIVILEGES\s+REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC/);
  assert.match(sql, /d\.defaclrole = \(SELECT oid FROM pg_roles WHERE rolname = current_user\)/);

  const explicitGrant = sql.match(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE([\s\S]*?)TO esdms_runtime;/i)?.[1];
  assert.ok(explicitGrant, "expected one explicit runtime table grant");
  for (const table of RUNTIME_APPLICATION_TABLES) {
    assert.match(explicitGrant, new RegExp(`public\\.${table}\\b`));
  }
  assert.doesNotMatch(explicitGrant, /pgmigrations/);

  assert.match(sql, /ALTER TABLE public\.pgmigrations ENABLE ROW LEVEL SECURITY/);
  assert.match(sql, /DROP POLICY IF EXISTS esdms_runtime_access ON public\.pgmigrations/);
  assert.doesNotMatch(sql, /CREATE POLICY[^;]+pgmigrations/is);
  assert.doesNotMatch(sql, /BYPASSRLS\s*;/i);
});

test("psql provisioning suppresses echo and converges twice to the verified least-privilege boundary", async (t) => {
  const databaseUrl = assertIsDisposableTestDatabase();
  if (!assertPsqlAvailable(t)) {
    return;
  }

  const runtimePassword = crypto.randomBytes(24).toString("base64url");

  await cleanupRuntimeRole();

  try {
    for (const [attempt, echoOption] of [
      [1, "--echo-queries"],
      [2, "--echo-all"],
    ]) {
      const result = runProvisioning(databaseUrl, {
        runtimePassword,
        echoOption,
      });

      assertProvisioningSucceeded(result, `provisioning attempt ${attempt} with ${echoOption}`);
      assertSecretAbsent(result, runtimePassword);
    }

    const role = await pool.query(
      `SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls, rolcanlogin
       FROM pg_roles WHERE rolname = 'esdms_runtime'`,
    );
    assert.deepEqual(role.rows[0], {
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
      rolreplication: false,
      rolbypassrls: false,
      rolcanlogin: true,
    });

    const schemaPrivileges = await pool.query(
      `SELECT has_schema_privilege('esdms_runtime', 'public', 'USAGE') AS has_usage,
              has_schema_privilege('esdms_runtime', 'public', 'CREATE') AS has_create`,
    );
    assert.deepEqual(schemaPrivileges.rows[0], { has_usage: true, has_create: false });

    const directTablePrivileges = await pool.query(
      `SELECT table_name, array_agg(privilege_type::text ORDER BY privilege_type::text) AS privileges
       FROM information_schema.table_privileges
       WHERE table_schema = 'public' AND grantee = 'esdms_runtime'
       GROUP BY table_name
       ORDER BY table_name`,
    );
    assert.equal(directTablePrivileges.rowCount, RUNTIME_APPLICATION_TABLES.length);
    assert.deepEqual(
      directTablePrivileges.rows.map((row) => row.table_name),
      [...RUNTIME_APPLICATION_TABLES].sort(),
    );
    for (const row of directTablePrivileges.rows) {
      assert.deepEqual(row.privileges, ["DELETE", "INSERT", "SELECT", "UPDATE"]);
    }

    const pgmigrationsPrivileges = await pool.query(
      `SELECT privilege_type,
              has_table_privilege('esdms_runtime', 'public.pgmigrations', privilege_type) AS granted
       FROM (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'))
         AS privileges(privilege_type)
       WHERE has_table_privilege('esdms_runtime', 'public.pgmigrations', privilege_type)`,
    );
    assert.equal(pgmigrationsPrivileges.rowCount, 0);

    const rls = await pool.query(
      `SELECT c.relname, c.relrowsecurity
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE n.nspname = 'public' AND c.relname = ANY($1::text[])
       ORDER BY c.relname`,
      [RUNTIME_ALL_TABLES],
    );
    assert.equal(rls.rowCount, RUNTIME_ALL_TABLES.length);
    assert.ok(rls.rows.every((row) => row.relrowsecurity));

    const policies = await pool.query(
      `SELECT tablename, permissive, roles::text[], cmd, qual, with_check
       FROM pg_policies
       WHERE schemaname = 'public' AND policyname = 'esdms_runtime_access'
       ORDER BY tablename`,
    );
    assert.equal(policies.rowCount, RUNTIME_APPLICATION_TABLES.length);
    assert.deepEqual(
      policies.rows.map((row) => row.tablename),
      [...RUNTIME_APPLICATION_TABLES].sort(),
    );
    assert.ok(
      policies.rows.every(
        (row) =>
          row.permissive === "PERMISSIVE" &&
          row.roles.length === 1 &&
          row.roles[0] === "esdms_runtime" &&
          row.cmd === "ALL" &&
          row.qual === "true" &&
          row.with_check === "true",
      ),
    );

    const sequencePrivileges = await pool.query(
      `SELECT 1
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) p(privilege_type)
       WHERE n.nspname = 'public'
         AND c.relkind = 'S'
         AND has_sequence_privilege('esdms_runtime', c.oid, p.privilege_type)`,
    );
    assert.equal(sequencePrivileges.rowCount, 0);

    const runtimeDefaults = await pool.query(
      `SELECT 1
       FROM pg_default_acl d
       LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
       CROSS JOIN LATERAL aclexplode(d.defaclacl) a
       JOIN pg_roles grantee ON grantee.oid = a.grantee
       WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
         AND (d.defaclnamespace = 0 OR n.nspname = 'public')
         AND d.defaclobjtype IN ('r', 'S')
         AND grantee.rolname = 'esdms_runtime'`,
    );
    assert.equal(runtimeDefaults.rowCount, 0);
  } finally {
    await cleanupRuntimeRole();
  }
});

test("hostile runtime password quoting is injection-safe and authenticates exactly", async (t) => {
  const databaseUrl = assertIsDisposableTestDatabase();
  if (!assertPsqlAvailable(t)) {
    return;
  }

  const hostilePassword = "LongEnough'; CREATE ROLE esdms_injected LOGIN; -- \\ $ spaces";
  await cleanupRuntimeRole();

  try {
    const result = runProvisioning(databaseUrl, {
      runtimePassword: hostilePassword,
      echoOption: "--echo-queries",
    });
    assertProvisioningSucceeded(result, "hostile-password provisioning");
    assertSecretAbsent(result, hostilePassword);

    const injectedRole = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'esdms_injected'");
    assert.equal(injectedRole.rowCount, 0, "hostile password text must not execute as SQL");

    const exactAuthentication = authenticateAsRuntime(databaseUrl, hostilePassword);
    assert.equal(exactAuthentication.status, 0, "the exact hostile password must authenticate");
    assert.equal(exactAuthentication.stdout.trim(), "esdms_runtime");

    const wrongAuthentication = authenticateAsRuntime(databaseUrl, `${hostilePassword}-wrong`);
    assert.notEqual(wrongAuthentication.status, 0, "a different password must not authenticate");
  } finally {
    await cleanupRuntimeRole();
    const injectedRole = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'esdms_injected'");
    if (injectedRole.rowCount > 0) {
      await pool.query("DROP ROLE esdms_injected");
    }
  }
});

test("missing runtime password fails closed before creating or granting the role", async (t) => {
  const databaseUrl = assertIsDisposableTestDatabase();
  if (!assertPsqlAvailable(t)) {
    return;
  }

  await cleanupRuntimeRole();
  const result = runProvisioning(databaseUrl);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /ESDMS_RUNTIME_PASSWORD is required/);
  await assertRuntimeRoleAbsentAndRlsIntact();
});

test("short runtime password fails closed before creating or granting the role", async (t) => {
  const databaseUrl = assertIsDisposableTestDatabase();
  if (!assertPsqlAvailable(t)) {
    return;
  }

  const shortPassword = "too-short";
  await cleanupRuntimeRole();
  const result = runProvisioning(databaseUrl, { runtimePassword: shortPassword });
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}\n${result.stderr}`, /at least 16 characters/);
  assertSecretAbsent(result, shortPassword);
  await assertRuntimeRoleAbsentAndRlsIntact();
});

test("unsafe existing runtime role fails closed without receiving database access", async (t) => {
  const databaseUrl = assertIsDisposableTestDatabase();
  if (!assertPsqlAvailable(t)) {
    return;
  }

  const replacementPassword = crypto.randomBytes(24).toString("base64url");
  await cleanupRuntimeRole();
  await pool.query("CREATE ROLE esdms_runtime LOGIN CREATEDB");

  try {
    const result = runProvisioning(databaseUrl, { runtimePassword: replacementPassword });
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /unsafe existing esdms_runtime role attributes/);
    assertSecretAbsent(result, replacementPassword);

    const role = await pool.query(
      "SELECT rolcreatedb, rolcreaterole, rolbypassrls FROM pg_roles WHERE rolname = 'esdms_runtime'",
    );
    assert.deepEqual(role.rows[0], { rolcreatedb: true, rolcreaterole: false, rolbypassrls: false });

    const directPrivileges = await pool.query(
      "SELECT 1 FROM information_schema.table_privileges WHERE grantee = 'esdms_runtime'",
    );
    assert.equal(directPrivileges.rowCount, 0);
    const policies = await pool.query(
      "SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND policyname = 'esdms_runtime_access'",
    );
    assert.equal(policies.rowCount, 0);
  } finally {
    await cleanupRuntimeRole();
  }
});

test("provisioning removes effective table, sequence, and default privileges from browser roles", async (t) => {
  const databaseUrl = assertIsDisposableTestDatabase();
  if (!assertPsqlAvailable(t)) {
    return;
  }

  const runtimePassword = crypto.randomBytes(24).toString("base64url");
  await cleanupRuntimeRole();
  await cleanupBrowserRoles();
  await pool.query(`DROP SEQUENCE IF EXISTS public.${TEST_SEQUENCE}`);

  try {
    for (const role of BROWSER_ROLES) {
      await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    }
    await pool.query(`CREATE SEQUENCE public.${TEST_SEQUENCE}`);

    for (const role of BROWSER_ROLES) {
      await pool.query(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO ${role}`);
      await pool.query(`GRANT ALL PRIVILEGES ON SEQUENCE public.${TEST_SEQUENCE} TO ${role}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES GRANT ALL PRIVILEGES ON TABLES TO ${role}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO ${role}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES GRANT ALL PRIVILEGES ON SEQUENCES TO ${role}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO ${role}`);
    }

    const result = runProvisioning(databaseUrl, {
      runtimePassword,
      echoOption: "--echo-queries",
    });
    assertProvisioningSucceeded(result, "browser-role boundary provisioning");
    assertSecretAbsent(result, runtimePassword);

    for (const role of BROWSER_ROLES) {
      const tablePrivileges = await pool.query(
        `SELECT 1
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('SELECT'), ('INSERT'), ('UPDATE'), ('DELETE'), ('TRUNCATE'), ('REFERENCES'), ('TRIGGER'))
           p(privilege_type)
         WHERE n.nspname = 'public'
           AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
           AND has_table_privilege($1, c.oid, p.privilege_type)`,
        [role],
      );
      assert.equal(tablePrivileges.rowCount, 0);

      const sequencePrivileges = await pool.query(
        `SELECT 1
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         CROSS JOIN (VALUES ('USAGE'), ('SELECT'), ('UPDATE')) p(privilege_type)
         WHERE n.nspname = 'public'
           AND c.relkind = 'S'
           AND has_sequence_privilege($1, c.oid, p.privilege_type)`,
        [role],
      );
      assert.equal(sequencePrivileges.rowCount, 0);

      const defaultPrivileges = await pool.query(
        `SELECT 1
         FROM pg_default_acl d
         LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
         CROSS JOIN LATERAL aclexplode(d.defaclacl) a
         JOIN pg_roles grantee ON grantee.oid = a.grantee
         WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
           AND (d.defaclnamespace = 0 OR n.nspname = 'public')
           AND d.defaclobjtype IN ('r', 'S')
           AND grantee.rolname = $1`,
        [role],
      );
      assert.equal(defaultPrivileges.rowCount, 0);
    }
  } finally {
    await cleanupRuntimeRole();
    await cleanupBrowserRoles();
    await pool.query(`DROP SEQUENCE IF EXISTS public.${TEST_SEQUENCE}`);
  }
});

test("function hardening and default-ACL verification are scoped to the migration owner", async (t) => {
  const databaseUrl = assertIsDisposableTestDatabase();
  if (!assertPsqlAvailable(t)) {
    return;
  }

  const runtimePassword = crypto.randomBytes(24).toString("base64url");
  await cleanupFunctionFixtures();
  await cleanupRuntimeRole();
  await cleanupOtherOwner();
  await cleanupBrowserRoles();

  try {
    for (const role of BROWSER_ROLES) {
      await pool.query(`CREATE ROLE ${role} NOLOGIN`);
    }
    await pool.query("CREATE ROLE esdms_runtime LOGIN");
    await pool.query(`CREATE ROLE ${TEST_OTHER_OWNER} NOLOGIN`);

    // Model the legacy defaults owned by the ESDMS migration role.
    await pool.query(
      "ALTER DEFAULT PRIVILEGES GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO esdms_runtime",
    );
    await pool.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO esdms_runtime",
    );
    await pool.query("ALTER DEFAULT PRIVILEGES GRANT USAGE, SELECT ON SEQUENCES TO esdms_runtime");
    await pool.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO esdms_runtime",
    );
    await pool.query("ALTER DEFAULT PRIVILEGES GRANT EXECUTE ON FUNCTIONS TO PUBLIC, anon, authenticated");
    await pool.query(
      "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT EXECUTE ON FUNCTIONS TO PUBLIC, anon, authenticated",
    );

    // Model unrelated Supabase-managed defaults owned by another object
    // creator. Provisioning must neither remove nor reject these entries.
    for (const role of BROWSER_ROLES) {
      await pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${TEST_OTHER_OWNER} IN SCHEMA public
         GRANT ALL PRIVILEGES ON TABLES TO ${role}`,
      );
      await pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${TEST_OTHER_OWNER} IN SCHEMA public
         GRANT ALL PRIVILEGES ON SEQUENCES TO ${role}`,
      );
      await pool.query(
        `ALTER DEFAULT PRIVILEGES FOR ROLE ${TEST_OTHER_OWNER} IN SCHEMA public
         GRANT EXECUTE ON FUNCTIONS TO ${role}`,
      );
    }

    await pool.query(`CREATE TABLE public.${TEST_TRIGGER_TABLE} (id integer PRIMARY KEY, touched boolean NOT NULL)`);
    await pool.query(
      `CREATE FUNCTION public.${TEST_TRIGGER_FUNCTION}()
       RETURNS trigger AS $function$
       BEGIN
         NEW.touched = true;
         RETURN NEW;
       END
       $function$ LANGUAGE plpgsql`,
    );
    await pool.query(
      `CREATE TRIGGER esdms_security_trigger
       BEFORE UPDATE ON public.${TEST_TRIGGER_TABLE}
       FOR EACH ROW EXECUTE FUNCTION public.${TEST_TRIGGER_FUNCTION}()`,
    );
    await pool.query(`INSERT INTO public.${TEST_TRIGGER_TABLE} (id, touched) VALUES (1, false)`);

    assert.deepEqual(await getFunctionExecution(TEST_TRIGGER_FUNCTION), {
      public_execute: true,
      anon_execute: true,
      authenticated_execute: true,
    });

    const result = runProvisioning(databaseUrl, {
      runtimePassword,
      echoOption: "--echo-queries",
    });
    assertProvisioningSucceeded(result, "function/default-ACL boundary provisioning");
    assertSecretAbsent(result, runtimePassword);

    assert.deepEqual(await getFunctionExecution(TEST_TRIGGER_FUNCTION), {
      public_execute: false,
      anon_execute: false,
      authenticated_execute: false,
    });

    const currentOwnerDefaults = await pool.query(
      `SELECT 1
       FROM pg_default_acl d
       LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
       CROSS JOIN LATERAL aclexplode(d.defaclacl) a
       LEFT JOIN pg_roles grantee ON grantee.oid = a.grantee
       WHERE d.defaclrole = (SELECT oid FROM pg_roles WHERE rolname = current_user)
         AND (d.defaclnamespace = 0 OR n.nspname = 'public')
         AND (
           (d.defaclobjtype IN ('r', 'S')
             AND grantee.rolname IN ('esdms_runtime', 'anon', 'authenticated'))
           OR
           (d.defaclobjtype = 'f' AND a.privilege_type = 'EXECUTE'
             AND (a.grantee = 0 OR grantee.rolname IN ('anon', 'authenticated')))
         )`,
    );
    assert.equal(currentOwnerDefaults.rowCount, 0);

    const otherOwnerDefaults = await pool.query(
      `SELECT array_agg(DISTINCT d.defaclobjtype::text ORDER BY d.defaclobjtype::text) AS object_types
       FROM pg_default_acl d
       JOIN pg_namespace n ON n.oid = d.defaclnamespace
       CROSS JOIN LATERAL aclexplode(d.defaclacl) a
       JOIN pg_roles owner_role ON owner_role.oid = d.defaclrole
       JOIN pg_roles grantee ON grantee.oid = a.grantee
       WHERE owner_role.rolname = $1
         AND n.nspname = 'public'
         AND grantee.rolname IN ('anon', 'authenticated')`,
      [TEST_OTHER_OWNER],
    );
    assert.deepEqual(otherOwnerDefaults.rows[0].object_types.sort(), ["S", "f", "r"].sort());

    await pool.query(
      `CREATE FUNCTION public.${TEST_FUTURE_FUNCTION}()
       RETURNS integer LANGUAGE sql AS 'SELECT 1'`,
    );
    assert.deepEqual(await getFunctionExecution(TEST_FUTURE_FUNCTION), {
      public_execute: false,
      anon_execute: false,
      authenticated_execute: false,
    });

    const runtimeFunctionPrivilege = await pool.query(
      `SELECT has_function_privilege(
         'esdms_runtime',
         'public.${TEST_TRIGGER_FUNCTION}()',
         'EXECUTE'
       ) AS can_execute`,
    );
    assert.equal(runtimeFunctionPrivilege.rows[0].can_execute, false);

    await pool.query(`GRANT SELECT, UPDATE ON public.${TEST_TRIGGER_TABLE} TO esdms_runtime`);
    const triggerUpdate = runSqlAsRuntime(
      databaseUrl,
      runtimePassword,
      `UPDATE public.${TEST_TRIGGER_TABLE} SET touched = false WHERE id = 1 RETURNING touched`,
    );
    assert.equal(triggerUpdate.status, 0, "runtime UPDATE must still execute its table trigger");
    assert.equal(triggerUpdate.stdout.trim(), "t");
  } finally {
    await pool.query("ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
    await pool.query("ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC");
    await cleanupFunctionFixtures();
    await cleanupRuntimeRole();
    await cleanupOtherOwner();
    await cleanupBrowserRoles();
  }
});
