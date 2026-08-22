import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";

// env.js validates at module-load time (top-level code) — once loaded,
// re-importing with different env vars in the same process wouldn't
// re-run it (ES module cache). A fresh child process per scenario is the
// only way to actually exercise "does the server refuse to start".
const envPath = path.resolve(import.meta.dirname, "../src/config/env.js");

const BASE_VALID_PROD_ENV = {
  // Without this, dotenv/config (imported at the top of env.js) would
  // silently fill in whatever's in the real backend/.env for any var this
  // test doesn't explicitly set — defeating tests that need a var to be
  // genuinely absent, since dotenv only fills gaps, never overrides.
  DOTENV_CONFIG_PATH: path.resolve(import.meta.dirname, "./fixtures/nonexistent.env"),
  NODE_ENV: "production",
  DATABASE_URL: "postgresql://user:pass@db.example.com:5432/prod",
  JWT_SECRET: "a".repeat(32),
  FRONTEND_ORIGIN: "https://app.example.com",
  APP_PUBLIC_URL: "https://app.example.com",
  TRUST_PROXY_HOPS: "1",
  STORAGE_PROVIDER: "supabase",
  SUPABASE_URL: "https://project.supabase.co",
  SUPABASE_SERVICE_ROLE_KEY: "test-key",
  SUPABASE_STORAGE_BUCKET: "gate-pass-evidence",
  PATH: process.env.PATH,
};

function runWithEnv(overrides) {
  const env = { ...BASE_VALID_PROD_ENV, ...overrides };
  // Unset any key explicitly overridden to undefined.
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }

  return spawnSync(process.execPath, [envPath], { env, encoding: "utf8" });
}

test("a fully valid production config loads without error", () => {
  const result = runWithEnv({});
  assert.equal(result.status, 0, result.stderr);
});

test("production refuses to start with an http:// FRONTEND_ORIGIN", () => {
  const result = runWithEnv({ FRONTEND_ORIGIN: "http://app.example.com" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FRONTEND_ORIGIN.*https/);
});

test("production refuses to start with an http:// APP_PUBLIC_URL", () => {
  const result = runWithEnv({ APP_PUBLIC_URL: "http://app.example.com" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APP_PUBLIC_URL.*https/);
});

test("production refuses to start with STORAGE_PROVIDER=local", () => {
  const result = runWithEnv({ STORAGE_PROVIDER: "local" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /STORAGE_PROVIDER=local/);
});

test("production refuses to start with STORAGE_PROVIDER=supabase but missing Supabase credentials", () => {
  const result = runWithEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SUPABASE_SERVICE_ROLE_KEY is required/);
});

test("production refuses to start without an explicit TRUST_PROXY_HOPS", () => {
  const result = runWithEnv({ TRUST_PROXY_HOPS: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /TRUST_PROXY_HOPS must be set explicitly/);
});

test("development does not require any of the production-only settings", () => {
  const result = spawnSync(
    process.execPath,
    [envPath],
    {
      env: {
        DOTENV_CONFIG_PATH: path.resolve(import.meta.dirname, "./fixtures/nonexistent.env"),
        NODE_ENV: "development",
        DATABASE_URL: "postgresql://localhost:5432/eset_dev",
        JWT_SECRET: "a".repeat(32),
        FRONTEND_ORIGIN: "http://localhost:5173",
        PATH: process.env.PATH,
      },
      encoding: "utf8",
    },
  );

  assert.equal(result.status, 0, result.stderr);
});
