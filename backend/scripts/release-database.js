#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "node:child_process";
import pg from "pg";
import { fileURLToPath } from "node:url";
import path from "node:path";

// The database half of a release, as one idempotent command.
//
// Schema migration and runtime privilege provisioning are two separate
// privileged steps, and running only the first is exactly how a deployment
// reaches "every object present, every query denied": a migration adds a
// table, provision-db-roles.sql is not re-run, the new table has no runtime
// GRANT and no RLS policy, and the API serves 500s. Nothing in the codebase
// forced the second step to happen, and readiness could not see that it had
// not. Both are now one command that also verifies its own result.
//
// Deliberately NOT run from src/server.js at startup: the API process must
// never hold migration-capable credentials. This runs on an operator machine
// or a CI/release job, which is the only place MIGRATION_DATABASE_URL and
// ESDMS_RUNTIME_PASSWORD should exist.
//
//   MIGRATION_DATABASE_URL=...  # schema owner — this script only
//   DATABASE_URL=...            # the restricted runtime login the API uses
//   ESDMS_RUNTIME_PASSWORD=...  # set/rotated on esdms_runtime
//   npm run db:release
//
// Every argument is validated BEFORE anything connects, and all subprocess
// output is redacted, so a mistyped or conflated credential fails loudly
// without ever reaching a database or a log.

const backendRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const provisioningScript = path.join(backendRoot, "scripts/provision-db-roles.sql");

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value;
}

function parseDatabaseUrl(name, raw) {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") throw new Error();
    return parsed;
  } catch {
    throw new Error(`${name} must be a valid PostgreSQL URL.`);
  }
}

// Managed providers hand out logins like "esdms_runtime.abcd1234"; the role
// identity is the part before the first dot.
function roleBaseName(username) {
  return decodeURIComponent(username).split(".", 1)[0];
}

function sameDatabaseEndpoint(left, right) {
  return left.hostname.toLowerCase() === right.hostname.toLowerCase()
    && (left.port || "5432") === (right.port || "5432")
    && decodeURIComponent(left.pathname) === decodeURIComponent(right.pathname);
}

