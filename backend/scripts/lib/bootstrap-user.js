// Shared terminal-bootstrap logic behind scripts/create-admin-user.js and
// scripts/create-ceo-user.js. Both are the only way to create their
// respective role's account — there is no self-registration endpoint and
// no default account for either. See docs/SECURITY.md §12 and
// docs/DECISIONS.md.
import readline from "node:readline/promises";
import argon2 from "argon2";
import { z } from "zod";
import pool from "../../src/config/database.js";

const inputSchema = z.object({
  email: z.string().trim().toLowerCase().email(),
  fullName: z.string().trim().min(2).max(150),
  password: z.string().min(12, "Password must be at least 12 characters."),
  siteCode: z.string().trim().toUpperCase().min(1),
});

// Named via fromCharCode rather than embedded directly in string literals —
// a literal control byte typed straight into source here is invisible and
// easy to corrupt with an editor/copy-paste pass (this bit before; see
// docs/DECISIONS.md, "Admin Bootstrap Script Hardened").
const CTRL_D = String.fromCharCode(4);
const CTRL_C = String.fromCharCode(3);
const DEL = String.fromCharCode(127);

// Reads one line from stdin without echoing it to the terminal, using only
// Node's own raw-mode stdin — no masking dependency. Falls back to a plain
// line read when stdin isn't a TTY (piped input has nothing to
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
        case CTRL_D:
          cleanup();
          process.stdout.write("\n");
          resolve(input);
          break;
        case CTRL_C:
          cleanup();
          process.stdout.write("\n");
          reject(new Error("Aborted."));
          break;
        case DEL:
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

async function collectInput({ envPrefix, promptTitle }) {
  const emailVar = `${envPrefix}_EMAIL`;
  const fullNameVar = `${envPrefix}_FULL_NAME`;
  const passwordVar = `${envPrefix}_PASSWORD`;
  const siteVar = `${envPrefix}_SITE_CODE`;

  if (process.env[emailVar] && process.env[fullNameVar]) {
    const password = process.env[passwordVar] || (await readHiddenLine("Password (min 12 characters): "));

    return {
      email: process.env[emailVar],
      fullName: process.env[fullNameVar],
      password,
      siteCode: process.env[siteVar] || "MAIN",
    };
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`${promptTitle}\n`);

  const email = await rl.question("Email: ");
  const fullName = await rl.question("Full name: ");
  const siteCode = (await rl.question("Site code [MAIN]: ")) || "MAIN";
  rl.close();

  const password = await readHiddenLine("Password (min 12 characters): ");

  return { email, fullName, password, siteCode };
}

// `onExistingActive(count)` (optional) fires before insertion when at least
// one active account of `roleName` already exists — used by the CEO script
// to print an explicit, non-blocking note (the schema deliberately allows
// more than one active CEO; see docs/DECISIONS.md) rather than silently
// creating a second one with no visible trace.
export async function bootstrapUser({ roleName, envPrefix, promptTitle, label, onExistingActive }) {
  const parsed = inputSchema.safeParse(await collectInput({ envPrefix, promptTitle }));

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

  const role = await pool.query("SELECT id, is_active FROM roles WHERE name = $1", [roleName]);
  if (role.rows.length === 0) {
    console.error(`\nNo "${roleName}" role found. Run migrations first (npm run migrate:up / migrate:up:prod).`);
    process.exitCode = 1;
    return;
  }
  if (!role.rows[0].is_active) {
    console.error(`\nThe "${roleName}" role exists but is deactivated. Aborted.`);
    process.exitCode = 1;
    return;
  }

  const existing = await pool.query("SELECT id FROM users WHERE email = $1", [parsed.data.email]);
  if (existing.rows.length > 0) {
    console.error(`\nA user with email ${parsed.data.email} already exists. Aborted.`);
    process.exitCode = 1;
    return;
  }

  if (onExistingActive) {
    const activeCount = await pool.query(
      `SELECT count(*)::int AS count FROM users u JOIN roles r ON r.id = u.role_id
       WHERE r.name = $1 AND u.is_active = true`,
      [roleName],
    );
    if (activeCount.rows[0].count > 0) {
      onExistingActive(activeCount.rows[0].count);
    }
  }

  const passwordHash = await argon2.hash(parsed.data.password);

  const result = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role_id, site_id, is_active)
     VALUES ($1, $2, $3, $4, $5, true)
     RETURNING id`,
    [parsed.data.email, passwordHash, parsed.data.fullName, role.rows[0].id, site.rows[0].id],
  );

  console.log(`\n${label} user created: ${parsed.data.email} (id ${result.rows[0].id}).`);
}
