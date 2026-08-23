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
//
// See scripts/create-ceo-user.js for the equivalent CEO bootstrap — both
// share scripts/lib/bootstrap-user.js.
import "dotenv/config";
import pool from "../src/config/database.js";
import { bootstrapUser } from "./lib/bootstrap-user.js";

bootstrapUser({
  roleName: "ADMIN",
  envPrefix: "ADMIN",
  promptTitle: "E-Set Digital Management System — create the first admin user",
  label: "Admin",
})
  .catch((error) => {
    console.error("\nFailed to create admin user:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
