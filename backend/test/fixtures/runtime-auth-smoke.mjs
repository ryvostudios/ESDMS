import http from "node:http";
import app from "../../src/app.js";
import pool from "../../src/config/database.js";

const email = process.env.ESDMS_RUNTIME_SMOKE_EMAIL;
const password = process.env.ESDMS_RUNTIME_SMOKE_PASSWORD;

if (!email || !password) {
  throw new Error("Runtime auth smoke credentials are required.");
}

const server = http.createServer(app);

try {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const baseUrl = `http://127.0.0.1:${port}/api/v1/auth`;
  const headers = { "Content-Type": "application/json", Origin: "http://localhost:5173" };

  const login = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];

  const me = await fetch(`${baseUrl}/me`, {
    headers: { Origin: "http://localhost:5173", Cookie: cookie || "" },
  });
  const invalidLogin = await fetch(`${baseUrl}/login`, {
    method: "POST",
    headers,
    body: JSON.stringify({ email, password: `${password}-invalid` }),
  });
  const readiness = await fetch(`http://127.0.0.1:${port}/api/v1/health/ready`);
  const readinessBody = await readiness.json();

  process.stdout.write(`${JSON.stringify({
    loginStatus: login.status,
    meStatus: me.status,
    invalidLoginStatus: invalidLogin.status,
    readinessStatus: readiness.status,
    schemaCompatible: readinessBody.data?.schemaCompatible,
    runtimeProvisioningCompatible: readinessBody.data?.runtimeProvisioningCompatible,
    appliedMigrationCount: readinessBody.data?.appliedMigrationCount,
    latestAppliedMigration: readinessBody.data?.latestAppliedMigration,
  })}\n`);
} finally {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
}
