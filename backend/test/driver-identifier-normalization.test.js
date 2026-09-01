import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";

// Driver CNIC/licence uniqueness was case- and whitespace-sensitive while
// vehicle registration was not, so one real licence could produce two Driver
// records at one site, each accumulating its own Gate Pass history.

let server;
let users;
let managerToken;
let otherSiteToken;

function tag() {
  return crypto.randomBytes(4).toString("hex").toUpperCase();
}

async function createDriver(token, body) {
  return apiRequest(server.baseUrl, "POST", "/api/v1/drivers", { token, body });
}

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  managerToken = await authHeader(server.baseUrl, "manager@test.eset.local");
  // The other site's ADMIN also holds driver.manage.
  otherSiteToken = await authHeader(server.baseUrl, "admin-othersite@test.eset.local");
});

after(async () => {
  await pool.query("DELETE FROM drivers WHERE name LIKE 'Normalization %'");
  await server.close();
  await pool.end();
});

test("a licence number differing only in case or spacing is the same identifier", async () => {
  const licence = `LIC-${tag()}`;

  const first = await createDriver(managerToken, {
    name: "Normalization Driver One",
    phone: "+923001111111",
    licenceNumber: licence,
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  for (const variant of [licence.toLowerCase(), `  ${licence}  `, `${licence}\t`, licence.toUpperCase()]) {
    const duplicate = await createDriver(managerToken, {
      name: "Normalization Driver Duplicate",
      phone: "+923002222222",
      licenceNumber: variant,
    });
    assert.equal(duplicate.status, 409, `"${variant}" must be refused as the same licence`);
    assert.match(duplicate.body.error.message, /licence number already exists/i);
  }
});

test("normalization stays narrow: internal spacing is meaningful, not stripped", async () => {
  // Deliberately NOT a fuzzy matcher. Leading/trailing space, repeated
  // whitespace and case are typing noise; spacing around a separator is not
  // safely removable, because identifier schemes exist where "AB 123" and
  // "AB123" are genuinely different records. Widening this would risk
  // collapsing two real drivers into one.
  const licence = `LIC-${tag()}`;

  assert.equal(
    (await createDriver(managerToken, {
      name: "Normalization Driver Spacing Base",
      phone: "+923001212121",
      licenceNumber: licence,
    })).status,
    201,
  );

  const spaced = await createDriver(managerToken, {
    name: "Normalization Driver Spacing Variant",
    phone: "+923001313131",
    licenceNumber: licence.replace("-", " - "),
  });
  assert.equal(spaced.status, 201, "a differently-spaced identifier remains a distinct record");
});

test("a CNIC differing only in case or spacing is the same identifier", async () => {
  const cnic = `42101-${tag()}-1`;

  const first = await createDriver(managerToken, {
    name: "Normalization Driver Cnic",
    phone: "+923003333333",
    cnic,
  });
  assert.equal(first.status, 201, JSON.stringify(first.body));

  const duplicate = await createDriver(managerToken, {
    name: "Normalization Driver Cnic Duplicate",
    phone: "+923004444444",
    cnic: `  ${cnic.toLowerCase()}  `,
  });
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error.message, /CNIC already exists/i);
});

test("a genuinely different identifier is still accepted", async () => {
  const base = tag();
  assert.equal(
    (await createDriver(managerToken, {
      name: "Normalization Driver Distinct A",
      phone: "+923005555555",
      licenceNumber: `LIC-${base}-A`,
    })).status,
    201,
  );
  assert.equal(
    (await createDriver(managerToken, {
      name: "Normalization Driver Distinct B",
      phone: "+923006666666",
      licenceNumber: `LIC-${base}-B`,
    })).status,
    201,
    "normalization must not collapse genuinely different identifiers",
  );
});

test("uniqueness stays scoped per site", async () => {
  // Two sites may legitimately deal with the same contractor driver, and
  // neither may probe the other's master data by watching for a conflict.
  const licence = `LIC-${tag()}`;

  assert.equal(
    (await createDriver(managerToken, {
      name: "Normalization Driver Shared",
      phone: "+923007777777",
      licenceNumber: licence,
    })).status,
    201,
  );
  assert.equal(
    (await createDriver(otherSiteToken, {
      name: "Normalization Driver Shared Other Site",
      phone: "+923008888888",
      licenceNumber: licence.toLowerCase(),
    })).status,
    201,
    "another site must be able to hold the same contractor licence",
  );
});

test("a driver may still be created with neither identifier", async () => {
  // Both indexes are partial: the columns are nullable and many gate visitors
  // have neither recorded.
  for (const index of [1, 2]) {
    const response = await createDriver(managerToken, {
      name: `Normalization Driver No Identifier ${index}`,
      phone: `+92300999999${index}`,
    });
    assert.equal(response.status, 201, JSON.stringify(response.body));
  }
});

test("the database refuses a normalized duplicate even when the service is bypassed", async () => {
  const licence = `LIC-${tag()}`;
  const created = await createDriver(managerToken, {
    name: "Normalization Driver Direct",
    phone: "+923001010101",
    licenceNumber: licence,
  });
  assert.equal(created.status, 201);

  await assert.rejects(
    pool.query(
      `INSERT INTO drivers (site_id, name, phone, licence_number, created_by_user_id)
       VALUES ($1, 'Normalization Driver Direct Duplicate', '+923001010102', $2, $3)`,
      [users.mainSite, `  ${licence.toLowerCase()} `, users.ceo],
    ),
    (error) => error.code === "23505",
    "the index, not only the service, must enforce identity",
  );
});

test("vehicle registration uniqueness is unchanged", async () => {
  // The behaviour drivers were brought into line with.
  const registration = `REG-${tag()}`;
  assert.equal(
    (await apiRequest(server.baseUrl, "POST", "/api/v1/vehicles", {
      token: managerToken,
      body: { registrationNumber: registration },
    })).status,
    201,
  );

  const duplicate = await apiRequest(server.baseUrl, "POST", "/api/v1/vehicles", {
    token: managerToken,
    body: { registrationNumber: ` ${registration.toLowerCase()} ` },
  });
  assert.equal(duplicate.status, 409);
});
