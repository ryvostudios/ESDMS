import { beforeEach } from "vitest";

// A small, standards-compatible in-memory Storage implementation, owned
// entirely by the test setup — not relying on jsdom's own
// localStorage/sessionStorage being present or consistent, which isn't
// guaranteed across every Vitest pool/environment-initialization order on
// every Node version. Backed by a Map to preserve insertion order for
// key(index).
class MemoryStorage {
  #store = new Map();

  getItem(key) {
    const value = this.#store.get(String(key));
    return value === undefined ? null : value;
  }

  setItem(key, value) {
    this.#store.set(String(key), String(value));
  }

  removeItem(key) {
    this.#store.delete(String(key));
  }

  clear() {
    this.#store.clear();
  }

  key(index) {
    const keys = Array.from(this.#store.keys());
    return index >= 0 && index < keys.length ? keys[index] : null;
  }

  get length() {
    return this.#store.size;
  }
}

// Installed once per test file (this module runs once as a Vitest
// setupFile, in the same jsdom environment the file's own tests run in),
// then cleared before every individual test below — deterministic
// storage state regardless of what ran before it, in this file or (on
// some Node/jsdom version combinations, via Node's own experimental
// global storage) outside it entirely.
if (typeof window !== "undefined") {
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();

  Object.defineProperty(window, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(window, "sessionStorage", { configurable: true, value: sessionStorage });

  // Application source code (correctly, for real-browser code where
  // `window` IS the global object) reads the bare `localStorage` /
  // `sessionStorage` globals, not `window.localStorage`. Under Vitest's
  // jsdom environment those bare globals are only reliable if explicitly
  // aliased — done here, deliberately, in test setup only, pointing at
  // the exact same instances as window.* above so both ways of reading
  // storage agree.
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: localStorage });
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: sessionStorage });
}

beforeEach(() => {
  if (typeof window !== "undefined") {
    window.localStorage.clear();
    window.sessionStorage.clear();
  }
});
