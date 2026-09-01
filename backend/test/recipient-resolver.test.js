import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pg from "pg";
import config from "../src/config/env.js";
import pool from "../src/config/database.js";
import { resolveEligibleRecipients } from "../src/shared/notifications/recipient-resolver.js";
import { seedUsers } from "./setup.js";

// Recipient resolution used to load EVERY user profile — each with its full
// effective permission set — and filter them in JavaScript, inside the
// caller's write transaction while it held its row lock. The previous version
// of this file mocked the executor entirely and asserted the QUERY COUNT,
// which made an O(all-users) scan look like a virtue and could never have
// caught the 10x latency regression that shipped.
//
// These tests run against the real database and assert the RESULT plus the
// actual work done: rows examined, not statements issued.

let users;
const created = [];

async function makeUser({ email, role, siteId, departmentId = null, isActive = true }) {
  const argon2 = (await import("argon2")).default;
  const result = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role_id, site_id, department_id, is_active)
     VALUES ($1, $2, $3, (SELECT id FROM roles WHERE name = $4), $5, $6, $7)
     RETURNING id`,
    [email, await argon2.hash("Recipient-Test-123!"), email, role, siteId, departmentId, isActive],
  );
  created.push(result.rows[0].id);
  return result.rows[0].id;
}

async function grant(userId, code, effect = "GRANT") {
  await pool.query(
    `INSERT INTO user_permission_overrides (user_id, permission_id, effect, granted_by_user_id)
     SELECT $1, id, $3, $2 FROM permissions WHERE code = $4
     ON CONFLICT (user_id, permission_id) DO UPDATE SET effect = EXCLUDED.effect`,
    [userId, users.ceo, effect, code],
  );
}

before(async () => {
  users = await seedUsers();
});

after(async () => {
  if (created.length > 0) {
    await pool.query("DELETE FROM user_permission_overrides WHERE user_id = ANY($1)", [created]);
    await pool.query("DELETE FROM user_permission_bundle_assignments WHERE user_id = ANY($1)", [created]);
    await pool.query("DELETE FROM users WHERE id = ANY($1)", [created]);
  }
  await pool.end();
});

test("eligibility honours capability, active state, site and department scope", async () => {
  const tag = crypto.randomBytes(4).toString("hex");

  const eligible = await makeUser({
    email: `eligible-${tag}@test.eset.local`,
    role: "TEAM_LEAD",
    siteId: users.mainSite,
    departmentId: users.departmentA,
  });
  const wrongDepartment = await makeUser({
    email: `wrong-dept-${tag}@test.eset.local`,
    role: "TEAM_LEAD",
    siteId: users.mainSite,
    departmentId: users.departmentB,
  });
  const wrongSite = await makeUser({
    email: `wrong-site-${tag}@test.eset.local`,
    role: "TEAM_LEAD",
    siteId: users.otherSite,
    departmentId: users.otherSiteDepartment,
  });
  const inactive = await makeUser({
    email: `inactive-${tag}@test.eset.local`,
    role: "TEAM_LEAD",
    siteId: users.mainSite,
    departmentId: users.departmentA,
    isActive: false,
  });
  const denied = await makeUser({
    email: `denied-${tag}@test.eset.local`,
    role: "TEAM_LEAD",
    siteId: users.mainSite,
    departmentId: users.departmentA,
  });
  await grant(denied, "receiving.confirm", "DENY");

  const recipients = await resolveEligibleRecipients({
    capabilityCode: "receiving.confirm",
    siteId: users.mainSite,
    departmentId: users.departmentA,
  });

  assert.ok(recipients.includes(eligible), "a capable, active, in-scope user must be eligible");
  assert.ok(!recipients.includes(wrongDepartment), "another department must not be notified");
  assert.ok(!recipients.includes(wrongSite), "another site must not be notified");
  assert.ok(!recipients.includes(inactive), "a deactivated user must not be notified");
  assert.ok(!recipients.includes(denied), "an explicit DENY must remove a role grant");
  assert.ok(recipients.includes(users.ceo), "CEO is in scope everywhere");
});

test("an individual GRANT and an active capability bundle both confer eligibility", async () => {
  const tag = crypto.randomBytes(4).toString("hex");

  // EMPLOYEE has no demand.approve by default.
  const granted = await makeUser({
    email: `granted-${tag}@test.eset.local`,
    role: "EMPLOYEE",
    siteId: users.mainSite,
  });
  await grant(granted, "demand.approve");

  const bundled = await makeUser({
    email: `bundled-${tag}@test.eset.local`,
    role: "EMPLOYEE",
    siteId: users.mainSite,
  });
  await pool.query(
    `INSERT INTO user_permission_bundle_assignments (user_id, bundle_id, assigned_by_user_id)
     SELECT $1, id, $2 FROM permission_bundles WHERE code = 'FORMAL_APPROVER'
     ON CONFLICT DO NOTHING`,
    [bundled, users.ceo],
  );

  const plain = await makeUser({ email: `plain-${tag}@test.eset.local`, role: "EMPLOYEE", siteId: users.mainSite });

  const recipients = await resolveEligibleRecipients({
    capabilityCode: "demand.approve",
    siteId: users.mainSite,
  });

  assert.ok(recipients.includes(granted), "an individual GRANT must confer eligibility");
  assert.ok(recipients.includes(bundled), "an active capability bundle must confer eligibility");
  assert.ok(!recipients.includes(plain), "a plain EMPLOYEE holds no approval authority");
});

test("an inactive capability bundle stops conferring eligibility", async () => {
  const tag = crypto.randomBytes(4).toString("hex");
  const bundled = await makeUser({
    email: `deactivated-bundle-${tag}@test.eset.local`,
    role: "EMPLOYEE",
    siteId: users.mainSite,
  });
  await pool.query(
    `INSERT INTO user_permission_bundle_assignments (user_id, bundle_id, assigned_by_user_id)
     SELECT $1, id, $2 FROM permission_bundles WHERE code = 'FORMAL_APPROVER'
     ON CONFLICT DO NOTHING`,
    [bundled, users.ceo],
  );

  await pool.query("UPDATE permission_bundles SET is_active = false WHERE code = 'FORMAL_APPROVER'");
  try {
    const recipients = await resolveEligibleRecipients({
      capabilityCode: "demand.approve",
      siteId: users.mainSite,
    });
    assert.ok(!recipients.includes(bundled), "a deactivated bundle must confer nothing");
  } finally {
    await pool.query("UPDATE permission_bundles SET is_active = true WHERE code = 'FORMAL_APPROVER'");
  }
});

test("a broad-scope permission reaches across sites, and its absence does not", async () => {
  const tag = crypto.randomBytes(4).toString("hex");
  const broad = await makeUser({
    email: `broad-${tag}@test.eset.local`,
    role: "TEAM_LEAD",
    siteId: users.otherSite,
    departmentId: users.otherSiteDepartment,
  });
  await grant(broad, "demand.all_departments");

  const withBroadScope = await resolveEligibleRecipients({
    capabilityCode: "demand.view",
    allScopePermissionCode: "demand.all_departments",
    siteId: users.mainSite,
  });
  assert.ok(withBroadScope.includes(broad), "an all-scope holder is eligible regardless of site");

  const withoutBroadScope = await resolveEligibleRecipients({
    capabilityCode: "demand.view",
    siteId: users.mainSite,
  });
  assert.ok(
    !withoutBroadScope.includes(broad),
    "without an all-scope code, the same user is out of scope at another site",
  );
});

test("resolution cost depends on how many recipients there are, not how many accounts exist", async () => {
  // The regression itself, measured rather than timed.
  //
  // The old implementation read EVERY user and aggregated each one's full
  // effective permission set — all ~93 permissions — inside the caller's
  // write transaction. Its plan therefore produced on the order of
  // users x permissions rows. Wall-clock would be flaky in CI, so this
  // asserts the work the planner actually did.
  const tag = crypto.randomBytes(4).toString("hex");
  const bulk = [];
  for (let index = 0; index < 400; index += 1) {
    bulk.push(`('scale-${tag}-${index}@test.eset.local', 'x', 'Scale ${index}',
      (SELECT id FROM roles WHERE name = 'EMPLOYEE'), '${users.otherSite}')`);
  }
  const inserted = await pool.query(
    `INSERT INTO users (email, password_hash, full_name, role_id, site_id)
     VALUES ${bulk.join(", ")} RETURNING id`,
  );
  created.push(...inserted.rows.map((row) => row.id));

  try {
    await pool.query("ANALYZE users");
    const totalUsers = (await pool.query("SELECT count(*)::int AS total FROM users")).rows[0].total;
    const totalPermissions = (await pool.query("SELECT count(*)::int AS total FROM permissions")).rows[0].total;
    assert.ok(totalUsers > 400, "the scale fixture must actually be in place");

    // Runs the REAL resolver statement under EXPLAIN ANALYZE by wrapping the
    // executor, so the measurement can never drift from the query that ships.
    let plan = null;
    const explaining = {
      query: async (sql, params) => {
        const explained = await pool.query(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params);
        plan = explained.rows[0]["QUERY PLAN"][0].Plan;
        return { rows: [] };
      },
    };

    await resolveEligibleRecipients({
      capabilityCode: "receiving.confirm",
      siteId: users.mainSite,
      departmentId: users.departmentA,
      executor: explaining,
    });

    const maxActualRows = (node) =>
      Math.max(
        node["Actual Rows"] ?? 0,
        ...(node.Plans || []).map(maxActualRows),
      );
    const worstNode = maxActualRows(plan);

    // The old shape would reach roughly totalUsers x totalPermissions here.
    assert.ok(
      worstNode < totalUsers * 2,
      `no plan node may scale with users x permissions: worst node produced ${worstNode} rows ` +
        `with ${totalUsers} users and ${totalPermissions} permissions`,
    );

    const recipients = await resolveEligibleRecipients({
      capabilityCode: "receiving.confirm",
      siteId: users.mainSite,
      departmentId: users.departmentA,
    });

    // 400 extra accounts at another site, holding nothing, must contribute
    // nothing to the answer.
    assert.ok(recipients.length > 0, "real recipients must still be found");
    for (const id of inserted.rows.map((row) => row.id)) {
      assert.ok(!recipients.includes(id), "an out-of-scope bulk account must never be a recipient");
    }
  } finally {
    await pool.query("DELETE FROM users WHERE email LIKE $1", [`scale-${tag}-%@test.eset.local`]);
  }
});

test("resolution runs inside the caller's transaction without acquiring another connection", async () => {
  // Notification routing happens while a business transaction holds its row
  // lock. Taking a second pool connection there is how a request deadlocks
  // itself under load, so the executor must be honoured.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    let queries = 0;
    const instrumented = {
      query: (...args) => {
        queries += 1;
        return client.query(...args);
      },
    };

    const recipients = await resolveEligibleRecipients({
      capabilityCode: "receiving.confirm",
      siteId: users.mainSite,
      departmentId: users.departmentA,
      executor: instrumented,
    });

    assert.ok(Array.isArray(recipients));
    assert.equal(queries, 1, "one set-oriented statement, on the caller's own connection");
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }
});

test("pool-size plus one concurrent transaction-owned resolutions all complete", async () => {
  // Each caller resolves recipients on the connection it already holds, so
  // more concurrent transactions than the pool has connections must still
  // finish rather than deadlock waiting for a second one.
  const size = config.databasePoolMax;
  const runs = Array.from({ length: size + 1 }, async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const recipients = await resolveEligibleRecipients({
        capabilityCode: "receiving.confirm",
        siteId: users.mainSite,
        departmentId: users.departmentA,
        executor: client,
      });
      await client.query("ROLLBACK");
      return recipients;
    } finally {
      client.release();
    }
  });

  const results = await Promise.all(runs);
  assert.equal(results.length, size + 1);
  for (const recipients of results) {
    assert.deepEqual(recipients, results[0], "every concurrent resolution must agree");
  }
});

test("the resolver reads the same authoritative rules as authentication", async () => {
  // Not a mock: a real second connection asserting that the set-oriented
  // query and the per-user profile projection agree about one user.
  const client = new pg.Client({ connectionString: config.databaseUrl });
  await client.connect();
  try {
    const { getUserProfileById } = await import("../src/shared/users/user-profile.repository.js");
    const profile = await getUserProfileById(users.teamLead, client);
    assert.ok(profile.permissions.includes("receiving.confirm"), "fixture assumption");

    const recipients = await resolveEligibleRecipients({
      capabilityCode: "receiving.confirm",
      siteId: profile.site_id,
      departmentId: profile.department_id,
      executor: client,
    });

    assert.ok(
      recipients.includes(users.teamLead),
      "a user whose profile shows the capability must be resolved as a recipient",
    );
  } finally {
    await client.end();
  }
});
