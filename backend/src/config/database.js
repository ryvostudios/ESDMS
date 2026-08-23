import pg from "pg";
import config from "./env.js";

const { Pool } = pg;

const pool = new Pool({
  connectionString: config.databaseUrl,
  // Verified TLS in production (not merely encrypted-but-unverified) — see
  // docs/SECURITY.md §8.1. Local dev connects to a local, non-TLS Postgres.
  ssl: config.isProduction ? { rejectUnauthorized: true } : undefined,
  // ESDMS-012: every DATE-based business rule (document expiry, effective
  // dates, "today") is compared against Postgres's own CURRENT_DATE — but
  // without this, CURRENT_DATE follows whatever timezone the Postgres
  // server/session happens to default to (the OS's TZ, a managed
  // provider's default, etc.), independent of and able to silently
  // disagree with config.appTimezone — already the app's own authoritative
  // "today" for display and the ESDMS-006 future-dated-transfer check.
  // Two deployments of the identical schema/app could then classify the
  // same expiry_date differently depending only on the DB host's clock.
  // `options` is forwarded into the Postgres startup packet itself (like
  // `postgres -c ...`), so every session's timezone is pinned to the app's
  // own configured one atomically at connection time — before any query
  // can run on it, unlike a post-connect `SET TIME ZONE` (which would race
  // the first query). appTimezone is validated at startup against the IANA
  // database (see config/env.js's isValidTimezone) — never raw user input.
  options: `-c TimeZone=${config.appTimezone}`,
});

export async function checkDatabaseConnection() {
  const result = await pool.query("SELECT NOW() AS current_time");
  return result.rows[0];
}

export default pool;
