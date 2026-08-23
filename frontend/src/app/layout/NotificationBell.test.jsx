import { describe, test, expect, vi, beforeEach, afterEach } from "vitest";
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

// ESDMS-017: polling behavior — pause/resume, backoff, no overlap, cleanup.
// Math.random is pinned to 0 so the small jitter added to every scheduled
// delay is a known, minimal quantity rather than a source of test flakiness.
describe("NotificationBell polling", () => {
  function setVisibility(state) {
    Object.defineProperty(document, "visibilityState", { configurable: true, value: state });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    setVisibility("visible");
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    setVisibility("visible");
  });

  test("does not poll while the document is hidden, including the initial poll on mount", async () => {
    setVisibility("hidden");
    mockListNotifications.mockResolvedValue({ data: [] });

    await act(async () => {
      render(<NotificationBell />);
    });

    expect(mockListNotifications).not.toHaveBeenCalled();
  });

  test("resumes polling when the document becomes visible again", async () => {
    setVisibility("hidden");
    mockListNotifications.mockResolvedValue({ data: [] });

    await act(async () => {
      render(<NotificationBell />);
    });
    expect(mockListNotifications).not.toHaveBeenCalled();

    await act(async () => {
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(5_000); // covers the jittered resume delay
    });

    expect(mockListNotifications).toHaveBeenCalledTimes(1);
  });

  test("polls again on a ~60 second cadence, not the old 30 second one", async () => {
    mockListNotifications.mockResolvedValue({ data: [] });

    await act(async () => {
      render(<NotificationBell />);
    });
    expect(mockListNotifications).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(55_000);
    });
    expect(mockListNotifications).toHaveBeenCalledTimes(1); // not yet — a 30s cadence would have fired again by now

    await act(async () => {
      await vi.advanceTimersByTimeAsync(10_000); // total ~65s, past 60s + jitter
    });
    expect(mockListNotifications).toHaveBeenCalledTimes(2);
  });

  test("backs off after a failure instead of retrying at the normal cadence", async () => {
    mockListNotifications.mockRejectedValueOnce(new Error("429")).mockResolvedValue({ data: [] });

    await act(async () => {
      render(<NotificationBell />);
    });
    expect(mockListNotifications).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000); // past the normal ~60s cadence
    });
    expect(mockListNotifications).toHaveBeenCalledTimes(1); // still backed off, no retry yet

    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000); // past the doubled (~120s) backoff delay
    });
    expect(mockListNotifications).toHaveBeenCalledTimes(2);
  });

  test("never sends an overlapping request, even across a rapid hidden/visible toggle mid-request", async () => {
    let resolveFirst;
    mockListNotifications.mockImplementationOnce(
      () => new Promise((resolve) => { resolveFirst = resolve; }),
    );
    mockListNotifications.mockResolvedValue({ data: [] });

    await act(async () => {
      render(<NotificationBell />);
    });
    expect(mockListNotifications).toHaveBeenCalledTimes(1);

    // Flicker visibility while the first request is still pending.
    await act(async () => {
      setVisibility("hidden");
      setVisibility("visible");
      await vi.advanceTimersByTimeAsync(65_000);
    });
    expect(mockListNotifications).toHaveBeenCalledTimes(1); // no second call while the first is still in flight

    await act(async () => {
      resolveFirst({ data: [] });
      await Promise.resolve();
    });

    await act(async () => {
      await vi.advanceTimersByTimeAsync(65_000);
    });
    expect(mockListNotifications).toHaveBeenCalledTimes(2); // resumes normally once the first settles
  });

  test("clears its timer on unmount — no poll fires after the component is gone", async () => {
    mockListNotifications.mockResolvedValue({ data: [] });

    let unmount;
    await act(async () => {
      ({ unmount } = render(<NotificationBell />));
    });
    expect(mockListNotifications).toHaveBeenCalledTimes(1);

    unmount();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5 * 60_000);
    });
    expect(mockListNotifications).toHaveBeenCalledTimes(1); // still just the initial poll — nothing fired after unmount
  });
});
