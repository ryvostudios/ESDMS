import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ReceiptDetailPage } from "./ReceiptDetailPage.jsx";

const mockGetReceipt = vi.hoisted(() => vi.fn());
let mockPermissions = new Set();

vi.mock("../api.js", () => ({
  getReceipt: (...args) => mockGetReceipt(...args),
  acknowledgeHandover: vi.fn(),
  confirmReceipt: vi.fn(),
}));
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual("react-router-dom")),
  useParams: () => ({ id: "receipt-1" }),
}));
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)) }),
}));

afterEach(() => {
  cleanup();
  mockGetReceipt.mockReset();
  mockPermissions = new Set();
});

function receipt(overrides = {}) {
  return {
    data: {
      receipt: {
        id: "receipt-1",
        dc_id: "dc-1",
        dc_number: "ESET-DC/2026/8",
        department_name: "Civil",
        receipt_type: "DEPARTMENT",
        status: "PENDING_CONFIRMATION",
        has_discrepancy: false,
        received_by_name: "Test Employee",
        physical_receiver_name: null,
        received_at: "2026-08-03T09:00:00.000Z",
        handover_to_name: null,
        handover_at: null,
        confirmed_by_name: null,
        confirmed_at: null,
        ...overrides,
      },
      lines: [
        {
          id: "rl-1",
          item_name_snapshot: "Cement",
          uom_name_snapshot: "Bags",
          dc_quantity: "60.00",
          received_quantity: "55.00",
          discrepancy_quantity: "5.00",
          discrepancy_type: "SHORT",
          discrepancy_note: "Five bags short",
        },
      ],
    },
  };
}

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <ReceiptDetailPage />
      </MemoryRouter>,
    );
  });
}

describe("ReceiptDetailPage", () => {
  test("confirmation is offered only to a holder of receiving.confirm", async () => {
    mockPermissions = new Set(["receiving.view", "receiving.receive"]);
    mockGetReceipt.mockResolvedValue(receipt());
    await renderPage();
    expect(screen.queryByRole("button", { name: /confirm completion/i })).toBeNull();

    cleanup();
    mockPermissions = new Set(["receiving.view", "receiving.confirm"]);
    mockGetReceipt.mockResolvedValue(receipt());
    await renderPage();
    expect(screen.getByRole("button", { name: /confirm completion/i })).toBeTruthy();
  });

  test("handover acknowledgement is a department action, offered only while awaiting handover", async () => {
    // Admin holds fallback custody but not receiving.receive, so Admin is
    // never offered the department's own acknowledgement.
    mockPermissions = new Set(["receiving.view", "receiving.fallback_receive"]);
    mockGetReceipt.mockResolvedValue(
      receipt({ receipt_type: "ADMIN_FALLBACK", status: "AWAITING_HANDOVER", received_by_name: "Test Admin" }),
    );
    await renderPage();
    expect(screen.queryByRole("button", { name: /acknowledge handover/i })).toBeNull();
    expect(screen.getByText(/admin is holding this material temporarily/i)).toBeTruthy();

    cleanup();
    mockPermissions = new Set(["receiving.view", "receiving.receive"]);
    mockGetReceipt.mockResolvedValue(
      receipt({ receipt_type: "ADMIN_FALLBACK", status: "AWAITING_HANDOVER", received_by_name: "Test Admin" }),
    );
    await renderPage();
    expect(screen.getByRole("button", { name: /acknowledge handover/i })).toBeTruthy();
    // A receipt still in Admin custody cannot be confirmed yet.
    expect(screen.queryByRole("button", { name: /confirm completion/i })).toBeNull();
  });

  test("both custody events survive a completed handover", async () => {
    mockPermissions = new Set(["receiving.view"]);
    mockGetReceipt.mockResolvedValue(
      receipt({
        receipt_type: "ADMIN_FALLBACK",
        status: "COMPLETED",
        received_by_name: "Test Admin",
        physical_receiver_name: "Site Storekeeper",
        handover_to_name: "Test Employee",
        handover_at: "2026-08-03T12:00:00.000Z",
        confirmed_by_name: "Test Team Lead",
        confirmed_at: "2026-08-04T09:00:00.000Z",
      }),
    );
    await renderPage();

    expect(screen.getByText("Temporary Site Administrator custody")).toBeTruthy();
    expect(screen.getByText("Test Admin")).toBeTruthy();
    expect(screen.getByText("Site Storekeeper")).toBeTruthy();
    expect(screen.getByText("Test Employee")).toBeTruthy();
    expect(screen.getByText("Test Team Lead")).toBeTruthy();
  });

  test("received and discrepancy quantities are shown separately, never collapsed", async () => {
    mockPermissions = new Set(["receiving.view"]);
    mockGetReceipt.mockResolvedValue(receipt({ has_discrepancy: true }));
    await renderPage();

    expect(screen.getByText("60.00")).toBeTruthy();
    expect(screen.getByText("55.00")).toBeTruthy();
    expect(screen.getByText("5.00")).toBeTruthy();
    expect(screen.getByText("SHORT")).toBeTruthy();
    expect(screen.getByText(/not a stock balance/i)).toBeTruthy();
  });

  test("no pricing is present anywhere on a receiving screen", async () => {
    mockPermissions = new Set(["receiving.view", "receiving.confirm"]);
    mockGetReceipt.mockResolvedValue(receipt());
    const { container } = await act(async () =>
      render(
        <MemoryRouter>
          <ReceiptDetailPage />
        </MemoryRouter>,
      ),
    );
    await act(async () => {});
    expect(container.textContent).not.toMatch(/\bRs\b/);
    expect(container.textContent).not.toMatch(/price/i);
  });
});
