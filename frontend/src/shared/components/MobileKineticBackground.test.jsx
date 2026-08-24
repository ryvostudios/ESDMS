import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";
import { cleanup, render } from "@testing-library/react";
import { MobileKineticBackground } from "./MobileKineticBackground.jsx";
import styles from "./MobileKineticBackground.module.css";

// Same stubbing approach as SidebarKineticBackground.test.jsx — jsdom has
// neither a real canvas 2D context, matchMedia, nor ResizeObserver, so all
// three are stubbed with the minimal surface this component calls. No
// assertions here touch rendered pixels or animation frames.
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

function setSize(element, width, height) {
  Object.defineProperty(element, "clientWidth", { value: width, configurable: true });
  Object.defineProperty(element, "clientHeight", { value: height, configurable: true });
  element.getBoundingClientRect = () => ({
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    x: 0,
    y: 0,
    toJSON() {},
  });
}

function makeSizedContainer(width, height) {
  const div = document.createElement("div");
  setSize(div, width, height);
  return div;
}

function stubResizeObserver() {
  let callback;
  globalThis.ResizeObserver = class {
    constructor(cb) {
      callback = cb;
    }
    observe() {}
    disconnect() {}
  };
  return { trigger: () => callback() };
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
  delete globalThis.ResizeObserver;
  Object.defineProperty(document, "hidden", { value: false, configurable: true });
});

describe("MobileKineticBackground — structure", () => {
  test("renders a canvas that never intercepts pointer events", () => {
    setMatchMedia(false);
    stubResizeObserver();
    const { container } = render(<MobileKineticBackground />);

    const canvas = container.querySelector("canvas");
    expect(canvas).toBeTruthy();
    expect(canvas.getAttribute("aria-hidden")).toBe("true");
    expect(canvas.className).toContain(styles.canvas);
  });
});

describe("MobileKineticBackground — pointer owner", () => {
  test("pointer listeners attach to the real interaction owner, not the pointer-events:none decorative container", () => {
    setMatchMedia(false);
    stubResizeObserver();
    const rtlContainer = makeSizedContainer(280, 640);
    const ownerEl = document.createElement("div");
    const ownerAddSpy = vi.spyOn(ownerEl, "addEventListener");
    const containerAddSpy = vi.spyOn(rtlContainer, "addEventListener");

    render(<MobileKineticBackground interactionRef={{ current: ownerEl }} />, { container: rtlContainer });

    expect(ownerAddSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(ownerAddSpy).toHaveBeenCalledWith("pointerleave", expect.any(Function));
    expect(containerAddSpy).not.toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(containerAddSpy).not.toHaveBeenCalledWith("pointerleave", expect.any(Function));
  });

  test("dispatching pointermove/touch-driven pointer events on the owner does not throw or preventDefault", () => {
    setMatchMedia(false);
    stubResizeObserver();
    const rtlContainer = makeSizedContainer(280, 640);
    const ownerEl = document.createElement("div");

    render(<MobileKineticBackground interactionRef={{ current: ownerEl }} />, { container: rtlContainer });

    const moveEvent = new MouseEvent("pointermove", { clientX: 140, clientY: 300, bubbles: true, cancelable: true });
    expect(() => ownerEl.dispatchEvent(moveEvent)).not.toThrow();
    // Nothing in the handler calls preventDefault — normal touch
    // scroll/tap behavior on the real owner must never be blocked.
    expect(moveEvent.defaultPrevented).toBe(false);

    expect(() => ownerEl.dispatchEvent(new MouseEvent("pointerleave", { bubbles: true }))).not.toThrow();
  });

  test("without an interactionRef, falls back to the decorative container instead of throwing", () => {
    setMatchMedia(false);
    stubResizeObserver();
    expect(() => render(<MobileKineticBackground />)).not.toThrow();
  });

  test("unmount removes pointer listeners from the interaction owner", () => {
    setMatchMedia(false);
    stubResizeObserver();
    const rtlContainer = makeSizedContainer(280, 640);
    const ownerEl = document.createElement("div");
    const ownerRemoveSpy = vi.spyOn(ownerEl, "removeEventListener");

    const { unmount } = render(<MobileKineticBackground interactionRef={{ current: ownerEl }} />, {
      container: rtlContainer,
    });
    unmount();

    expect(ownerRemoveSpy).toHaveBeenCalledWith("pointermove", expect.any(Function));
    expect(ownerRemoveSpy).toHaveBeenCalledWith("pointerleave", expect.any(Function));
  });
});

describe("MobileKineticBackground — RAF lifecycle vs. container size", () => {
  test("starts RAF with usable dimensions, stops when the container becomes 0x0, and restarts exactly once when usable again", () => {
    setMatchMedia(false);
    const { trigger } = stubResizeObserver();
    const rtlContainer = makeSizedContainer(280, 640);

    render(<MobileKineticBackground />, { container: rtlContainer });
    expect(rafSpy).toHaveBeenCalledTimes(1);

    setSize(rtlContainer, 0, 0);
    trigger();
    expect(cancelSpy).toHaveBeenCalled();
    const rafCallsWhileCollapsed = rafSpy.mock.calls.length;

    trigger(); // redundant resize while still collapsed must not schedule anything
    expect(rafSpy.mock.calls.length).toBe(rafCallsWhileCollapsed);

    setSize(rtlContainer, 280, 640);
    trigger();
    expect(rafSpy.mock.calls.length).toBe(rafCallsWhileCollapsed + 1);
  });

  test("mounting directly into a 0x0 container never starts RAF, and unmount does not throw", () => {
    setMatchMedia(false);
    stubResizeObserver();
    const { unmount } = render(<MobileKineticBackground />);

    expect(rafSpy).not.toHaveBeenCalled();
    expect(() => unmount()).not.toThrow();
  });

  test("prefers-reduced-motion: never starts RAF even with usable dimensions", () => {
    setMatchMedia(true);
    stubResizeObserver();
    const rtlContainer = makeSizedContainer(280, 640);

    render(<MobileKineticBackground />, { container: rtlContainer });

    expect(rafSpy).not.toHaveBeenCalled();
  });

  test("document.hidden stops the loop; becoming visible with usable dimensions restarts it", () => {
    setMatchMedia(false);
    stubResizeObserver();
    const rtlContainer = makeSizedContainer(280, 640);

    render(<MobileKineticBackground />, { container: rtlContainer });
    expect(rafSpy).toHaveBeenCalledTimes(1);

    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(cancelSpy).toHaveBeenCalled();

    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    expect(rafSpy).toHaveBeenCalledTimes(2);
  });

  test("unmount with an active loop cancels the pending frame", () => {
    setMatchMedia(false);
    stubResizeObserver();
    const rtlContainer = makeSizedContainer(280, 640);

    const { unmount } = render(<MobileKineticBackground />, { container: rtlContainer });
    expect(rafSpy).toHaveBeenCalledTimes(1);

    unmount();
    expect(cancelSpy).toHaveBeenCalled();
  });
});
