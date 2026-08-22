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
const BROWSER_ROLES = ["anon", "authenticated"];
const TEST_SEQUENCE = "esdms_security_test_sequence";
const scriptPath = path.resolve(import.meta.dirname, "../scripts/provision-db-roles.sql");
const migrationPath = path.resolve(
  import.meta.dirname,
  "../migrations/1787401000000_database-runtime-security-boundary.js",
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

async function cleanupRuntimeRole() {
  for (const table of APPLICATION_TABLES) {
    await pool.query(`DROP POLICY IF EXISTS esdms_runtime_access ON public.${table}`);
  }
  await pool.query("DROP POLICY IF EXISTS esdms_runtime_access ON public.pgmigrations");

  const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = 'esdms_runtime'");
  if (exists.rowCount > 0) {
    await pool.query("DROP OWNED BY esdms_runtime");
    await pool.query("DROP ROLE esdms_runtime");
  }
}

async function cleanupBrowserRoles() {
  for (const role of BROWSER_ROLES) {
    const exists = await pool.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role]);
    if (exists.rowCount > 0) {
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON TABLES FROM ${role}`);
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL PRIVILEGES ON SEQUENCES FROM ${role}`);
      await pool.query(`DROP OWNED BY ${role}`);
      await pool.query(`DROP ROLE ${role}`);
    }
  }
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
    [ALL_TABLES],
  );
  assert.equal(rls.rowCount, ALL_TABLES.length);
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
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA public FROM esdms_runtime/);
  assert.match(sql, /REVOKE ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public FROM esdms_runtime/);

  const explicitGrant = sql.match(/GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE([\s\S]*?)TO esdms_runtime;/i)?.[1];
  assert.ok(explicitGrant, "expected one explicit runtime table grant");
  for (const table of APPLICATION_TABLES) {
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
    assert.equal(directTablePrivileges.rowCount, APPLICATION_TABLES.length);
    assert.deepEqual(
      directTablePrivileges.rows.map((row) => row.table_name),
      [...APPLICATION_TABLES].sort(),
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
      [ALL_TABLES],
    );
    assert.equal(rls.rowCount, ALL_TABLES.length);
    assert.ok(rls.rows.every((row) => row.relrowsecurity));

    const policies = await pool.query(
      `SELECT tablename, permissive, roles::text[], cmd, qual, with_check
       FROM pg_policies
       WHERE schemaname = 'public' AND policyname = 'esdms_runtime_access'
       ORDER BY tablename`,
    );
    assert.equal(policies.rowCount, APPLICATION_TABLES.length);
    assert.deepEqual(
      policies.rows.map((row) => row.tablename),
      [...APPLICATION_TABLES].sort(),
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
       JOIN pg_namespace n ON n.oid = d.defaclnamespace
       CROSS JOIN LATERAL aclexplode(d.defaclacl) a
       JOIN pg_roles grantee ON grantee.oid = a.grantee
       WHERE n.nspname = 'public'
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
      await pool.query(`ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO ${role}`);
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
         JOIN pg_namespace n ON n.oid = d.defaclnamespace
         CROSS JOIN LATERAL aclexplode(d.defaclacl) a
         JOIN pg_roles grantee ON grantee.oid = a.grantee
         WHERE n.nspname = 'public'
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
