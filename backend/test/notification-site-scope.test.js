import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest, buildCreatePayload } from "./gate-pass-helpers.js";

let server;
let users;
let tokens;

before(async () => {
  server = await startTestServer();
  users = await seedUsers();

  tokens = {
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    guard: await authHeader(server.baseUrl, "guard@test.eset.local"),
    otherSiteGuard: await authHeader(server.baseUrl, "guard-othersite@test.eset.local"),
  };
});

after(async () => {
  await server.close();
  await pool.end();
});

test("an approved Gate Pass's Guard notification reaches Guards on its own site, and no other site", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.admin,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA }),
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const gatePassId = created.body.data.id;

  const approved = await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${gatePassId}/approve`, {
    token: tokens.admin,
  });
  assert.equal(approved.status, 200);

  const sameSiteNotifications = await apiRequest(server.baseUrl, "GET", "/api/v1/notifications", {
    token: tokens.guard,
  });
  assert.ok(
    sameSiteNotifications.body.data.some((n) => n.entityId === gatePassId),
    "the Guard on the same site as the Gate Pass must see its approval notification",
  );

  const otherSiteNotifications = await apiRequest(server.baseUrl, "GET", "/api/v1/notifications", {
    token: tokens.otherSiteGuard,
  });
  assert.ok(
    !otherSiteNotifications.body.data.some((n) => n.entityId === gatePassId),
    "a Guard on a different site must never see this notification",
  );
});

test("changing the API query/filter cannot bypass the site boundary — the endpoint takes no site parameter at all", async () => {
  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: tokens.admin,
    body: buildCreatePayload({ issuingDepartmentId: users.departmentA }),
  });
  const gatePassId = created.body.data.id;
  await apiRequest(server.baseUrl, "POST", `/api/v1/gate-passes/${gatePassId}/approve`, { token: tokens.admin });

  // A spoofed query string trying to ask for the main site's notifications
  // anyway — the endpoint has no site parameter, so this must be a no-op.
  const response = await apiRequest(
    server.baseUrl,
    "GET",
    `/api/v1/notifications?siteId=${users.mainSite}&site_id=${users.mainSite}`,
    { token: tokens.otherSiteGuard },
  );

  assert.equal(response.status, 200);
  assert.ok(
    !response.body.data.some((n) => n.entityId === gatePassId),
    "a query-string site override must not surface another site's notification",
  );
});
