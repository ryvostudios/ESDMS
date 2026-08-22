import http from "node:http";
import argon2 from "argon2";
import pool from "../src/config/database.js";
import app from "../src/app.js";

export const TEST_PASSWORD = "Test-Password-123!";

export async function startTestServer() {
  const server = http.createServer(app);

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));

  const { port } = server.address();

  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function upsertSite(code, name) {
  const result = await pool.query(
    `INSERT INTO sites (code, name) VALUES ($1, $2)
     ON CONFLICT (code) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [code, name],
  );

  return result.rows[0].id;
}

async function upsertDepartment(name, siteId) {
  const result = await pool.query(
    `INSERT INTO departments (name, site_id) VALUES ($1, $2)
     ON CONFLICT (site_id, name) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [name, siteId],
  );

  return result.rows[0].id;
}

// Deterministic per-suite users. Test DB is dedicated (eset_test) — safe to
// reset users between runs.
export async function seedUsers() {
  const passwordHash = await argon2.hash(TEST_PASSWORD);

  const roles = await pool.query("SELECT id, name FROM roles");
  const roleIdByName = Object.fromEntries(roles.rows.map((r) => [r.name, r.id]));

  const mainSite = await upsertSite("MAIN", "E-Set — Main Site");
  const otherSite = await upsertSite("TEST-SECONDARY", "Test Secondary Site");

  const departments = await pool.query("SELECT id FROM departments WHERE site_id = $1 ORDER BY name LIMIT 2", [
    mainSite,
  ]);
  const [departmentA, departmentB] = departments.rows.map((row) => row.id);
  const otherSiteDepartment = await upsertDepartment("Test Secondary Dept", otherSite);

  // Upsert instead of delete+insert: node's test runner may run multiple
  // test files concurrently, and a delete+insert race between files
  // sharing this fixture set trips the unique email constraint.
  async function insertUser(
    email,
    fullName,
    roleName,
    { isActive = true, departmentId = null, siteId = mainSite } = {},
  ) {
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, full_name, role_id, is_active, department_id, site_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (email) DO UPDATE SET
         password_hash = EXCLUDED.password_hash,
         full_name = EXCLUDED.full_name,
         role_id = EXCLUDED.role_id,
         is_active = EXCLUDED.is_active,
         department_id = EXCLUDED.department_id,
         site_id = EXCLUDED.site_id
       RETURNING id`,
      [email, passwordHash, fullName, roleIdByName[roleName], isActive, departmentId, siteId],
    );

    return result.rows[0].id;
  }

  return {
    admin: await insertUser("admin@test.eset.local", "Test Admin", "ADMIN"),
    siteManager: await insertUser("manager@test.eset.local", "Test Manager", "SITE_MANAGER"),
    teamLead: await insertUser("teamlead@test.eset.local", "Test Team Lead", "TEAM_LEAD", { departmentId: departmentA }),
    teamLeadOtherDept: await insertUser("teamlead2@test.eset.local", "Test Team Lead 2", "TEAM_LEAD", { departmentId: departmentB }),
    guard: await insertUser("guard@test.eset.local", "Test Guard", "GATE_GUARD"),
    inactive: await insertUser("inactive@test.eset.local", "Test Inactive", "TEAM_LEAD", { isActive: false }),
    otherSiteAdmin: await insertUser("admin-othersite@test.eset.local", "Test Other Site Admin", "ADMIN", {
      siteId: otherSite,
    }),
    otherSiteTeamLead: await insertUser(
      "teamlead-othersite@test.eset.local",
      "Test Other Site Team Lead",
      "TEAM_LEAD",
      { siteId: otherSite, departmentId: otherSiteDepartment },
    ),
    otherSiteGuard: await insertUser("guard-othersite@test.eset.local", "Test Other Site Guard", "GATE_GUARD", {
      siteId: otherSite,
    }),
    departmentA,
    departmentB,
    mainSite,
    otherSite,
    otherSiteDepartment,
  };
}

export async function login(baseUrl, email, password = TEST_PASSWORD) {
  const response = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: "http://localhost:5173" },
    body: JSON.stringify({ email, password }),
  });

  const body = await response.json();
  const setCookie = response.headers.get("set-cookie");

  return { status: response.status, body, cookie: setCookie ? setCookie.split(";")[0] : null };
}
