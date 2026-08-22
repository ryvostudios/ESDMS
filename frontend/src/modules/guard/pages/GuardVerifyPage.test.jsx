import { describe, test, expect, vi, afterEach, beforeEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { GuardVerifyPage } from "./GuardVerifyPage.jsx";

const mockVerifyByToken = vi.fn();
vi.mock("../api.js", () => ({
  verifyByToken: (...args) => mockVerifyByToken(...args),
}));

let replaceStateSpy;

beforeEach(() => {
  window.location.hash = "#raw-secret-token-abc123";
  replaceStateSpy = vi.spyOn(window.history, "replaceState");
  mockVerifyByToken.mockResolvedValue({
    data: { gatePass: { id: "gp-1", status: "APPROVED" }, allowedAction: "EXIT", reason: null },
  });
});

afterEach(() => {
  cleanup();
  replaceStateSpy.mockRestore();
  window.location.hash = "";
  mockVerifyByToken.mockReset();
});

describe("GuardVerifyPage QR token lifecycle", () => {
  test("reads the token from the URL fragment and immediately strips it via history.replaceState", async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <GuardVerifyPage />
        </MemoryRouter>,
      );
    });

    expect(mockVerifyByToken).toHaveBeenCalledWith("raw-secret-token-abc123");
    expect(replaceStateSpy).toHaveBeenCalled();
  });

  test("never writes the token to localStorage or sessionStorage", async () => {
    await act(async () => {
      render(
        <MemoryRouter>
          <GuardVerifyPage />
        </MemoryRouter>,
      );
    });

    for (let i = 0; i < window.localStorage.length; i++) {
      const value = window.localStorage.getItem(window.localStorage.key(i));
      expect(value).not.toContain("raw-secret-token-abc123");
    }
    for (let i = 0; i < window.sessionStorage.length; i++) {
      const value = window.sessionStorage.getItem(window.sessionStorage.key(i));
      expect(value).not.toContain("raw-secret-token-abc123");
    }
  });
});
