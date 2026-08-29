import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

let server;
let users;
let tokens;

function unique(label) {
  return `${label}-${Date.now()}-${Math.floor(Math.random() * 100000)}`;
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  tokens = {
    ceo: await authHeader(server.baseUrl, "ceo@test.eset.local"),
    admin: await authHeader(server.baseUrl, "admin@test.eset.local"),
    teamLead: await authHeader(server.baseUrl, "teamlead@test.eset.local"),
    employee: await authHeader(server.baseUrl, "employee@test.eset.local"),
    otherSiteAdmin: await authHeader(server.baseUrl, "admin-othersite@test.eset.local"),
  };
});

after(async () => {
  await server.close();
  await pool.end();
});

async function createDriver(token = tokens.admin, overrides = {}) {
  return apiRequest(server.baseUrl, "POST", "/api/v1/drivers", {
    token,
    body: { name: unique("Driver"), phone: "0300-1234567", ...overrides },
  });
}

async function createVehicle(token = tokens.admin, overrides = {}) {
  return apiRequest(server.baseUrl, "POST", "/api/v1/vehicles", {
    token,
    body: { registrationNumber: unique("REG"), vehicleType: "TRUCK", ...overrides },
  });
}

test("Driver supports add, view, edit, deactivate and reactivate without hard delete", async () => {
  const created = await createDriver(tokens.admin, { cnic: unique("CNIC"), driverType: "CONTRACTOR" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const driverId = created.body.data.id;
  assert.equal(created.body.data.is_active, true);
  assert.equal(created.body.data.driver_type, "CONTRACTOR");

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/drivers/${driverId}`, { token: tokens.admin });
  assert.equal(detail.status, 200);
  assert.equal(detail.body.data.driver.id, driverId);
  assert.ok(Array.isArray(detail.body.data.gatePasses), "Driver detail carries Gate Pass history");

  const edited = await apiRequest(server.baseUrl, "PATCH", `/api/v1/drivers/${driverId}`, {
    token: tokens.admin,
    body: { name: "Renamed Driver", company: "Acme Logistics" },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.name, "Renamed Driver");
  assert.equal(edited.body.data.company, "Acme Logistics");

  const deactivated = await apiRequest(server.baseUrl, "PATCH", `/api/v1/drivers/${driverId}`, {
    token: tokens.admin,
    body: { isActive: false },
  });
  assert.equal(deactivated.status, 200);
  assert.equal(deactivated.body.data.is_active, false);

  // An inactive Driver disappears from the default list but is never deleted.
  const defaultList = await apiRequest(server.baseUrl, "GET", "/api/v1/drivers", { token: tokens.admin });
  assert.equal(defaultList.body.data.some((row) => row.id === driverId), false);

  const withInactive = await apiRequest(server.baseUrl, "GET", "/api/v1/drivers?includeInactive=true", {
    token: tokens.admin,
  });
  assert.equal(withInactive.body.data.some((row) => row.id === driverId), true);

  const reactivated = await apiRequest(server.baseUrl, "PATCH", `/api/v1/drivers/${driverId}`, {
    token: tokens.admin,
    body: { isActive: true },
  });
  assert.equal(reactivated.status, 200);
  assert.equal(reactivated.body.data.is_active, true);

  // There is no delete route at all — the inverse of "add" is deactivation.
  const deleted = await apiRequest(server.baseUrl, "DELETE", `/api/v1/drivers/${driverId}`, { token: tokens.ceo });
  assert.equal(deleted.status, 404);
});

test("Vehicle supports the same lifecycle and rejects a duplicate registration at one site", async () => {
  const registration = unique("REG");
  const created = await createVehicle(tokens.admin, { registrationNumber: registration, make: "Hino" });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  const vehicleId = created.body.data.id;

  // Case-insensitive: the same physical vehicle must not split into two rows.
  const duplicate = await createVehicle(tokens.admin, { registrationNumber: registration.toLowerCase() });
  assert.equal(duplicate.status, 409);

  // Another site may legitimately register the same number.
  const otherSite = await createVehicle(tokens.otherSiteAdmin, { registrationNumber: registration });
  assert.equal(otherSite.status, 201);

  const edited = await apiRequest(server.baseUrl, "PATCH", `/api/v1/vehicles/${vehicleId}`, {
    token: tokens.admin,
    body: { color: "White", isActive: false },
  });
  assert.equal(edited.status, 200);
  assert.equal(edited.body.data.color, "White");
  assert.equal(edited.body.data.is_active, false);
});

test("fleet master data is site-scoped and capability-gated", async () => {
  const driver = await createDriver(tokens.admin);
  const vehicle = await createVehicle(tokens.admin);

  // Another site's Admin gets 404, not 403: an out-of-scope id is
  // indistinguishable from a nonexistent one.
  for (const [path, id] of [["drivers", driver.body.data.id], ["vehicles", vehicle.body.data.id]]) {
    const crossSite = await apiRequest(server.baseUrl, "GET", `/api/v1/${path}/${id}`, {
      token: tokens.otherSiteAdmin,
    });
    assert.equal(crossSite.status, 404, `${path} must not be readable across sites`);

    const crossSiteEdit = await apiRequest(server.baseUrl, "PATCH", `/api/v1/${path}/${id}`, {
      token: tokens.otherSiteAdmin,
      body: { isActive: false },
    });
    assert.equal(crossSiteEdit.status, 404);
  }

  // A cross-site list never contains another site's rows either.
  const otherSiteList = await apiRequest(server.baseUrl, "GET", "/api/v1/drivers", {
    token: tokens.otherSiteAdmin,
  });
  assert.equal(otherSiteList.body.data.some((row) => row.id === driver.body.data.id), false);

  // A Team Lead may select existing master data but may not create it.
  const teamLeadList = await apiRequest(server.baseUrl, "GET", "/api/v1/drivers", { token: tokens.teamLead });
  assert.equal(teamLeadList.status, 200);
  assert.equal((await createDriver(tokens.teamLead)).status, 403);
  assert.equal((await createVehicle(tokens.teamLead)).status, 403);

  // A plain Employee holds neither view nor manage.
  assert.equal(
    (await apiRequest(server.baseUrl, "GET", "/api/v1/drivers", { token: tokens.employee })).status,
    403,
  );
});

test("an employee link must belong to the driver's own site", async () => {
  const employeeRow = await pool.query("SELECT id FROM employees WHERE primary_site_id = $1 LIMIT 1", [
    users.otherSite,
  ]);

  const bogus = await createDriver(tokens.admin, { employeeId: "00000000-0000-4000-8000-000000000000" });
  assert.equal(bogus.status, 400);

  if (employeeRow.rowCount > 0) {
    const crossSiteLink = await createDriver(tokens.admin, { employeeId: employeeRow.rows[0].id });
    assert.equal(crossSiteLink.status, 400, "linking another site's employee must be refused");
  }
});
