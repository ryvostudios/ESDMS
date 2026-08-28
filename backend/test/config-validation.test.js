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
  API_PUBLIC_URL: "https://api.example.com",
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

const printConfigPath = path.resolve(import.meta.dirname, "./fixtures/print-config.mjs");

// Same as runWithEnv, but for scenarios that need to inspect the actual
// canonicalized config values on success, not just whether startup
// succeeded — env.js itself prints nothing.
function runWithEnvPrintingConfig(overrides) {
  const env = { ...BASE_VALID_PROD_ENV, ...overrides };
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete env[key];
  }

  const result = spawnSync(process.execPath, [printConfigPath], { env, encoding: "utf8" });
  return { ...result, config: result.status === 0 ? JSON.parse(result.stdout) : null };
}

test("a fully valid production config loads without error", () => {
  const result = runWithEnv({});
  assert.equal(result.status, 0, result.stderr);
});

test("database pool bounds and build revision are validated and exposed", () => {
  const valid = runWithEnvPrintingConfig({
    DATABASE_POOL_MAX: "7",
    DATABASE_CONNECTION_TIMEOUT_MS: "1250",
    BUILD_REVISION: "abc123-release.4",
  });
  assert.equal(valid.status, 0, valid.stderr);
  assert.equal(valid.config.databasePoolMax, 7);
  assert.equal(valid.config.databaseConnectionTimeoutMs, 1250);
  assert.equal(valid.config.buildRevision, "abc123-release.4");

  assert.notEqual(runWithEnv({ DATABASE_POOL_MAX: "0" }).status, 0);
  assert.notEqual(runWithEnv({ DATABASE_CONNECTION_TIMEOUT_MS: "forever" }).status, 0);
  assert.notEqual(runWithEnv({ BUILD_REVISION: "unsafe revision/value" }).status, 0);
});

