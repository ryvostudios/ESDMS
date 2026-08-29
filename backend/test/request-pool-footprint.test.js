import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import * as demandService from "../src/modules/material-demand/material-demand.service.js";

// Regression coverage for the defect behind the intermittent MD-HF-01 failure.
//
// A Demand detail is seven reads. They used to run through Promise.all against
// the POOL, so one request checked out up to five clients at once. With
// DATABASE_POOL_MAX = 10 that meant two concurrent detail requests could
// consume the entire pool and a third would wait out
// connectionTimeoutMillis and fail as a 500 — a database-looking error that
// was really the request's own connection footprint.
//
// The invariant these tests protect is "one request costs one connection",
// which is what makes pool sizing mean what it says.

let server;
let users;
let tokens;
let demandId;

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
  };

  const uoms = await apiRequest(server.baseUrl, "GET", "/api/v1/material-catalog/units-of-measure", {
    token: tokens.ceo,
  });
  const catalogEntry = await apiRequest(server.baseUrl, "POST", "/api/v1/material-catalog", {
    token: tokens.teamLead,
    body: { newItem: { name: `Pool Footprint ${Date.now()}` }, defaultUomId: uoms.body.data[0].id },
  });
  assert.equal(catalogEntry.status, 201, JSON.stringify(catalogEntry.body));

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/demands", {
    token: tokens.teamLead,
    body: { lines: [{ catalogEntryId: catalogEntry.body.data.id, quantity: 3 }] },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  demandId = created.body.data.demand.id;
});

after(async () => {
  await server.close();
  await pool.end();
});

// Counts how many clients are checked out of the pool AT THE SAME TIME while
// fn runs. Patching pool.connect is the only way to see this: pool.totalCount
// counts sockets that exist, not sockets a single request is holding.
async function maxConcurrentCheckouts(fn) {
  const originalConnect = pool.connect.bind(pool);
  let live = 0;
  let peak = 0;

  pool.connect = async (...args) => {
    const client = await originalConnect(...args);
    live += 1;
    peak = Math.max(peak, live);

    const originalRelease = client.release.bind(client);
    let released = false;
    client.release = (...releaseArgs) => {
      if (!released) {
        released = true;
        live -= 1;
      }
      return originalRelease(...releaseArgs);
    };

    return client;
  };

  try {
    await fn();
  } finally {
    pool.connect = originalConnect;
  }

  return { peak, leaked: live };
}

test("a Demand detail read holds one pooled connection, not one per query", async () => {
  const actor = {
    id: users.ceo,
    role: "CEO",
    siteId: users.mainSite,
    departmentId: null,
    permissions: new Set(["demand.view", "demand.all_departments"]),
  };

  const { peak, leaked } = await maxConcurrentCheckouts(() => demandService.getDemandDetail(actor, demandId));

  assert.equal(
    peak,
    1,
    `a Demand detail must not multiply its pool footprint (peak concurrent checkouts: ${peak})`,
  );
  assert.equal(leaked, 0, "every checked-out client must be released");
});

test("concurrent Demand detail requests do not exhaust the pool", async () => {
  // Comfortably more in flight than DATABASE_POOL_MAX (10). Before the fix
  // this produced pool connect timeouts surfacing as 500s; now the pool
  // simply queues, because each request costs one connection.
  const responses = await Promise.all(
    Array.from({ length: 24 }, () =>
      apiRequest(server.baseUrl, "GET", `/api/v1/demands/${demandId}`, { token: tokens.ceo }),
    ),
  );

  const failures = responses.filter((response) => response.status !== 200);
  assert.equal(
    failures.length,
    0,
    `every concurrent detail request must succeed; saw ${failures.length} failures: ${JSON.stringify(
      failures.slice(0, 3).map((f) => f.body),
    )}`,
  );

  // And the pool is fully handed back afterwards.
  assert.equal(pool.idleCount, pool.totalCount, "no connection stays checked out after the burst");
});

test("a burst of mixed reads leaves no connection checked out", async () => {
  // Measured with the pool's own counters rather than by patching
  // client.release: pool.query() releases through an internal path that never
  // calls the client's own release method, so instrumentation would report a
  // phantom leak for every list endpoint. idleCount === totalCount is the
  // honest signal that nothing is still held.
  const responses = await Promise.all([
    apiRequest(server.baseUrl, "GET", `/api/v1/demands/${demandId}`, { token: tokens.ceo }),
    apiRequest(server.baseUrl, "GET", "/api/v1/demands", { token: tokens.ceo }),
    apiRequest(server.baseUrl, "GET", "/api/v1/ipos", { token: tokens.ceo }),
  ]);

  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200],
  );
  assert.equal(pool.idleCount, pool.totalCount, "a mixed read burst must release every client it took");
});
