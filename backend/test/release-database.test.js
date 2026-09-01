import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const migrationPassword = "migration-owner-secret-123456";
const runtimePassword = "runtime-secret-123456789";

function runRelease({
  migrationUrl = `postgresql://postgres:${migrationPassword}@127.0.0.1:9/esdms_test_release`,
  runtimeUrl = `postgresql://esdms_runtime:${runtimePassword}@127.0.0.1:9/esdms_test_release`,
  password = runtimePassword,
} = {}) {
  return spawnSync(process.execPath, ["scripts/release-database.js"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      MIGRATION_DATABASE_URL: migrationUrl,
      DATABASE_URL: runtimeUrl,
      ESDMS_RUNTIME_PASSWORD: password,
    },
  });
}

function assertRejectedWithoutSecrets(options, pattern) {
  const result = runRelease(options);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, pattern);
  for (const secret of [migrationPassword, runtimePassword]) {
    assert.doesNotMatch(result.stdout, new RegExp(secret));
    assert.doesNotMatch(result.stderr, new RegExp(secret));
  }
}

test("database release rejects conflated roles and mismatched credentials before connecting", () => {
  assertRejectedWithoutSecrets(
    { migrationUrl: `postgresql://esdms_runtime:${migrationPassword}@127.0.0.1:9/esdms_test_release` },
    /MIGRATION_DATABASE_URL must not use esdms_runtime/,
  );
  assertRejectedWithoutSecrets(
    { runtimeUrl: `postgresql://postgres:${runtimePassword}@127.0.0.1:9/esdms_test_release` },
    /DATABASE_URL must authenticate as esdms_runtime/,
  );
  assertRejectedWithoutSecrets({ password: "different-runtime-secret-123" }, /must match the password/);
  assertRejectedWithoutSecrets(
    {
      runtimeUrl: "postgresql://esdms_runtime:too-short@127.0.0.1:9/esdms_test_release",
      password: "too-short",
    },
    /must be at least 16 characters/,
  );
});

test("database release refuses different database targets before connecting", () => {
  assertRejectedWithoutSecrets(
    { runtimeUrl: `postgresql://esdms_runtime:${runtimePassword}@127.0.0.1:9/another_database` },
    /must target the same database endpoint/,
  );
  assertRejectedWithoutSecrets(
    { runtimeUrl: `postgresql://esdms_runtime:${runtimePassword}@localhost:9/esdms_test_release` },
    /must target the same database endpoint/,
  );
});
