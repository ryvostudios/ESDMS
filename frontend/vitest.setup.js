import { beforeEach } from "vitest";

// Guards every test against leftover browser-storage state from a
// previous test — whether that state came from another test in the same
// file, or (on some Node/jsdom version combinations) Node's own
// experimental global localStorage/sessionStorage bleeding into jsdom's.
// Deterministic per-test storage state, not tied to diagnosing exactly
// which of those is in play on a given machine.
//
// Accessed via `window.*`, not the bare global — a bare `localStorage`
// reference assumes the jsdom environment has already aliased it onto the
// global object by the time setupFiles run, which isn't guaranteed across
// every Vitest pool/environment-initialization order. `window` itself is
// only defined under the jsdom environment (not e.g. a plain-Node test
// file), so both are guarded.
beforeEach(() => {
  if (typeof window !== "undefined") {
    window.localStorage?.clear();
    window.sessionStorage?.clear();
  }
});
