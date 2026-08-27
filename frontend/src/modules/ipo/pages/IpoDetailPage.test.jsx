import { act, cleanup, render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, test, vi } from "vitest";
import { IpoDetailPage } from "./IpoDetailPage.jsx";

const mockUseIpo = vi.hoisted(() => vi.fn());
let mockPermissions = new Set();

vi.mock("../hooks/useIpo.js", () => ({ useIpo: (...args) => mockUseIpo(...args) }));
vi.mock("react-router-dom", async () => ({
  ...(await vi.importActual("react-router-dom")),
  useParams: () => ({ id: "ipo-1" }),
  useNavigate: () => vi.fn(),
}));
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    user: { id: "user-1", role: "TEAM_LEAD" },
    hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)),
  }),
}));

afterEach(() => {
  cleanup();
  mockUseIpo.mockReset();
  mockPermissions = new Set();
});

const OPERATIONAL_LINE = {
  id: "line-1",
  line_no: 1,
  item_name_snapshot: "Cement",
  uom_code_snapshot: "BAG",
  uom_name_snapshot: "Bags",
  approved_quantity: "100.00",
  purchased_quantity: "60.00",
  outstanding_quantity: "40.00",
  allocated_quantity: "60.00",
  received_quantity: "55.00",
  discrepancy_quantity: "5.00",
  purchase_status: "PARTIALLY_PURCHASED",
};

function detail(overrides = {}) {
  return {
    ipo: {
      id: "ipo-1",
      ipo_number: "ESET/2026/32",
      status: "PURCHASING",
      department_name: "Civil",
      site_name: "Main Site",
      demand_id: "demand-1",
      demand_number: "DL-2026-000004",
      demand_revision: 1,
      generated_at: "2026-08-01T09:00:00.000Z",
      generated_by_name: "Test CEO",
      acknowledged_at: null,
      purchasing_closed_at: null,
      ...overrides.ipo,
    },
    lines: overrides.lines || [OPERATIONAL_LINE],
    auditLog: overrides.auditLog || [
      { id: "a1", action: "IPO_GENERATED", actor_name: "Test CEO", created_at: "2026-08-01T09:00:00.000Z" },
    ],
    deliveryChallans: overrides.deliveryChallans || [],
    receipts: overrides.receipts || [],
    includesCommercialData: overrides.includesCommercialData ?? false,
  };
}

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter>
        <IpoDetailPage />
      </MemoryRouter>,
    );
  });
}

