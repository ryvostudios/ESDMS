// Post-deploy smoke test against a DEPLOYED API, over HTTP only. No database
// credentials, and nothing here needs to run inside the API process.
//
// Readiness is deliberately not trusted as the last word. It is a very good
// predictor now (see src/shared/db/schema-compatibility.js), but a real sign-in
// is the only thing that proves a real user can sign in: readiness runs the
// authentication query with a sentinel id, while this runs it with a genuine
// credential, an Argon2 verification, a JWT signature and a session cookie.
//
//   ESDMS_SMOKE_EMAIL=... ESDMS_SMOKE_PASSWORD=... \
//     npm run verify:deployment -- https://api.example.com

const baseUrl = (process.argv[2] || process.env.ESDMS_SMOKE_BASE_URL || "").replace(/\/+$/, "");
const email = process.env.ESDMS_SMOKE_EMAIL;
const password = process.env.ESDMS_SMOKE_PASSWORD;

const failures = [];
const results = [];

function record(name, ok, detail = "") {
  results.push(`  ${ok ? "ok  " : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
}

async function main() {
  if (!baseUrl) {
    throw new Error("Usage: npm run verify:deployment -- https://api.example.com");
  }
  if (!email || !password) {
    throw new Error(
      "ESDMS_SMOKE_EMAIL and ESDMS_SMOKE_PASSWORD are required.\n" +
        "A readiness check alone cannot prove a user can sign in, so this refuses to\n" +
        "report success without exercising a real login.",
    );
  }

  process.stdout.write(`Verifying ${baseUrl}\n`);

  // 1. Liveness.
  const health = await fetch(`${baseUrl}/api/v1/health`);
  record("liveness", health.status === 200, `HTTP ${health.status}`);

  // 2. Readiness — and report exactly what it says is wrong, so a failure is
  //    actionable without shell access to the container.
  const readyResponse = await fetch(`${baseUrl}/api/v1/health/ready`);
  const ready = await readyResponse.json().catch(() => null);
  record(
    "readiness",
    readyResponse.status === 200 && ready?.data?.ready === true,
    readyResponse.status === 200 ? "" : (ready?.data?.problems || []).join("; ") || `HTTP ${readyResponse.status}`,
  );
  if (ready?.data?.backendRevision) {
    process.stdout.write(`  backend revision: ${ready.data.backendRevision}\n`);
  }

  // 3. A real login.
  const login = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  const cookie = login.headers.get("set-cookie")?.split(";")[0] || null;
  record("login", login.status === 200 && Boolean(cookie), `HTTP ${login.status}`);

  // 4. The authenticated identity endpoint, using that session.
  if (cookie) {
    const me = await fetch(`${baseUrl}/api/v1/auth/me`, { headers: { Cookie: cookie } });
    const body = await me.json().catch(() => null);
    record("authenticated /me", me.status === 200 && Boolean(body?.data?.user?.id), `HTTP ${me.status}`);

    // 5. Sign out again, so the smoke test does not leave a live session behind.
    const logout = await fetch(`${baseUrl}/api/v1/auth/logout`, {
      method: "POST",
      headers: { Cookie: cookie },
    });
    record("logout", logout.status === 200, `HTTP ${logout.status}`);
  } else {
    record("authenticated /me", false, "skipped: no session cookie");
    record("logout", false, "skipped: no session cookie");
  }

  // 6. A wrong password must still be rejected — a deployment that accepts
  //    anything would otherwise pass every check above.
  const rejected = await fetch(`${baseUrl}/api/v1/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email, password: `${password}-not-the-password` }),
  });
  record("wrong password rejected", rejected.status === 401, `HTTP ${rejected.status}`);

  process.stdout.write(`${results.join("\n")}\n`);

  if (failures.length > 0) {
    throw new Error(`Deployment smoke test failed: ${failures.join(", ")}`);
  }
  process.stdout.write("\nDeployment verified.\n");
}

main().catch((error) => {
  process.stderr.write(`\n${error.message}\n`);
  process.exitCode = 1;
});
