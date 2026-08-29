#!/usr/bin/env node
import "dotenv/config";
import pg from "pg";
import { inspectRuntimeCompatibility } from "../src/shared/db/runtime-compatibility.js";
import { USER_PROFILE_QUERY } from "../src/shared/users/user-profile.query.js";

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
      throw new Error("Runtime database privilege/RLS verification failed.");
    }

    // A zero UUID returns no private row but forces PostgreSQL to authorize and
    // plan the exact profile/effective-permissions query used by login and /me.
    await pool.query(USER_PROFILE_QUERY, [ZERO_UUID]);
    await pool.query("SELECT id FROM public.drivers WHERE false");
    await pool.query("SELECT id FROM public.vehicles WHERE false");

    process.stdout.write(`${JSON.stringify({
      runtimeProvisioningCompatible: true,
      runtimeProvisioningVersion: compatibility.actualRuntimeProvisioning,
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
