#!/usr/bin/env node
// One-time/first-user bootstrap for a fresh deployment. There is no
// self-registration endpoint and no default admin account — this is the
// only way to create the first ADMIN, run server-side (Render Shell / a
// one-off job), never through the browser. See docs/SECURITY.md and
// docs/DECISIONS.md for why.
//
// SECURE PRODUCTION BOOTSTRAP PROCEDURE (see docs/SECURITY.md §12 for the
// full write-up):
//   1. Run migrations first (ADMIN role / site rows must already exist).
//   2. Set ADMIN_EMAIL, ADMIN_FULL_NAME, and (optionally) ADMIN_SITE_CODE
//      as environment variables through your platform's own env var
//      injection (e.g. a Render one-off Job's "Environment" tab) — never
//      typed inline on a command line, where they'd land in shell history.
//   3. Pipe ADMIN_PASSWORD in via stdin instead of an env var, so the
//      secret itself never appears in `ps`, shell history, or a process
//      env dump:
//        printf '%s' "$SECRET_PASSWORD" | node scripts/create-admin-user.js
//      (or set ADMIN_PASSWORD as an env var if your platform's env var
//      injection is itself already secret-safe — e.g. Render's — rather
//      than typed on a command line).
//
// Interactive mode (no relevant env vars set): prompts for each field:
// email/name/site are visible; the password is read with terminal echo
// suppressed (raw-mode stdin, no dependency) when run in a real terminal,
// and read as a plain piped line when stdin isn't a TTY.
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

// Reads one line from stdin without echoing it to the terminal, using
// only Node's own raw-mode stdin — no masking dependency. Falls back to a
// plain line read when stdin isn't a TTY (piped input has nothing to
// echo/suppress in the first place).
function readHiddenLine(promptText) {
  return new Promise((resolve, reject) => {
    process.stdout.write(promptText);
    const { stdin } = process;

    if (!stdin.isTTY) {
      const rl = readline.createInterface({ input: stdin, terminal: false });
      rl.once("line", (line) => {
        rl.close();
        resolve(line);
      });
      return;
    }

    const wasRaw = stdin.isRaw;
    let input = "";

    function cleanup() {
      stdin.setRawMode(wasRaw);
      stdin.pause();
      stdin.removeListener("data", onData);
    }

    function onData(char) {
      switch (char) {
        case "\n":
        case "\r":
        case "\u0004": // Ctrl-D
          cleanup();
          process.stdout.write("\n");
          resolve(input);
          break;
        case "\u0003": // Ctrl-C
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Aborted."));
          break;
        case "\u007f": // Backspace (most terminals)
        case "\b":
          input = input.slice(0, -1);
          break;
        default:
          input += char;
      }
    }

    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf8");
    stdin.on("data", onData);
  });
}

async function collectInput() {
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_FULL_NAME) {
    const password = process.env.ADMIN_PASSWORD || (await readHiddenLine("Password (min 12 characters): "));

    return {
      email: process.env.ADMIN_EMAIL,
      fullName: process.env.ADMIN_FULL_NAME,
      password,
      siteCode: process.env.ADMIN_SITE_CODE || "MAIN",
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log("E-Set Digital Management System — create the first admin user\n");

  const email = await rl.question("Email: ");
  const fullName = await rl.question("Full name: ");
  const siteCode = (await rl.question("Site code [MAIN]: ")) || "MAIN";
  rl.close();

  const password = await readHiddenLine("Password (min 12 characters): ");

  return { email, fullName, password, siteCode };
}

async function main() {
  const parsed = inputSchema.safeParse(await collectInput());

  if (!parsed.success) {
    console.error("\n" + parsed.error.issues.map((issue) => `- ${issue.message}`).join("\n"));
    process.exitCode = 1;
    return;
  }

  const site = await pool.query("SELECT id, is_active FROM sites WHERE code = $1", [parsed.data.siteCode]);
  if (site.rows.length === 0) {
    console.error(`\nNo site with code "${parsed.data.siteCode}" exists. Create it via migration first.`);
    process.exitCode = 1;
    return;
  }
  if (!site.rows[0].is_active) {
    console.error(`\nSite "${parsed.data.siteCode}" exists but is deactivated. Aborted.`);
    process.exitCode = 1;
    return;
  }

  const role = await pool.query("SELECT id, is_active FROM roles WHERE name = 'ADMIN'");
  if (role.rows.length === 0) {
    console.error('\nNo "ADMIN" role found. Run migrations first (npm run migrate:up / migrate:up:prod).');
    process.exitCode = 1;
    return;
  }
  if (!role.rows[0].is_active) {
    console.error('\nThe "ADMIN" role exists but is deactivated. Aborted.');
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
