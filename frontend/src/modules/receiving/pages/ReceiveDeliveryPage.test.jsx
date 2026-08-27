import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ReceiveDeliveryPage } from "./ReceiveDeliveryPage.jsx";

const mockGetDelivery = vi.hoisted(() => vi.fn());
const mockRecordReceipt = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());
let mockPermissions = new Set();

vi.mock("../api.js", () => ({
  getDeliveryForReceiving: (...args) => mockGetDelivery(...args),
  recordReceipt: (...args) => mockRecordReceipt(...args),
}));
vi.mock("../../delivery-challan/api.js", () => ({ getDeliveryChallanPdf: vi.fn() }));
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual("react-router-dom")),
  useParams: () => ({ id: "dc-1" }),
  useNavigate: () => mockNavigate,
}));
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)) }),
}));

afterEach(() => {
  cleanup();
  mockGetDelivery.mockReset();
  mockRecordReceipt.mockReset();
  mockNavigate.mockReset();
  mockPermissions = new Set();
});

function delivery(overrides = {}) {
  return {
    data: {
      deliveryChallan: {
        id: "dc-1",
        dc_number: "ESET-DC/2026/8",
        department_name: "Civil",
        ipo_number: "ESET/2026/32",
        demand_number: "DL-2026-000004",
      },
      lines: overrides.lines || [
        {
          id: "dcl-1",
          item_name_snapshot: "Cement",
          uom_name_snapshot: "Bags",
          quantity: "60.00",
          received_quantity: "0.00",
          discrepancy_quantity: "0.00",
          unresolved_quantity: "60.00",
        },
      ],
      receipts: overrides.receipts || [],
    },
  };
}

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <ReceiveDeliveryPage />
      </MemoryRouter>,
    );
  });
}

describe("ReceiveDeliveryPage", () => {
  test("temporary Admin custody is offered only to a holder of the fallback capability", async () => {
    mockPermissions = new Set(["receiving.view", "receiving.receive"]);
    mockGetDelivery.mockResolvedValue(delivery());
    await renderPage();
    expect(screen.queryByText(/temporary admin custody/i)).toBeNull();

    cleanup();
    mockPermissions = new Set(["receiving.view", "receiving.fallback_receive"]);
    mockGetDelivery.mockResolvedValue(delivery());
    await renderPage();
    expect(screen.getByText(/nobody from the department is available/i)).toBeTruthy();
  });

  test("a received quantity is submitted as an explicit line payload", async () => {
    mockPermissions = new Set(["receiving.view", "receiving.receive"]);
    mockGetDelivery.mockResolvedValue(delivery());
    mockRecordReceipt.mockResolvedValue({ data: { receipt: { id: "receipt-1" } } });
    await renderPage();

    fireEvent.change(screen.getByLabelText("Received"), { target: { value: "55" } });
    fireEvent.change(screen.getByLabelText("Missing / damaged"), { target: { value: "5" } });
    fireEvent.change(screen.getByLabelText("Discrepancy type"), { target: { value: "SHORT" } });
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /record receipt/i }));
    });

    await waitFor(() => expect(mockRecordReceipt).toHaveBeenCalled());
    // Every receipt carries a stable operation id so a retry after a lost
    // response cannot book the same delivery twice.
    const [, payload] = mockRecordReceipt.mock.calls[0];
    expect(payload.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(mockRecordReceipt).toHaveBeenCalledWith("dc-1", {
      operationId: payload.operationId,
      fallback: false,
      note: null,
      lines: [
        {
          dcLineId: "dcl-1",
          receivedQuantity: "55",
          discrepancyQuantity: "5",
          discrepancyType: "SHORT",
          discrepancyNote: null,
        },
      ],
    });
    expect(mockNavigate).toHaveBeenCalledWith("/receiving/receipts/receipt-1");
  });

  test("submitting nothing is refused client-side without calling the API", async () => {
    mockPermissions = new Set(["receiving.view", "receiving.receive"]);
    mockGetDelivery.mockResolvedValue(delivery());
    await renderPage();

    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /record receipt/i }));
    });
    expect(screen.getByRole("alert").textContent).toMatch(/record a received or discrepancy quantity/i);
    expect(mockRecordReceipt).not.toHaveBeenCalled();
  });

  test("a fully accounted delivery offers nothing further to receive", async () => {
    mockPermissions = new Set(["receiving.view", "receiving.receive"]);
    mockGetDelivery.mockResolvedValue(
      delivery({
        lines: [
          {
            id: "dcl-1",
            item_name_snapshot: "Cement",
            uom_name_snapshot: "Bags",
            quantity: "60.00",
            received_quantity: "60.00",
            discrepancy_quantity: "0.00",
            unresolved_quantity: "0.00",
          },
        ],
      }),
    );
    await renderPage();
    expect(screen.getByText(/fully accounted for/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /record receipt/i })).toBeNull();
  });

  test("the discrepancy type and note stay disabled until a discrepancy quantity is entered", async () => {
    mockPermissions = new Set(["receiving.view", "receiving.receive"]);
    mockGetDelivery.mockResolvedValue(delivery());
    await renderPage();

    expect(screen.getByLabelText("Discrepancy type").disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("Missing / damaged"), { target: { value: "3" } });
    expect(screen.getByLabelText("Discrepancy type").disabled).toBe(false);
  });

  test("renders an error state when the delivery cannot be loaded", async () => {
    mockPermissions = new Set(["receiving.view"]);
    mockGetDelivery.mockRejectedValue(new Error("Delivery unavailable"));
    await renderPage();
    expect(screen.getByText("Delivery unavailable")).toBeTruthy();
  });
});
