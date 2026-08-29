#!/usr/bin/env node
import "dotenv/config";
import { spawn } from "node:child_process";
import path from "node:path";

const backendRoot = path.resolve(import.meta.dirname, "..");

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
  return secrets.reduce((safe, secret) => secret ? safe.split(secret).join("[redacted]") : safe, text);
}

function run(command, args, env, secrets) {
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
      else reject(new Error(`${path.basename(command)} failed (${signal || code}).`));
    });
  });
}

async function main() {
  const migrationDatabaseUrl = required("MIGRATION_DATABASE_URL");
  const runtimeDatabaseUrl = required("DATABASE_URL");
  const runtimePassword = required("ESDMS_RUNTIME_PASSWORD");
  const migrationUrl = parseDatabaseUrl("MIGRATION_DATABASE_URL", migrationDatabaseUrl);
  const runtimeUrl = parseDatabaseUrl("DATABASE_URL", runtimeDatabaseUrl);

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

  process.stdout.write("Database release: applying migrations.\n");
  await run(
    process.execPath,
    ["node_modules/node-pg-migrate/bin/node-pg-migrate", "up", "-d", "MIGRATION_DATABASE_URL"],
    process.env,
    secrets,
  );

  process.stdout.write("Database release: provisioning least-privilege runtime role.\n");
  await run(
    "psql",
    ["--no-psqlrc", "--file", path.join(backendRoot, "scripts/provision-db-roles.sql")],
    psqlEnvironment(migrationUrl, runtimePassword),
    secrets,
  );

  process.stdout.write("Database release: verifying runtime serving contract.\n");
  await run(
    process.execPath,
    [path.join(backendRoot, "scripts/verify-runtime-db.js")],
    { ...process.env, DATABASE_URL: runtimeDatabaseUrl },
    secrets,
  );
  process.stdout.write("Database release complete.\n");
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
