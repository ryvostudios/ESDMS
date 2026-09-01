import "dotenv/config";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";
import pg from "pg";
import { inspectSchemaCompatibility } from "../src/shared/db/schema-compatibility.js";

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

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const provisioningScript = path.join(scriptDir, "provision-db-roles.sql");

function run(command, args, { env, label }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: path.join(scriptDir, ".."), env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} failed (${signal || `exit ${code}`}).`));
    });
  });
}

function step(number, description) {
  process.stdout.write(`\n[${number}/3] ${description}\n`);
}

async function main() {
  const migrationUrl = process.env.MIGRATION_DATABASE_URL || process.env.DATABASE_URL;
  const runtimeUrl = process.env.DATABASE_URL;

  if (!migrationUrl) {
    throw new Error("MIGRATION_DATABASE_URL (or DATABASE_URL for local development) is required.");
  }
  if (!runtimeUrl) {
    throw new Error("DATABASE_URL is required — it is the runtime login this script verifies.");
  }
  if (!process.env.ESDMS_RUNTIME_PASSWORD) {
    throw new Error(
      "ESDMS_RUNTIME_PASSWORD is required. Read it without echoing it into shell history:\n" +
        "  read -rs ESDMS_RUNTIME_PASSWORD && export ESDMS_RUNTIME_PASSWORD",
    );
  }

  step(1, "Applying schema migrations as the migration owner");
  await run(process.execPath, ["node_modules/node-pg-migrate/bin/node-pg-migrate", "up"], {
    env: { ...process.env, DATABASE_URL: migrationUrl },
    label: "node-pg-migrate up",
  });

  step(2, "Provisioning runtime database privileges and row policies");
  // --no-psqlrc is part of the secret-handling boundary: a user's .psqlrc is
  // executed before the script and could otherwise inspect the environment.
  await run("psql", ["--no-psqlrc", "--set", "ON_ERROR_STOP=1", "--file", provisioningScript, migrationUrl], {
    env: process.env,
    label: "provision-db-roles.sql",
  });

  step(3, "Verifying the runtime login can actually serve");
  // Connects as the RUNTIME role, not the owner: verifying as the owner would
  // pass regardless of whether step 2 did anything, which is the whole defect
  // this step exists to catch.
  const client = new pg.Client({ connectionString: runtimeUrl });
  await client.connect();
  try {
    const result = await inspectSchemaCompatibility(client);
    if (!result.ready) {
      throw new Error(
        `The runtime database role cannot serve after provisioning:\n  - ${result.problems.join("\n  - ")}`,
      );
    }
    process.stdout.write(
      `      migration level ${result.appliedMigrationCount} (${result.latestAppliedMigration})\n` +
        "      runtime privileges, row policies and the authentication path all verified\n",
    );
  } finally {
    await client.end();
  }

  process.stdout.write(
    "\nDatabase release complete.\n" +
      "Deploy the backend and frontend, then run the deployment smoke test — readiness\n" +
      "alone is not proof that a real user can sign in:\n" +
      "  ESDMS_SMOKE_EMAIL=... ESDMS_SMOKE_PASSWORD=... npm run verify:deployment -- https://api.example.com\n",
  );
}

main().catch((error) => {
  process.stderr.write(`\n${error.message}\n`);
  process.exitCode = 1;
});
