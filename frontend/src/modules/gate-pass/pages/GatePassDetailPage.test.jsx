import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { GatePassDetailPage } from "./GatePassDetailPage.jsx";

const baseGatePass = {
  id: "gp-1",
  gatePassNumber: "ESD-2026-000001",
  status: "APPROVED",
  createdAt: "2026-01-01T00:00:00.000Z",
  issuingDepartmentName: "Electrical",
  requestedBy: "Test Requester",
  destination: "Site B",
  purpose: "SAMPLE",
  driverName: "Test Driver",
  driverPhone: "+923001234567",
  vehicleRegistration: "TST-001",
  jobOrderId: null,
  expectedReturnDate: null,
  createdByName: "Test Creator",
  approvedByName: null,
  remarks: null,
  rejectionReason: null,
  cancellationReason: null,
  documentReady: true,
  departureOdometer: null,
  returnOdometer: null,
  departureAt: null,
  returnAt: null,
  distanceKm: null,
  returnRemarks: null,
  departureEvidence: null,
  returnEvidence: null,
  items: [{ id: "item-1", description: "Bearing", partNumber: "PN-1", quantity: 2, unit: "pcs" }],
  auditLog: [{ id: "audit-1", action: "CREATE", actorName: "Test Creator", createdAt: "2026-01-01T00:00:00.000Z", metadata: {} }],
};

vi.mock("react-router-dom", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, useParams: () => ({ id: "gp-1" }), useNavigate: () => vi.fn() };
});

vi.mock("../hooks/useGatePass.js", () => ({
  useGatePass: () => ({ gatePass: baseGatePass, status: "ready", error: null, reload: vi.fn() }),
}));

vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({ hasPermission: () => false }),
}));

vi.mock("../api.js", () => ({
  submitGatePass: vi.fn(),
  approveGatePass: vi.fn(),
  rejectGatePass: vi.fn(),
  cancelGatePass: vi.fn(),
  downloadGatePassPdf: vi.fn(),
  downloadGatePassFile: vi.fn(),
}));

afterEach(() => {
  cleanup();
});

async function renderPage() {
  let result;
  await act(async () => {
    result = render(
      <MemoryRouter>
        <GatePassDetailPage />
      </MemoryRouter>,
    );
  });
  return result;
}

// ADV-PRE-01: the Items table's own overflow-x:auto only contains its
// scroll if the grid item wrapping it (not a deeper descendant) can
// itself shrink to the grid track — otherwise its min-content width
// (driven by .itemsTable's min-width) pushes the whole page wider than
// the viewport. This is a structural regression guard for the class that
// carries that min-width:0; the actual rendered-overflow measurement is
// verified separately in a real browser (jsdom does not lay out CSS).
describe("GatePassDetailPage layout — direct grid children stay shrinkable", () => {
  test("the main column (left grid item) carries a class applying min-width:0, not just its .section descendants", async () => {
    const { container } = await renderPage();

    const mainColumn = container.querySelector('[class*="mainColumn"]');
    expect(mainColumn).toBeTruthy();

    // It must be a DIRECT child of the grid layout container, not nested
    // further — min-width:0 only fixes shrinkability when applied to the
    // actual grid item.
    const layout = container.querySelector('[class*="layout"]');
    expect(layout).toBeTruthy();
    expect(Array.from(layout.children)).toContain(mainColumn);
  });

  test("the Items table keeps its own contained horizontal scroller", async () => {
    const { container } = await renderPage();

    const tableWrapper = container.querySelector('[class*="tableWrapper"]');
    expect(tableWrapper).toBeTruthy();
    expect(tableWrapper.querySelector('[class*="itemsTable"]')).toBeTruthy();
  });
});