function psqlEnvironment(adminUrl, runtimePassword) {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(adminUrl.hostname);
  return {
    ...process.env,
    PGHOST: adminUrl.hostname,
    PGPORT: adminUrl.port || "5432",
    PGDATABASE: decodeURIComponent(adminUrl.pathname.replace(/^\//, "")),
    PGUSER: decodeURIComponent(adminUrl.username),
    PGPASSWORD: decodeURIComponent(adminUrl.password),
    PGSSLMODE: local ? "disable" : "verify-full",
    ESDMS_RUNTIME_PASSWORD: runtimePassword,
  };
}

function redact(text, secrets) {
  return secrets.reduce((safe, secret) => (secret ? safe.split(secret).join("[redacted]") : safe), text);
}

function run(command, args, env, secrets, label) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: backendRoot, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const safeOut = redact(stdout, secrets);
      const safeError = redact(stderr, secrets);
      if (safeOut) process.stdout.write(safeOut);
      if (safeError) process.stderr.write(safeError);
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal || `exit ${code}`}).`));
    });
  });
}

// ONE application migration/release at a time in the shared E-Set database
// (docs/PLATFORM_GO_LIVE_RUNBOOK.md, "Platform migration lock"). ESDMS,
// Permit and Attendance migration tooling all take this same session-level
// advisory lock before any DDL; a second release fails fast instead of
// running DDL concurrently. The API never takes it.
export const PLATFORM_MIGRATION_LOCK_KEY = 1_163_085_140; // "ESET"

async function acquirePlatformLock(migrationDatabaseUrl) {
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(new URL(migrationDatabaseUrl).hostname);
  const client = new pg.Client({
    connectionString: migrationDatabaseUrl,
    connectionTimeoutMillis: 10_000,
    ssl: local ? undefined : { rejectUnauthorized: true },
  });
  await client.connect();
  const { rows } = await client.query("SELECT pg_try_advisory_lock($1) AS acquired", [PLATFORM_MIGRATION_LOCK_KEY]);
  if (!rows[0].acquired) {
    await client.end();
    throw new Error("Another E-Set platform migration or release holds the platform lock; wait for it to finish.");
  }
  return client;
}

function step(number, description) {
  process.stdout.write(`\n[${number}/3] ${description}\n`);
}

async function main() {
  const migrationDatabaseUrl = required("MIGRATION_DATABASE_URL");
  const runtimeDatabaseUrl = required("DATABASE_URL");
  const runtimePassword = required("ESDMS_RUNTIME_PASSWORD");
  const migrationUrl = parseDatabaseUrl("MIGRATION_DATABASE_URL", migrationDatabaseUrl);
  const runtimeUrl = parseDatabaseUrl("DATABASE_URL", runtimeDatabaseUrl);

  // Separation of the two identities is the invariant this whole script
  // exists to protect, so it is checked before anything connects.
  if (roleBaseName(migrationUrl.username) === "esdms_runtime") {
    throw new Error("MIGRATION_DATABASE_URL must not use esdms_runtime.");
  }
  if (roleBaseName(runtimeUrl.username) !== "esdms_runtime") {
    throw new Error("DATABASE_URL must authenticate as esdms_runtime.");
  }
  if (!sameDatabaseEndpoint(migrationUrl, runtimeUrl)) {
    throw new Error("MIGRATION_DATABASE_URL and DATABASE_URL must target the same database endpoint.");
  }
  if (decodeURIComponent(runtimeUrl.password) !== runtimePassword) {
    throw new Error("ESDMS_RUNTIME_PASSWORD must match the password in DATABASE_URL.");
  }
  if (runtimePassword.length < 16) {
    throw new Error("ESDMS_RUNTIME_PASSWORD must be at least 16 characters.");
  }

  const secrets = [
    migrationDatabaseUrl,
    runtimeDatabaseUrl,
    runtimePassword,
    decodeURIComponent(migrationUrl.password),
    decodeURIComponent(runtimeUrl.password),
  ];

  const platformLock = await acquirePlatformLock(migrationDatabaseUrl);
  try {
    await releaseSteps(migrationDatabaseUrl, runtimeDatabaseUrl, runtimePassword, migrationUrl, secrets);
  } finally {
    await platformLock.end();
  }
}

async function releaseSteps(migrationDatabaseUrl, runtimeDatabaseUrl, runtimePassword, migrationUrl, secrets) {
  step(1, "Applying schema migrations as the migration owner");
  await run(
    process.execPath,
    ["node_modules/node-pg-migrate/bin/node-pg-migrate", "up", "-d", "MIGRATION_DATABASE_URL"],
    process.env,
    secrets,
    "node-pg-migrate up",
  );

  step(2, "Provisioning runtime database privileges and row policies");
  // --no-psqlrc is part of the secret-handling boundary: a user's .psqlrc is
  // executed before the script and could otherwise inspect the environment.
  await run(
    "psql",
    ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--file", provisioningScript],
    psqlEnvironment(migrationUrl, runtimePassword),
    secrets,
    "provision-db-roles.sql",
  );

  step(3, "Verifying the runtime login can actually serve");
  await run(
    process.execPath,
    [path.join(backendRoot, "scripts/verify-runtime-db.js")],
    { ...process.env, DATABASE_URL: runtimeDatabaseUrl },
    secrets,
    "verify-runtime-db.js",
  );

  process.stdout.write(
    "\nDatabase release complete.\n" +
      "Deploy the backend and frontend, then run the deployment smoke test — readiness\n" +
      "alone is not proof that a real user can sign in:\n" +
      "  ESDMS_SMOKE_EMAIL=... ESDMS_SMOKE_PASSWORD=... npm run verify:deployment -- https://api.example.com\n",
  );
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error) => {
    process.stderr.write(`\n${error.message}\n`);
    process.exitCode = 1;
  });
}
