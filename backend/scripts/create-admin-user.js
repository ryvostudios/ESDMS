#!/usr/bin/env node
// One-time/first-user bootstrap for a fresh deployment. There is no
// self-registration endpoint and no default admin account — this is the
// only way to create the first ADMIN, run server-side (Render Shell / a
// one-off job), never through the browser. See docs/SECURITY.md and
// docs/DECISIONS.md for why.
//
// Non-interactive: set ADMIN_EMAIL, ADMIN_FULL_NAME, ADMIN_PASSWORD (and
// optionally ADMIN_SITE_CODE, default "MAIN") as environment variables.
// Interactive: run with no env vars set and answer the prompts — the
// password is entered in plain sight, which is an accepted tradeoff for a
// one-time command run by an operator on their own trusted shell.
import "dotenv/config";
import readline from "node:readline/promises";
import argon2 from "argon2";
import { z } from "zod";
import pool from "../src/config/database.js";

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(2).max(150),
  password: z.string().min(12, "Password must be at least 12 characters."),
  siteCode: z.string().trim().toUpperCase().min(1),
});

async function collectInput() {
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_FULL_NAME && process.env.ADMIN_PASSWORD) {
    return {
      email: process.env.ADMIN_EMAIL,
      fullName: process.env.ADMIN_FULL_NAME,
      password: process.env.ADMIN_PASSWORD,
      siteCode: process.env.ADMIN_SITE_CODE || "MAIN",
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("E-Set Digital Management System — create the first admin user\n");

  const email = await rl.question("Email: ");
  const fullName = await rl.question("Full name: ");
  const siteCode = (await rl.question("Site code [MAIN]: ")) || "MAIN";
  const password = await rl.question("Password (min 12 characters): ");
  rl.close();

  return { email, fullName, password, siteCode };
}

async function main() {
  const parsed = inputSchema.safeParse(await collectInput());

  if (!parsed.success) {
    console.error("\n" + parsed.error.issues.map((issue) => `- ${issue.message}`).join("\n"));
    process.exitCode = 1;
    return;
  }

  const site = await pool.query("SELECT id FROM sites WHERE code = $1", [parsed.data.siteCode]);
  if (site.rows.length === 0) {
    console.error(`\nNo site with code "${parsed.data.siteCode}" exists. Create it via migration first.`);
    process.exitCode = 1;
    return;
  }

  const role = await pool.query("SELECT id FROM roles WHERE name = 'ADMIN'");
  if (role.rows.length === 0) {
    console.error('\nNo "ADMIN" role found. Run migrations first (npm run migrate:up / migrate:up:prod).');
    process.exitCode = 1;
    return;
  }

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [parsed.data.email]);
  if (existing.rows.length > 0) {
    console.error(`\nA user with email ${parsed.data.email} already exists. Aborted.`);
    process.exitCode = 1;
    return;
  }

  const passwordHash = await argon2.hash(parsed.data.password);

  const result = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role_id, site_id, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING id`,
    [parsed.data.email, passwordHash, parsed.data.fullName, role.rows[0].id, site.rows[0].id],
  );

  console.log(`\nAdmin user created: ${parsed.data.email} (id ${result.rows[0].id}).`);
}

main()
  .catch((error) => {
    console.error("\nFailed to create admin user:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
