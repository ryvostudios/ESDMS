#!/usr/bin/env node
// Bootstrap for the CEO account — the highest application authority (see
// docs/DECISIONS.md, "Workforce Module Begun..."). There is no API path
// that can create a CEO account (src/modules/users/users.authorization.js
// excludes CEO from ASSIGNABLE_ROLES entirely); this script, run
// server-side, is the only way. Mirrors scripts/create-admin-user.js —
// both share scripts/lib/bootstrap-user.js. Do NOT run this against
// production without the same operational care documented in
// docs/SECURITY.md §12 for the admin bootstrap.
//
// Env vars: CEO_EMAIL, CEO_FULL_NAME, CEO_PASSWORD (or piped via stdin —
// preferred, see docs/SECURITY.md §12), CEO_SITE_CODE (default "MAIN").
//
// The schema deliberately allows more than one active CEO row (see
// docs/DECISIONS.md) — running this again with a different email while a
// CEO already exists is allowed, not blocked, and prints an explicit note
// rather than silently creating a second CEO with no visible trace.
// Running it again with the SAME email is still rejected (ordinary email
// uniqueness), exactly like the admin bootstrap.
import "dotenv/config";
import pool from "../src/config/database.js";
import { bootstrapUser } from "./lib/bootstrap-user.js";

bootstrapUser({
  roleName: "CEO",
  envPrefix: "CEO",
  promptTitle: "E-Set Digital Management System — create a CEO account",
  label: "CEO",
  onExistingActive: (count) => {
    console.log(`\nNote: ${count} active CEO account(s) already exist. Creating an additional one.`);
  },
})
  .catch((error) => {
    console.error("\nFailed to create CEO user:", error.message);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