describe("IpoDetailPage", () => {
  test("an operational viewer sees quantities but no commercial column, total or document button", async () => {
    mockPermissions = new Set(["ipo.view"]);
    mockUseIpo.mockReturnValue({ result: detail(), status: "ready", error: null, reload: vi.fn() });
    await renderPage();

    // Requested/approved/purchased/outstanding/delivered/received are all
    // separately visible — none is collapsed into another.
    expect(screen.getByText("100.00")).toBeTruthy();
    expect(screen.getByText("40.00")).toBeTruthy();
    expect(screen.getByText("55.00")).toBeTruthy();
    expect(screen.getByText("5.00")).toBeTruthy();

    expect(screen.queryByRole("columnheader", { name: "Estimated" })).toBeNull();
    expect(screen.queryByRole("columnheader", { name: "Actual" })).toBeNull();
    // The IPO PDF carries approved amounts, so it is not offered here at all.
    expect(screen.queryByRole("button", { name: /download ipo pdf/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /record purchase/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /cancel ipo/i })).toBeNull();
  });

  test("a commercially authorized viewer sees prices, the total and the document button", async () => {
    mockPermissions = new Set(["ipo.view", "procurement.view_prices"]);
    mockUseIpo.mockReturnValue({
      result: detail({
        includesCommercialData: true,
        ipo: { estimated_total: "5200.00" },
        lines: [{ ...OPERATIONAL_LINE, estimated_unit_price: "50.00", actual_unit_price: "48.25" }],
      }),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });
    await renderPage();

    expect(screen.getByText("Rs 5,200.00")).toBeTruthy();
    expect(screen.getByText("Rs 50.00")).toBeTruthy();
    expect(screen.getByText("Rs 48.25")).toBeTruthy();
    expect(screen.getByRole("button", { name: /download ipo pdf/i })).toBeTruthy();
  });

  test("purchasing, challan creation and cancellation each require their own capability", async () => {
    mockPermissions = new Set(["ipo.view", "procurement.purchase"]);
    mockUseIpo.mockReturnValue({ result: detail(), status: "ready", error: null, reload: vi.fn() });
    await renderPage();
    expect(screen.getByRole("button", { name: /record purchase/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /new delivery challan/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /cancel ipo/i })).toBeNull();

    cleanup();
    mockPermissions = new Set(["ipo.view", "dc.manage", "ipo.cancel"]);
    mockUseIpo.mockReturnValue({ result: detail(), status: "ready", error: null, reload: vi.fn() });
    await renderPage();
    expect(screen.getByRole("button", { name: /new delivery challan/i })).toBeTruthy();
    expect(screen.getByRole("button", { name: /cancel ipo/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /record purchase/i })).toBeNull();
  });

  test("purchasing is disabled once purchasing is closed, with the reason stated", async () => {
    mockPermissions = new Set(["ipo.view", "procurement.purchase"]);
    mockUseIpo.mockReturnValue({
      result: detail({ ipo: { purchasing_closed_at: "2026-08-10T09:00:00.000Z" } }),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });
    await renderPage();

    expect(screen.getByRole("button", { name: /record purchase/i }).disabled).toBe(true);
    expect(screen.getByText(/purchasing has been closed for this ipo/i)).toBeTruthy();
    expect(screen.getByText(/never purchased remains outstanding/i)).toBeTruthy();
  });

  test("the traceability chain shows challans, custody, handover and confirmation", async () => {
    mockPermissions = new Set(["ipo.view"]);
    mockUseIpo.mockReturnValue({
      result: detail({
        deliveryChallans: [
          {
            id: "dc-1",
            dc_number: "ESET-DC/2026/8",
            status: "COMPLETED",
            created_at: "2026-08-02T09:00:00.000Z",
            line_count: 1,
          },
        ],
        receipts: [
          {
            id: "r-1",
            dc_id: "dc-1",
            dc_number: "ESET-DC/2026/8",
            receipt_type: "ADMIN_FALLBACK",
            status: "COMPLETED",
            has_discrepancy: true,
            received_at: "2026-08-03T09:00:00.000Z",
            received_by_name: "Test Admin",
            physical_receiver_name: "Site Storekeeper",
            handover_to_name: "Test Employee",
            handover_at: "2026-08-03T12:00:00.000Z",
            confirmed_by_name: "Test Team Lead",
            confirmed_at: "2026-08-04T09:00:00.000Z",
          },
        ],
      }),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });
    await renderPage();

    expect(screen.getAllByText("ESET-DC/2026/8").length).toBeGreaterThan(0);
    // Admin custody and the eventual department recipient are both shown —
    // the original receiver is never replaced by the handover.
    expect(screen.getByText(/temporary admin custody by test admin/i)).toBeTruthy();
    expect(screen.getByText(/handed over to test employee/i)).toBeTruthy();
    expect(screen.getByText(/confirmed by test team lead/i)).toBeTruthy();
    // The badge, distinct from the "Discrepancy" quantity column header.
    expect(screen.getAllByText("Discrepancy").some((node) => node.tagName !== "TH")).toBe(true);
  });

  test("a completed IPO says the workflow is done, not that stock exists", async () => {
    mockPermissions = new Set(["ipo.view"]);
    mockUseIpo.mockReturnValue({
      result: detail({ ipo: { status: "COMPLETED", purchasing_closed_at: "2026-08-10T09:00:00.000Z" } }),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });
    await renderPage();
    expect(screen.getByText(/does not mean the material has been consumed/i)).toBeTruthy();
    expect(screen.queryByText(/current stock/i)).toBeNull();
  });

  test("the purchase panel records purchases only, never a free-priced correction", async () => {
    mockPermissions = new Set(["ipo.view", "procurement.purchase"]);
    mockUseIpo.mockReturnValue({ result: detail(), status: "ready", error: null, reload: vi.fn() });
    await renderPage();

    // A correction withdraws one specific earlier purchase at that purchase's
    // own price, so it cannot be expressed as a negative line here.
    expect(screen.queryByText(/negative quantity/i)).toBeNull();
    expect(screen.getByText(/reversal is recorded against the specific purchase/i)).toBeTruthy();
  });

  test("renders loading and error states", async () => {
    mockUseIpo.mockReturnValue({ result: null, status: "loading", error: null, reload: vi.fn() });
    await renderPage();
    expect(screen.getByText(/loading ipo/i)).toBeTruthy();

    cleanup();
    mockUseIpo.mockReturnValue({ result: null, status: "error", error: "IPO unavailable", reload: vi.fn() });
    await renderPage();
    expect(screen.getByText("IPO unavailable")).toBeTruthy();
  });
});
