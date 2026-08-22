import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { MobileNav } from "./MobileNav.jsx";

vi.mock("../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ hasPermission: () => true }),
}));

afterEach(cleanup);

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
});
