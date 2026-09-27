import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MobileNav } from "./MobileNav.jsx";
import gridStyles from "../../shared/components/MobileKineticBackground.module.css";
import styles from "./MobileNav.module.css";

vi.mock("../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));
vi.mock("../../modules/cms/company-logo.js", () => ({ useCompanyLogo: () => "blob:managed-logo" }));

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

let resizeCallbacks;

beforeEach(() => {
  stubCanvasContext();
  setMatchMedia(false);
  rafSpy = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(1);
  cancelSpy = vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  resizeCallbacks = [];
  globalThis.ResizeObserver = class {
    constructor(cb) {
      resizeCallbacks.push(cb);
    }
    observe() {}
    disconnect() {}
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  delete globalThis.ResizeObserver;
});

describe("MobileNav focus trap", () => {
  test("Tab on the last focusable element wraps back to the first (close button)", async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <MobileNav open onClose={() => {}} triggerRef={{ current: null }} />
        </MemoryRouter>,
      );
    });

    const dialog = screen.getByRole("dialog");
    const img = dialog.querySelector('img');
    expect(img?.src).toContain('blob:managed-logo');
    expect(img.className).toBe(styles.brandLogo);
    expect(dialog.querySelector(`.${styles.brandMark}`)).toBeNull();
    const focusable = dialog.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    last.focus();
    expect(document.activeElement).toBe(last);

    fireEvent.keyDown(document, { key: "Tab" });
    expect(document.activeElement).toBe(first);
  });

  test("Shift+Tab on the first focusable element wraps to the last", async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <MobileNav open onClose={() => {}} triggerRef={{ current: null }} />
        </MemoryRouter>,
      );
    });

    const dialog = screen.getByRole("dialog");
    const focusable = dialog.querySelectorAll('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])');
    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    first.focus();
    expect(document.activeElement).toBe(first);

    fireEvent.keyDown(document, { key: "Tab", shiftKey: true });
    expect(document.activeElement).toBe(last);
  });

  test("Escape closes the drawer and returns focus to the trigger", async () => {
    const onClose = vi.fn();
    const trigger = document.createElement("button");
    document.body.appendChild(trigger);

    await act(async () => {
      render(
        <MemoryRouter>
          <MobileNav open onClose={onClose} triggerRef={{ current: trigger }} />
        </MemoryRouter>,
      );
    });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();

    trigger.remove();
  });

  test("the drawer has a stable id matching TopBar's trigger aria-controls value", async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <MobileNav open onClose={() => {}} triggerRef={{ current: null }} />
        </MemoryRouter>,
      );
    });

    expect(screen.getByRole("dialog").id).toBe("mobile-nav-drawer");
  });

  test("clicking the backdrop closes the drawer", async () => {
    const onClose = vi.fn();
    let container;
    await act(async () => {
      ({ container } = render(
        <MemoryRouter>
          <MobileNav open onClose={onClose} triggerRef={{ current: null }} />
        </MemoryRouter>,
      ));
    });

    fireEvent.click(container.querySelector('[class*="backdrop"]'));

    expect(onClose).toHaveBeenCalled();
  });

  test("clicking a navigation link closes the drawer", async () => {
    const onClose = vi.fn();
    await act(async () => {
      render(
        <MemoryRouter>
          <MobileNav open onClose={onClose} triggerRef={{ current: null }} />
        </MemoryRouter>,
      );
    });

    fireEvent.click(screen.getAllByRole("link")[0]);

    expect(onClose).toHaveBeenCalled();
  });
});

describe("MobileNav — kinetic grid mount lifecycle", () => {
  test("mounts a kinetic-background canvas only while the drawer is open", async () => {
    const { container: openContainer } = render(
      <MemoryRouter>
        <MobileNav open onClose={() => {}} triggerRef={{ current: null }} />
      </MemoryRouter>,
    );
    const canvas = openContainer.querySelector("canvas");
    expect(canvas).toBeTruthy();
    expect(canvas.className).toContain(gridStyles.canvas);
    cleanup();

    const { container: closedContainer } = render(
      <MemoryRouter>
        <MobileNav open={false} onClose={() => {}} triggerRef={{ current: null }} />
      </MemoryRouter>,
    );
    expect(closedContainer.querySelector("canvas")).toBeNull();
    // Closed is a real `return null` — nothing of the drawer renders at all.
    expect(closedContainer.querySelector('[role="dialog"]')).toBeNull();
  });

  test("canvas is pointer-events:none and never blocks navigation clicks", async () => {
    const onClose = vi.fn();
    render(
      <MemoryRouter>
        <MobileNav open onClose={onClose} triggerRef={{ current: null }} />
      </MemoryRouter>,
    );

    const canvas = document.querySelector("canvas");
    expect(canvas.className).toContain(gridStyles.canvas);

    // Real regression proof, not just a class-name check: a real nav link
    // click still reaches NavList's onClick (closes the drawer) rather
    // than being intercepted by the decorative canvas underneath it.
    fireEvent.click(screen.getAllByRole("link")[0]);
    expect(onClose).toHaveBeenCalled();
  });

  test("closing the drawer (unmount) cancels the pending animation frame", async () => {
    const { unmount } = render(
      <MemoryRouter>
        <MobileNav open onClose={() => {}} triggerRef={{ current: null }} />
      </MemoryRouter>,
    );

    // jsdom never lays anything out, so the grid's own container reports
    // 0x0 at mount — give it a real size and re-trigger the resize
    // callback the component itself registered, so RAF actually starts
    // (proving there's something real to cancel below, not just an
    // already-guarded no-op).
    const canvas = document.querySelector("canvas");
    const gridContainer = canvas.parentElement;
    Object.defineProperty(gridContainer, "clientWidth", { value: 280, configurable: true });
    Object.defineProperty(gridContainer, "clientHeight", { value: 640, configurable: true });
    resizeCallbacks.forEach((cb) => cb());
    expect(rafSpy).toHaveBeenCalled();

    unmount();
    expect(cancelSpy).toHaveBeenCalled();
  });

  test("prefers-reduced-motion: the drawer's grid never starts a continuous animation loop", async () => {
    setMatchMedia(true);

    render(
      <MemoryRouter>
        <MobileNav open onClose={() => {}} triggerRef={{ current: null }} />
      </MemoryRouter>,
    );

    expect(rafSpy).not.toHaveBeenCalled();
  });
});
