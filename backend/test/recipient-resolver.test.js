import { test, after } from "node:test";
import assert from "node:assert/strict";
import pg from "pg";
import config from "../src/config/env.js";
import pool from "../src/config/database.js";
import { resolveEligibleRecipients } from "../src/shared/notifications/recipient-resolver.js";

after(async () => {
  await pool.end();
});

test("recipient resolution uses one authoritative set query and preserves active/scope/permission rules", async () => {
  let queries = 0;
  const executor = {
    async query() {
      queries += 1;
      return {
        rows: [
          { id: "eligible", is_active: true, role_is_active: true, site_is_active: true, role: "TEAM_LEAD", site_id: "site-a", department_id: "dept-a", permissions: ["receiving.confirm"] },
          { id: "denied", is_active: true, role_is_active: true, site_is_active: true, role: "TEAM_LEAD", site_id: "site-a", department_id: "dept-a", permissions: [] },
          { id: "inactive", is_active: false, role_is_active: true, site_is_active: true, role: "TEAM_LEAD", site_id: "site-a", department_id: "dept-a", permissions: ["receiving.confirm"] },
          { id: "foreign", is_active: true, role_is_active: true, site_is_active: true, role: "TEAM_LEAD", site_id: "site-b", department_id: "dept-a", permissions: ["receiving.confirm"] },
          { id: "ceo", is_active: true, role_is_active: true, site_is_active: true, role: "CEO", site_id: "site-b", department_id: null, permissions: ["receiving.confirm"] },
        ],
      };
    },
  };

  const recipients = await resolveEligibleRecipients({
    capabilityCode: "receiving.confirm",
    siteId: "site-a",
    departmentId: "dept-a",
    executor,
  });

  assert.deepEqual(recipients, ["eligible", "ceo"]);
  assert.equal(queries, 1);
});

test("pool-size plus one concurrent transaction-owned recipient queries complete without nested acquisition", async () => {
  const constrained = new pg.Pool({
    connectionString: config.databaseUrl,
    max: 2,
    connectionTimeoutMillis: 5_000,
  });

  async function operation() {
    const client = await constrained.connect();
    try {
      await client.query("BEGIN");
      await resolveEligibleRecipients({
        capabilityCode: "demand.view",
        siteId: "00000000-0000-0000-0000-000000000000",
        executor: client,
      });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  try {
    await Promise.all([operation(), operation(), operation()]);
  } finally {
    await constrained.end();
  }
});
