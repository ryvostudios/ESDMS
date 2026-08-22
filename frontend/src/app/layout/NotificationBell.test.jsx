import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { NotificationBell } from "./NotificationBell.jsx";

vi.mock("../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));

const mockListNotifications = vi.fn();
vi.mock("../../core/api/notifications.js", () => ({
  listNotifications: (...args) => mockListNotifications(...args),
}));

afterEach(() => {
  cleanup();
  mockListNotifications.mockReset();
  window.localStorage.clear();
});

describe("NotificationBell semantics", () => {
  test("is a disclosure (aria-expanded + aria-controls), not a role=menu with non-menu children", async () => {
    mockListNotifications.mockResolvedValue({ data: [] });

    await act(async () => {
      render(<NotificationBell />);
    });

    const button = screen.getByRole("button", { name: "Notifications" });
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.hasAttribute("aria-haspopup")).toBe(false);

    const panelId = button.getAttribute("aria-controls");
    expect(panelId).toBeTruthy();

    await act(async () => {
      fireEvent.click(button);
    });

    expect(button.getAttribute("aria-expanded")).toBe("true");

    const panel = document.getElementById(panelId);
    expect(panel).toBeTruthy();
    expect(panel.getAttribute("role")).toBe("region");
    expect(screen.queryByRole("menu")).toBeNull();
  });

  test("notification items render as a real list, not role=menu/menuitem", async () => {
    mockListNotifications.mockResolvedValue({
      data: [
        {
          id: "n1",
          eventType: "GATE_PASS_APPROVED",
          payload: {
            gatePassNumber: "ESD-2026-000001",
            driverName: "Test Driver",
            vehicleRegistration: "ABC-123",
            destination: "Site B",
          },
          createdAt: new Date().toISOString(),
        },
      ],
    });

    await act(async () => {
      render(<NotificationBell />);
    });

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Notifications" }));
    });

    expect(screen.getByRole("list")).toBeTruthy();
    expect(screen.getAllByRole("listitem").length).toBe(1);
    expect(screen.queryByRole("menuitem")).toBeNull();
  });

  test("Escape closes the panel and returns focus to the trigger", async () => {
    mockListNotifications.mockResolvedValue({ data: [] });

    await act(async () => {
      render(<NotificationBell />);
    });

    const button = screen.getByRole("button", { name: "Notifications" });

    await act(async () => {
      fireEvent.click(button);
    });
    expect(button.getAttribute("aria-expanded")).toBe("true");

    fireEvent.keyDown(document, { key: "Escape" });

    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(button);
  });
});
