import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import {
  EXPECTED_RUNTIME_PROVISIONING,
  inspectRuntimeCompatibility,
} from "../src/shared/db/runtime-compatibility.js";

const healthyBoundary = {
  active_database_role: "esdms_runtime",
  runtime_role_exists: true,
  runtime_role_attributes_safe: true,
  runtime_role_has_no_memberships: true,
  runtime_schema_boundary_valid: true,
  critical_table_privileges_valid: true,
  pgmigrations_boundary_valid: true,
  runtime_rls_boundary_valid: true,
  runtime_owns_no_database_objects: true,
  runtime_sequence_boundary_valid: true,
  runtime_function_boundary_valid: true,
  provisioning_marker_present: true,
};

function executorWith(overrides = {}, marker = EXPECTED_RUNTIME_PROVISIONING) {
  return {
    async query(sql) {
      if (sql.includes("esdms_runtime_provisioning_version() AS provisioning_version")) {
        return { rows: [{ provisioning_version: marker }] };
      }
      return { rows: [{ ...healthyBoundary, ...overrides }] };
    },
  };
}

test("runtime compatibility requires the active production connection to be esdms_runtime", async () => {
  assert.equal(
    (await inspectRuntimeCompatibility(executorWith(), { requireRuntimeRole: true })).runtimeProvisioningCompatible,
    true,
  );
  assert.equal(
    (await inspectRuntimeCompatibility(
      executorWith({ active_database_role: "postgres" }),
      { requireRuntimeRole: true },
    )).runtimeProvisioningCompatible,
    false,
  );
});

test("every runtime role/grant/RLS/ownership invariant is fail-closed", async () => {
  for (const field of [
    "runtime_role_exists",
    "runtime_role_attributes_safe",
    "runtime_role_has_no_memberships",
    "runtime_schema_boundary_valid",
    "critical_table_privileges_valid",
    "pgmigrations_boundary_valid",
    "runtime_rls_boundary_valid",
    "runtime_owns_no_database_objects",
    "runtime_sequence_boundary_valid",
    "runtime_function_boundary_valid",
  ]) {
    const result = await inspectRuntimeCompatibility(executorWith({ [field]: false }));
    assert.equal(result.runtimeProvisioningCompatible, false, `${field} must be required`);
  }
});

test("missing, uncallable, or stale provisioning markers fail readiness", async () => {
  assert.equal(
    (await inspectRuntimeCompatibility(executorWith({ provisioning_marker_present: false })))
      .runtimeProvisioningCompatible,
    false,
  );
  assert.equal(
    (await inspectRuntimeCompatibility(executorWith({}, "older-migration"))).runtimeProvisioningCompatible,
    false,
  );

  const deniedExecutor = executorWith();
  deniedExecutor.query = async (sql) => {
    if (sql.includes("AS provisioning_version")) throw Object.assign(new Error("denied"), { code: "42501" });
    return { rows: [healthyBoundary] };
  };
  assert.equal((await inspectRuntimeCompatibility(deniedExecutor)).runtimeProvisioningCompatible, false);
});

test("provisioning marker is pinned to the latest authoritative migration", async () => {
  const script = await fs.readFile(
    path.resolve(import.meta.dirname, "../scripts/provision-db-roles.sql"),
    "utf8",
  );
  const migrationNames = (await fs.readdir(path.resolve(import.meta.dirname, "../migrations")))
    .filter((name) => name.endsWith(".js"))
    .map((name) => name.replace(/\.js$/, ""))
    .sort();

  // The constant the application compares against must still name the newest
  // migration on disk. That half is unchanged.
  assert.equal(EXPECTED_RUNTIME_PROVISIONING, migrationNames.at(-1));

  // The stamp itself is DERIVED from the migration ledger at provisioning time
  // rather than written into this file as a literal. A hard-coded name has to
  // be hand-edited after every migration, and a forgotten edit makes the marker
  // claim a level that was never provisioned -- the exact drift this marker
  // exists to detect. Deriving it means a level that was never migrated to
  // cannot be stamped at all.
  assert.match(script, /ARRAY_AGG\(m\.name ORDER BY m\.id DESC\)\)\[1\][\s\S]*?FROM public\.pgmigrations/);
  assert.match(script, /CREATE OR REPLACE FUNCTION public\.esdms_runtime_provisioning_version/);

  // ...and the provisioning run verifies its own stamp against that same
  // ledger before reporting success.
  assert.match(
    script,
    /esdms_runtime_provisioning_version\(\)\s*\n?\s*=\s*\(SELECT \(ARRAY_AGG/,
  );

  // No migration name may be baked into the script as a literal, which would
  // reintroduce the drift the derivation removes.
  const hardcodedMigrationLiteral = script.match(/'(\d{13}_[a-z0-9-]+)'/i);
  assert.equal(
    hardcodedMigrationLiteral,
    null,
    `provision-db-roles.sql hard-codes migration ${hardcodedMigrationLiteral?.[1]}; derive it instead.`,
  );
});
