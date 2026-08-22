// Test-only fixture: boots the real Express app (with whatever
// FRONTEND_ORIGIN is set in this process's env) on an ephemeral port and
// makes one real HTTP request against it with a browser-shaped `Origin`
// header, to prove actual CORS behavior end-to-end — not just that the
// config value looks right in isolation. Prints "PASS" or "FAIL: <reason>"
// and exits 0/1 accordingly. Health check only (no DB query needed).
import http from "node:http";
import app from "../../src/app.js";

const requestOrigin = process.env.TEST_REQUEST_ORIGIN;

const server = http.createServer(app);
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const { port } = server.address();

const response = await fetch(`http://127.0.0.1:${port}/api/v1/health`, {
  headers: { Origin: requestOrigin },
});

const allowOrigin = response.headers.get("access-control-allow-origin");

server.close();

if (response.status === 200 && allowOrigin === requestOrigin) {
  console.log("PASS");
  process.exit(0);
} else {
  console.log(`FAIL: status=${response.status} access-control-allow-origin=${allowOrigin}`);
  process.exit(1);
}
