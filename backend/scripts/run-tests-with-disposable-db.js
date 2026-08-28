import "dotenv/config";
import crypto from "node:crypto";
import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import pg from "pg";

const { Client } = pg;
const mode = process.env.ESDMS_TEST_DATABASE_MODE || "disposable";
const sourceUrl = process.env.TEST_DATABASE_ADMIN_URL || process.env.DATABASE_URL;

function parseSafeDatabaseUrl(raw) {
  const url = new URL(raw);
  const name = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(url.hostname)) {
    throw new Error("Refusing test database workflow: database host must be local.");
  }
  if (!/^(?:eset_test|esdms_test_[a-z0-9_]+)$/.test(name)) {
    throw new Error(`Refusing test database workflow: unsafe database name "${name}".`);
  }
  return { url, name };
}

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: process.cwd(), env, stdio: "inherit" });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} failed (${signal || code}).`));
    });
  });
}

async function testFiles() {
  const entries = await readdir(new URL("../test", import.meta.url));
  return entries.filter((name) => name.endsWith(".test.js")).sort().map((name) => `test/${name}`);
}

async function main() {
  if (!sourceUrl) throw new Error("DATABASE_URL or TEST_DATABASE_ADMIN_URL is required.");
  const source = parseSafeDatabaseUrl(sourceUrl);

  if (mode === "provided") {
    const args = process.argv.slice(2);
    await run(process.execPath, ["--test", "--test-concurrency=1", ...(args.length ? args : await testFiles())], {
      ...process.env,
      NODE_ENV: "test",
    });
    return;
  }
  if (mode !== "disposable") throw new Error(`Unknown ESDMS_TEST_DATABASE_MODE "${mode}".`);

  const databaseName = `esdms_test_${Date.now()}_${process.pid}_${crypto.randomBytes(4).toString("hex")}`;
  const adminUrl = new URL(source.url);
  // Connect to the known-safe existing test database to create its disposable sibling.
  const admin = new Client({ connectionString: adminUrl.toString() });
  const targetUrl = new URL(source.url);
  targetUrl.pathname = `/${databaseName}`;
  const childEnv = { ...process.env, NODE_ENV: "test", DATABASE_URL: targetUrl.toString() };

  await admin.connect();
  let created = false;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await run(process.execPath, ["node_modules/node-pg-migrate/bin/node-pg-migrate", "up"], childEnv);
    const args = process.argv.slice(2);
    await run(process.execPath, ["--test", "--test-concurrency=1", ...(args.length ? args : await testFiles())], childEnv);
  } finally {
    if (created) {
      await admin.query(`DROP DATABASE IF EXISTS "${databaseName}" WITH (FORCE)`);
    }
    await admin.end();
  }
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
