import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { LoginMeshBackground } from "./LoginMeshBackground.jsx";
import styles from "./LoginMeshBackground.module.css";

// jsdom implements neither a real 2D canvas context nor matchMedia — both
// are stubbed with the minimal surface this component actually calls, so
// these tests can assert structure/lifecycle without needing a real
// browser. No assertions here touch rendered pixels or animation frames —
// see the module comment on LoginMeshBackground.jsx for the full physics
// spec, which is exercised only by manual/browser verification.
function stubCanvasContext() {
  const ctx = {
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
    setTransform: vi.fn(),
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(ctx);
  return ctx;
}

function setMatchMedia(reducedMotion) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: reducedMotion,
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

let rafSpy;
let cancelSpy;

beforeEach(() => {
  stubCanvasContext();
  rafSpy = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("LoginMeshBackground", () => {
  test("renders a canvas element that never intercepts pointer events", () => {
    setMatchMedia(false);
    const { container } = render(<LoginMeshBackground />);

    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    // jsdom doesn't apply real stylesheet rules, so this checks the
    // canvas carries the class whose CSS sets pointer-events: none (see
    // LoginMeshBackground.module.css), not a computed style jsdom can't
    // produce here.
    expect(canvas.className).toContain(styles.canvas);
  });

  test("starts the requestAnimationFrame loop when motion is not reduced", () => {
    setMatchMedia(false);
    render(<LoginMeshBackground />);

    expect(rafSpy).toHaveBeenCalled();
  });

  test("prefers-reduced-motion: does not start an animation loop", () => {
    setMatchMedia(true);
    render(<LoginMeshBackground />);

    expect(rafSpy).not.toHaveBeenCalled();
  });

  test("unmount cleans up without throwing, and cancels any pending frame", () => {
    setMatchMedia(false);
    const { unmount } = render(<LoginMeshBackground />);

    expect(() => unmount()).not.toThrow();
    expect(cancelSpy).toHaveBeenCalled();
  });

  test("unmount after reduced-motion mount does not throw (no loop was ever started)", () => {
    setMatchMedia(true);
    const { unmount } = render(<LoginMeshBackground />);

    expect(() => unmount()).not.toThrow();
  });
});
