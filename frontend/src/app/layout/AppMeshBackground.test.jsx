import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { AppMeshBackground } from "./AppMeshBackground.jsx";
import styles from "./AppMeshBackground.module.css";

// Same stubbing approach as LoginMeshBackground.test.jsx.
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
  globalThis.ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete globalThis.ResizeObserver;
});

describe("AppMeshBackground", () => {
  test("renders a canvas that never intercepts pointer events", () => {
    setMatchMedia(false);
    const { container } = render(<AppMeshBackground />);

    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.className).toContain(styles.canvas);
  });

  test("starts the requestAnimationFrame loop when motion is not reduced", () => {
    setMatchMedia(false);
    render(<AppMeshBackground />);

    expect(rafSpy).toHaveBeenCalled();
  });

  test("prefers-reduced-motion: does not start an animation loop", () => {
    setMatchMedia(true);
    render(<AppMeshBackground />);

    expect(rafSpy).not.toHaveBeenCalled();
  });

  test("unmount cleans up without throwing, and cancels any pending frame", () => {
    setMatchMedia(false);
    const { unmount } = render(<AppMeshBackground />);

    expect(() => unmount()).not.toThrow();
    expect(cancelSpy).toHaveBeenCalled();
  });
});

describe("AppMeshBackground — pointer owner (VIS-01)", () => {
  // Regression: the mesh's own container is pointer-events:none in the
  // real stylesheet and never receives real pointer events. Pointer
  // tracking must attach to the actual hit-testable owner (AppShell's
  // `.main`) instead, passed in via `interactionRef`.
  test("pointer listeners attach to the real interaction owner, not the pointer-events:none decorative container", () => {
    setMatchMedia(false);
    const rtlContainer = document.createElement("div");
    const ownerEl = document.createElement("div");
    const ownerAddSpy = vi.spyOn(ownerEl, "addEventListener");
    const containerAddSpy = vi.spyOn(rtlContainer, "addEventListener");

    render(<AppMeshBackground interactionRef={{ current: ownerEl }} />, { container: rtlContainer });

    expect(ownerAddSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(ownerAddSpy).toHaveBeenCalledWith("pointerleave", expect.any(Function));
    expect(containerAddSpy).not.toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(containerAddSpy).not.toHaveBeenCalledWith("pointerleave", expect.any(Function));
  });

  test("dispatching pointermove on the owner does not throw, using canvas-relative coordinates", () => {
    setMatchMedia(false);
    const ownerEl = document.createElement("div");

    render(<AppMeshBackground interactionRef={{ current: ownerEl }} />);

    expect(() => {
      ownerEl.dispatchEvent(new MouseEvent("pointermove", { clientX: 200, clientY: 150, bubbles: true }));
      ownerEl.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }));
    }).not.toThrow();
  });

  test("without an interactionRef, falls back to the decorative container instead of throwing", () => {
    setMatchMedia(false);
    expect(() => render(<AppMeshBackground />)).not.toThrow();
  });

  test("unmount removes pointer listeners from the interaction owner", () => {
    setMatchMedia(false);
    const ownerEl = document.createElement("div");
    const ownerRemoveSpy = vi.spyOn(ownerEl, "removeEventListener");

    const { unmount } = render(<AppMeshBackground interactionRef={{ current: ownerEl }} />);
    unmount();

    expect(ownerRemoveSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(ownerRemoveSpy).toHaveBeenCalledWith("pointerleave", expect.any(Function));
  });
});
