import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import pool from "../src/config/database.js";
import { startTestServer, seedUsers } from "./setup.js";
import { authHeader, apiRequest } from "./gate-pass-helpers.js";
import { formatDate } from "../src/shared/time/app-timezone.js";

// A PostgreSQL `date` is a calendar date. node-postgres used to convert it
// into a JavaScript Date through the NODE PROCESS's local timezone — which
// the pool's `options: -c TimeZone=...` does not affect, because that pins
// the server session. Correctness of every date therefore depended on the
// deploy host's TZ, and a host east of APP_TIMEZONE rendered every one of
// them a day early.

let server;
let users;
let ceoToken;
let hrToken;
let teamLeadToken;

before(async () => {
  server = await startTestServer();
  users = await seedUsers();
  ceoToken = await authHeader(server.baseUrl, "ceo@test.eset.local");
  hrToken = await authHeader(server.baseUrl, "hr@test.eset.local");
  teamLeadToken = await authHeader(server.baseUrl, "teamlead@test.eset.local");
});

after(async () => {
  await server.close();
  await pool.end();
});

test("a DATE column reaches the API as the calendar date it is, in every host timezone", async () => {
  // The regression, run for real: the same query executed by child processes
  // whose TZ spans both sides of APP_TIMEZONE must produce identical text.
  // Under the old behaviour Pacific/Auckland returned 2025-12-31T11:00:00Z
  // while Asia/Karachi returned 2025-12-31T19:00:00Z for the same row.
  const script = `
    import pool from "./src/config/database.js";
    const result = await pool.query("SELECT DATE '2026-01-01' AS calendar_date");
    process.stdout.write(JSON.stringify(result.rows[0].calendar_date));
    await pool.end();
  `;

  const readings = ["UTC", "Asia/Karachi", "Pacific/Auckland", "America/New_York", "Pacific/Kiritimati"].map(
    (timezone) => {
      const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
        cwd: new URL("..", import.meta.url).pathname,
        env: { ...process.env, TZ: timezone },
        encoding: "utf8",
      });
      assert.equal(result.status, 0, `${timezone}: ${result.stderr}`);
      return [timezone, result.stdout];
    },
  );

  for (const [timezone, value] of readings) {
    assert.equal(value, '"2026-01-01"', `${timezone} must read the calendar date unchanged`);
  }
});

test("timestamps are still instants and still respect the business timezone", async () => {
  // The fix must not have flattened timestamptz, which genuinely is a moment
  // in time and must keep its timezone handling.
  const result = await pool.query("SELECT NOW() AS moment, DATE '2026-03-05' AS calendar_date");

  assert.ok(result.rows[0].moment instanceof Date, "timestamptz must remain a Date");
  assert.equal(result.rows[0].calendar_date, "2026-03-05", "date must remain a plain calendar string");
});

test("formatDate renders a calendar date without pushing it through a timezone", async () => {
  assert.equal(formatDate("2026-01-01"), "01/01/2026");
  assert.equal(formatDate("2025-12-31"), "31/12/2025");

  // An instant still goes through the business timezone.
  const instant = new Date("2026-01-01T02:00:00.000Z");
  assert.equal(formatDate(instant), "01/01/2026", "02:00 UTC is already 07:00 in Asia/Karachi");
});

test("an employee joining date round-trips through the API unchanged", async () => {
  const joiningDate = "2026-01-01";
  const code = `CAL-${crypto.randomBytes(3).toString("hex").toUpperCase()}`;

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/employees", {
    token: hrToken,
    body: {
      employeeCode: code,
      fullLegalName: "Calendar Date Employee",
      joiningDate,
      departmentId: users.departmentA,
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  assert.equal(created.body.data.joiningDate, joiningDate, "the create response must echo the calendar date");

  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/employees/${created.body.data.id}`, {
    token: hrToken,
  });
  assert.equal(detail.body.data.joiningDate, joiningDate, "the detail response must return the same calendar date");

  const stored = await pool.query("SELECT joining_date FROM employees WHERE id = $1", [created.body.data.id]);
  assert.equal(stored.rows[0].joining_date, joiningDate, "and it must match what the database holds");
});

test("a gate pass expected return date round-trips unchanged", async () => {
  const expectedReturnDate = "2026-09-30";

  const created = await apiRequest(server.baseUrl, "POST", "/api/v1/gate-passes", {
    token: teamLeadToken,
    body: {
      issuingDepartmentId: users.departmentA,
      requestedBy: "Calendar Date",
      destination: "Workshop",
      driverName: "Driver",
      driverPhone: "+923001234567",
      vehicleRegistration: `CAL-${Math.floor(Math.random() * 100000)}`,
      purpose: "RETURNABLE",
      expectedReturnDate,
      items: [{ description: "Item", quantity: 1 }],
    },
  });
  assert.equal(created.status, 201, JSON.stringify(created.body));

  const id = created.body.data.gatePass?.id || created.body.data.id;
  const detail = await apiRequest(server.baseUrl, "GET", `/api/v1/gate-passes/${id}`, { token: teamLeadToken });

  assert.equal(detail.body.data.expectedReturnDate, expectedReturnDate);
});

test("every DATE column in the schema is served as a calendar date", async () => {
  // A future migration adding a DATE column gets this behaviour
  // automatically, but this asserts the parser really is registered against
  // the type rather than any particular query.
  const columns = await pool.query(
    `SELECT table_name, column_name
     FROM information_schema.columns
     WHERE table_schema = 'public' AND data_type = 'date'
     ORDER BY table_name, column_name`,
  );

  assert.ok(columns.rowCount >= 13, "the schema's DATE columns must still be present");

  for (const { table_name: table, column_name: column } of columns.rows) {
    const sample = await pool.query(
      `SELECT ${column} AS value FROM ${table} WHERE ${column} IS NOT NULL LIMIT 1`,
    );
    if (sample.rowCount === 0) continue;

    assert.equal(
      typeof sample.rows[0].value,
      "string",
      `${table}.${column} must be served as a calendar date string, not a Date`,
    );
    assert.match(sample.rows[0].value, /^\d{4}-\d{2}-\d{2}$/, `${table}.${column}`);
  }
});
