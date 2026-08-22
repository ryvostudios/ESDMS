import { describe, test, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

// A full `vite build` (which is what actually exercises this setting) is
// too slow/heavy to run on every test invocation — this checks the source
// config declares the setting correctly instead. See
// `src/app/layout/*` for the app code this protects (direct browser
// navigation to /api/... must reach the real API, never the SPA shell).
const configSource = fs.readFileSync(path.resolve(import.meta.dirname, "./vite.config.js"), "utf8");

describe("PWA service worker config", () => {
  test("excludes /api/ from the SPA navigation fallback", () => {
    expect(configSource).toMatch(/navigateFallbackDenylist/);
    expect(configSource).toMatch(/\/\^\\\/api\\\//);
  });

  test("still keeps /api/ as NetworkOnly for runtime caching (both protections, not one instead of the other)", () => {
    expect(configSource).toMatch(/NetworkOnly/);
    expect(configSource).toMatch(/url\.pathname\.includes\(['"]\/api\/['"]\)/);
  });
});
