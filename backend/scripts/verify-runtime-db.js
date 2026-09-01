#!/usr/bin/env node
import "dotenv/config";
import pg from "pg";
import { inspectRuntimeCompatibility } from "../src/shared/db/runtime-compatibility.js";
import { inspectSchemaCompatibility } from "../src/shared/db/schema-compatibility.js";
import { USER_PROFILE_QUERY } from "../src/shared/users/user-profile.query.js";

// The single implementation of "can the runtime login actually serve?", used
// both as the last step of `npm run db:release` and on its own as
// `npm run db:verify-runtime`.
//
// It connects as the RUNTIME role, never the owner. Verifying as the owner
// would pass regardless of whether provisioning did anything, which is the
// whole defect this step exists to catch.
//
// Two independent inspections run, because they fail for different reasons:
//   inspectRuntimeCompatibility  the privilege boundary and provisioning stamp
//   inspectSchemaCompatibility   the migration level, the declared access
//                                contract, and the real authentication query
const { Pool } = pg;
const ZERO_UUID = "00000000-0000-0000-0000-000000000000";

function required(name) {
  const value = process.env[name];
  if (!value?.trim()) throw new Error(`${name} is required.`);
  return value;
}

function verifiedTls(databaseUrl) {
  const parsed = new URL(databaseUrl);
  return ["localhost", "127.0.0.1", "[::1]"].includes(parsed.hostname)
    ? undefined
    : { rejectUnauthorized: true };
}

async function main() {
  const databaseUrl = required("DATABASE_URL");
  const pool = new Pool({
    connectionString: databaseUrl,
    max: 2,
    connectionTimeoutMillis: 10_000,
    ssl: verifiedTls(databaseUrl),
  });

  try {
    const compatibility = await inspectRuntimeCompatibility(pool, { requireRuntimeRole: true });
    if (!compatibility.runtimeProvisioningCompatible) {
      const failed = Object.entries(compatibility.checks)
        .filter(([, passed]) => !passed)
        .map(([name]) => name);
      throw new Error(`Runtime database privilege/RLS verification failed: ${failed.join(", ")}.`);
    }

    const serving = await inspectSchemaCompatibility(pool);
    if (!serving.ready) {
      throw new Error(
        `The runtime database role cannot serve after provisioning:\n  - ${serving.problems.join("\n  - ")}`,
      );
    }

    // A zero UUID returns no private row but forces PostgreSQL to authorize and
    // plan the exact profile/effective-permissions query used by login and /me.
    await pool.query(USER_PROFILE_QUERY, [ZERO_UUID]);
    await pool.query("SELECT id FROM public.drivers WHERE false");
    await pool.query("SELECT id FROM public.vehicles WHERE false");

    process.stdout.write(`${JSON.stringify({
      runtimeProvisioningCompatible: true,
      runtimeProvisioningVersion: compatibility.actualRuntimeProvisioning,
      migrationLevel: serving.latestAppliedMigration,
      appliedMigrationCount: serving.appliedMigrationCount,
      profileResolverVerified: true,
      fleetReadsVerified: true,
    })}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
