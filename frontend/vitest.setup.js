import { beforeEach } from "vitest";

// Guards every test against leftover browser-storage state from a
// previous test — whether that state came from another test in the same
// file, or (on some Node/jsdom version combinations) Node's own
// experimental global localStorage/sessionStorage bleeding into jsdom's.
// Deterministic per-test storage state, not tied to diagnosing exactly
// which of those is in play on a given machine.
beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