test("production refuses to start with an http:// FRONTEND_ORIGIN", () => {
  const result = runWithEnv({ FRONTEND_ORIGIN: "http://app.example.com" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FRONTEND_ORIGIN.*https/);
});

test("a clean https FRONTEND_ORIGIN is accepted, with or without a trailing slash", () => {
  for (const value of ["https://app.example.com", "https://app.example.com/"]) {
    const result = runWithEnv({ FRONTEND_ORIGIN: value });
    assert.equal(result.status, 0, `FRONTEND_ORIGIN=${value} should be accepted: ${result.stderr}`);
  }
});

test("a trailing-slash FRONTEND_ORIGIN canonicalizes to the exact same value as one without", () => {
  const withSlash = runWithEnvPrintingConfig({ FRONTEND_ORIGIN: "https://app.example.com/" });
  const withoutSlash = runWithEnvPrintingConfig({ FRONTEND_ORIGIN: "https://app.example.com" });

  assert.equal(withSlash.status, 0, withSlash.stderr);
  assert.equal(withoutSlash.status, 0, withoutSlash.stderr);
  assert.deepEqual(withSlash.config.frontendOrigins, ["https://app.example.com"]);
  assert.deepEqual(withSlash.config.frontendOrigins, withoutSlash.config.frontendOrigins);

  // The actual claim this exists to prove: a real browser's CORS Origin
  // header (always bare, no trailing slash) will match the configured
  // value regardless of which form the operator typed into
  // FRONTEND_ORIGIN — see app.js's `frontendOrigins.includes(origin)`.
  const browserOriginHeader = "https://app.example.com";
  assert.ok(withSlash.config.frontendOrigins.includes(browserOriginHeader));
});

test("a trailing-slash APP_PUBLIC_URL and API_PUBLIC_URL both canonicalize to a bare origin", () => {
  const result = runWithEnvPrintingConfig({
    APP_PUBLIC_URL: "https://app.example.com/",
    API_PUBLIC_URL: "https://api.example.com/",
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.config.appPublicUrl, "https://app.example.com");
  assert.equal(result.config.apiPublicUrl, "https://api.example.com");
});

test("end-to-end: a trailing-slash FRONTEND_ORIGIN still lets CORS match a real browser Origin header (no trailing slash)", () => {
  const corsFixturePath = path.resolve(import.meta.dirname, "./fixtures/cors-origin-check.mjs");

  const result = spawnSync(process.execPath, [corsFixturePath], {
    env: {
      PATH: process.env.PATH,
      DOTENV_CONFIG_PATH: path.resolve(import.meta.dirname, "./fixtures/nonexistent.env"),
      NODE_ENV: "development",
      DATABASE_URL: "postgresql://localhost:5432/eset_test",
      JWT_SECRET: "a".repeat(32),
      // Configured WITH a trailing slash — canonicalization must still
      // make this match a real browser's Origin header, which never has
      // one.
      FRONTEND_ORIGIN: "https://app.example.com/",
      TEST_REQUEST_ORIGIN: "https://app.example.com",
    },
    encoding: "utf8",
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(result.stdout, /PASS/);
});

test("a trailing-slash APP_PUBLIC_URL never produces a doubled separator when a path is joined onto it", () => {
  // Exercises the exact mechanism gate-pass.service.js uses to build the
  // QR verification URL: URL-aware joining against the (already
  // canonical) config value.
  const result = runWithEnvPrintingConfig({ APP_PUBLIC_URL: "https://app.example.com/" });
  assert.equal(result.status, 0, result.stderr);

  const joined = new URL("/guard/verify", result.config.appPublicUrl).toString();
  assert.equal(joined, "https://app.example.com/guard/verify");
  assert.ok(!joined.includes("//guard"), `expected no doubled separator, got "${joined}"`);
});

test("a FRONTEND_ORIGIN with a path is rejected — a browser's Origin header never carries one", () => {
  const result = runWithEnv({ FRONTEND_ORIGIN: "https://app.example.com/path" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FRONTEND_ORIGIN.*no path, query, fragment/);
});

test("a FRONTEND_ORIGIN with a query string is rejected", () => {
  const result = runWithEnv({ FRONTEND_ORIGIN: "https://app.example.com?x=1" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FRONTEND_ORIGIN.*no path, query, fragment/);
});

test("a FRONTEND_ORIGIN with a fragment is rejected", () => {
  const result = runWithEnv({ FRONTEND_ORIGIN: "https://app.example.com#section" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FRONTEND_ORIGIN.*no path, query, fragment/);
});

test("a FRONTEND_ORIGIN with embedded credentials is rejected", () => {
  const result = runWithEnv({ FRONTEND_ORIGIN: "https://user:pass@app.example.com" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /FRONTEND_ORIGIN.*no path, query, fragment/);
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

test("TRUST_PROXY_HOPS accepts 0, 1, and 2", () => {
  for (const value of ["0", "1", "2"]) {
    const result = runWithEnv({ TRUST_PROXY_HOPS: value });
    assert.equal(result.status, 0, `TRUST_PROXY_HOPS=${value} should be valid: ${result.stderr}`);
  }
});

test("TRUST_PROXY_HOPS rejects Infinity, abc, -1, 1.5, and 999999", () => {
  for (const value of ["Infinity", "abc", "-1", "1.5", "999999"]) {
    const result = runWithEnv({ TRUST_PROXY_HOPS: value });
    assert.notEqual(result.status, 0, `TRUST_PROXY_HOPS=${value} should be rejected`);
    assert.match(result.stderr, /TRUST_PROXY_HOPS must be an integer between 0 and 10/);
  }
});

test("an invalid PORT is rejected", () => {
  for (const value of ["0", "-1", "abc", "1.5", "70000", "Infinity"]) {
    const result = runWithEnv({ PORT: value });
    assert.notEqual(result.status, 0, `PORT=${value} should be rejected`);
    assert.match(result.stderr, /PORT must be an integer between 1 and 65535/);
  }
});

test("an unrecognized APP_TIMEZONE is rejected", () => {
  const result = runWithEnv({ APP_TIMEZONE: "Not/AZone" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /APP_TIMEZONE.*not a recognized IANA timezone/);
});

test("a real IANA APP_TIMEZONE is accepted", () => {
  const result = runWithEnv({ APP_TIMEZONE: "Asia/Karachi" });
  assert.equal(result.status, 0, result.stderr);
});

test("SUPABASE_STORAGE_TIMEOUT_MS rejects out-of-range or malformed values", () => {
  for (const value of ["999", "120001", "abc", "-1", "1.5", "Infinity"]) {
    const result = runWithEnv({ SUPABASE_STORAGE_TIMEOUT_MS: value });
    assert.notEqual(result.status, 0, `SUPABASE_STORAGE_TIMEOUT_MS=${value} should be rejected`);
    assert.match(result.stderr, /SUPABASE_STORAGE_TIMEOUT_MS must be an integer between 1000 and 120000/);
  }
});

test("SUPABASE_STORAGE_TIMEOUT_MS accepts a value within range", () => {
  const result = runWithEnv({ SUPABASE_STORAGE_TIMEOUT_MS: "15000" });
  assert.equal(result.status, 0, result.stderr);
});

test("production refuses to start without API_PUBLIC_URL", () => {
  const result = runWithEnv({ API_PUBLIC_URL: undefined });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /API_PUBLIC_URL must be set in production/);
});

test("production refuses to start with an http:// API_PUBLIC_URL", () => {
  const result = runWithEnv({ API_PUBLIC_URL: "http://api.example.com" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /API_PUBLIC_URL.*https/);
});

test("production refuses a loopback HOST", () => {
  for (const value of ["127.0.0.1", "localhost", "::1"]) {
    const result = runWithEnv({ HOST: value });
    assert.notEqual(result.status, 0, `HOST=${value} should be rejected`);
    assert.match(result.stderr, /HOST ".*" is a loopback address/);
  }
});

test("production accepts an explicit HOST=0.0.0.0", () => {
  const result = runWithEnv({ HOST: "0.0.0.0" });
  assert.equal(result.status, 0, result.stderr);
});

test("known unsafe separate Render domains (different *.onrender.com subdomains) are rejected", () => {
  const result = runWithEnv({
    FRONTEND_ORIGIN: "https://esdms-frontend.onrender.com",
    APP_PUBLIC_URL: "https://esdms-frontend.onrender.com",
    API_PUBLIC_URL: "https://esdms-api.onrender.com",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /are not same-site/);
});

test("a same-site custom-domain topology (app.<domain> / api.<domain>) is accepted", () => {
  const result = runWithEnv({
    FRONTEND_ORIGIN: "https://app.eset.example",
    APP_PUBLIC_URL: "https://app.eset.example",
    API_PUBLIC_URL: "https://api.eset.example",
  });
  assert.equal(result.status, 0, result.stderr);
});

test("independent vercel.app hosts are rejected the same way as onrender.com", () => {
  const result = runWithEnv({
    FRONTEND_ORIGIN: "https://esdms-frontend.vercel.app",
    APP_PUBLIC_URL: "https://esdms-frontend.vercel.app",
    API_PUBLIC_URL: "https://esdms-api.vercel.app",
  });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /are not same-site/);
});

// A naive "last two labels" registrable-domain heuristic gets this pair
// backwards: it would treat these as the same site ("com.pk") when they
// are two different customers' domains. PSL-aware resolution must not.
test("same-site validation is public-suffix-aware, not a naive last-two-labels heuristic: multi-label suffix (.com.pk) same-customer accepted, different-customer rejected", () => {
  const sameCustomer = runWithEnv({
    FRONTEND_ORIGIN: "https://app.company.com.pk",
    APP_PUBLIC_URL: "https://app.company.com.pk",
    API_PUBLIC_URL: "https://api.company.com.pk",
  });
  assert.equal(sameCustomer.status, 0, sameCustomer.stderr);

  const differentCustomers = runWithEnv({
    FRONTEND_ORIGIN: "https://app.customer-a.com.pk",
    APP_PUBLIC_URL: "https://app.customer-a.com.pk",
    API_PUBLIC_URL: "https://api.customer-b.com.pk",
  });
  assert.notEqual(differentCustomers.status, 0);
  assert.match(differentCustomers.stderr, /are not same-site/);
});

test("SUPABASE_URL with embedded credentials is rejected", () => {
  const result = runWithEnv({ SUPABASE_URL: "https://user:pass@project.supabase.co" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SUPABASE_URL must not embed credentials/);
});

test("a malformed SUPABASE_URL is rejected", () => {
  const result = runWithEnv({ SUPABASE_URL: "not-a-url" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SUPABASE_URL ".*" is not a valid URL/);
});

test("an http:// SUPABASE_URL is rejected in production", () => {
  const result = runWithEnv({ SUPABASE_URL: "http://project.supabase.co" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /SUPABASE_URL ".*" must be an https:\/\/ URL/);
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
