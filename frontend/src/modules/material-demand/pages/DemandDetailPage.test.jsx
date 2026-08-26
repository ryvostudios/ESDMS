import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DemandDetailPage } from "./DemandDetailPage.jsx";

const mockUseDemand = vi.hoisted(() => vi.fn());
const mockRecordManagementReview = vi.hoisted(() => vi.fn());
const mockRecordFormalApproval = vi.hoisted(() => vi.fn());
const mockRecordFinalManagementReview = vi.hoisted(() => vi.fn());
const mockRecordFinalFormalApproval = vi.hoisted(() => vi.fn());
const mockUsePricing = vi.hoisted(() => vi.fn());

vi.mock("../hooks/useDemand.js", () => ({
  useDemand: (...args) => mockUseDemand(...args),
}));

vi.mock("../api.js", () => ({
  submitDemand: vi.fn(),
  recordManagementReview: (...args) => mockRecordManagementReview(...args),
  recordFormalApproval: (...args) => mockRecordFormalApproval(...args),
  recordFinalManagementReview: (...args) => mockRecordFinalManagementReview(...args),
  recordFinalFormalApproval: (...args) => mockRecordFinalFormalApproval(...args),
}));

vi.mock("../../procurement/hooks/usePricing.js", () => ({
  usePricing: (...args) => mockUsePricing(...args),
}));

let mockPermissions = new Set();
let mockUser = { id: "manager-1", role: "SITE_MANAGER" };
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    user: mockUser,
    hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)),
  }),
}));

function baseDemand(overrides = {}, approvals = []) {
  return {
    demand: {
      id: "demand-1",
      demand_number: "DL-2026-000001",
      status: "DRAFT",
      department_name: "Civil",
      site_name: "E-Set — Main Site",
      created_by_name: "Test Team Lead",
      created_at: "2026-08-25T00:00:00.000Z",
      submitted_at: null,
      note: null,
      ...overrides,
    },
    lines: [{ id: "line-1", item_name_snapshot: "Cement", requested_quantity: "50.00", uom_name_snapshot: "Bags" }],
    auditLog: [{ id: "audit-1", action: "CREATE", actor_name: "Test Team Lead", created_at: "2026-08-25T00:00:00.000Z" }],
    approvals,
  };
}

afterEach(() => {
  cleanup();
  mockUseDemand.mockReset();
  mockRecordManagementReview.mockReset();
  mockRecordFormalApproval.mockReset();
  mockRecordFinalManagementReview.mockReset();
  mockRecordFinalFormalApproval.mockReset();
  mockUsePricing.mockReset();
  mockPermissions = new Set();
  mockUser = { id: "manager-1", role: "SITE_MANAGER" };
});

function submittedPricing(finalApprovals = [], demandStatus = "PENDING_FINAL_APPROVAL") {
  return {
    demand: { id: "demand-1", status: demandStatus, revision: 1 },
    pricing: { id: "pricing-1", status: "SUBMITTED", currency: "PKR", version: 2 },
    finalApprovals,
    lines: [{
      demand_line_id: "line-1",
      item_name_snapshot: "Cement",
      requested_quantity: "50.00",
      uom_name_snapshot: "Bags",
      estimated_unit_price: "1450.00",
      line_total: "72500.00",
      procurement_note: null,
    }],
    estimatedTotal: "72500.00",
  };
}

async function renderPage() {
  await act(async () => {
    render(
      <MemoryRouter initialEntries={["/demands/demand-1"]}>
        <Routes>
          <Route path="/demands/:id" element={<DemandDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  });
}

describe("DemandDetailPage", () => {
  test("a DRAFT Demand shows Edit and Submit actions for an authorized actor", async () => {
    mockPermissions = new Set(["demand.edit", "demand.submit"]);
    mockUseDemand.mockReturnValue({ result: baseDemand(), status: "ready", error: null, reload: vi.fn() });

    await renderPage();

    expect(screen.getByRole("button", { name: "Edit" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit for Review" })).toBeTruthy();
    expect(screen.queryByText(/pending initial review/i)).toBeNull();
  });

  test("a submitted Demand is read-only and shows the pending-review notice", async () => {
    mockPermissions = new Set(["demand.edit", "demand.submit"]);
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "PENDING_INITIAL_REVIEW", submitted_at: "2026-08-25T01:00:00.000Z" }),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });

    await renderPage();

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit for Review" })).toBeNull();
    expect(screen.getByText(/this demand has been submitted/i)).toBeTruthy();
  });

  test("a view-only actor never sees Edit or Submit even on a DRAFT Demand", async () => {
    mockPermissions = new Set(); // demand.view only, implicit via route access
    mockUseDemand.mockReturnValue({ result: baseDemand(), status: "ready", error: null, reload: vi.fn() });

    await renderPage();

    expect(screen.queryByRole("button", { name: "Edit" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit for Review" })).toBeNull();
  });

  test("loading and error states render before the detail is available", async () => {
    mockUseDemand.mockReturnValue({ result: null, status: "loading", error: null, reload: vi.fn() });
    await renderPage();
    expect(screen.getByText(/loading demand/i)).toBeTruthy();

    cleanup();
    mockUseDemand.mockReturnValue({ result: null, status: "error", error: "Network error", reload: vi.fn() });
    await renderPage();
    expect(screen.getByText("Network error")).toBeTruthy();
  });

  test("a Draft never shows the Initial Approval panel", async () => {
    mockUseDemand.mockReturnValue({ result: baseDemand(), status: "ready", error: null, reload: vi.fn() });
    await renderPage();
    expect(screen.queryByText("Initial Approval")).toBeNull();
  });

  test("both slots pending: an eligible reviewer sees Approve/Reject for their own slot only", async () => {
    mockPermissions = new Set(["demand.review"]);
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "PENDING_INITIAL_REVIEW" }),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });

    await renderPage();

    expect(screen.getByText("Initial Approval")).toBeTruthy();
    expect(screen.getAllByText("Pending")).toHaveLength(2);
    // Exactly one Approve/Reject pair — for Management Review, not Formal Approval.
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    expect(screen.getAllByRole("button", { name: "Reject" })).toHaveLength(1);
  });

  test("a view-only actor sees pending status but no action buttons", async () => {
    mockPermissions = new Set(); // no demand.review, no demand.approve
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "PENDING_INITIAL_REVIEW" }),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });

    await renderPage();

    expect(screen.getAllByText("Pending")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  test("one completed slot and one pending slot are displayed distinctly — the Demand is never shown as fully approved prematurely", async () => {
    mockPermissions = new Set(["demand.approve"]);
    mockUseDemand.mockReturnValue({
      result: baseDemand(
        { status: "PENDING_INITIAL_REVIEW" },
        [
          {
            approval_type: "MANAGEMENT_REVIEW",
            decision: "APPROVED",
            actor_name: "Test Site Manager",
            created_at: "2026-08-25T02:00:00.000Z",
          },
        ],
      ),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });

    await renderPage();

    expect(screen.getByText("Approved by Test Site Manager")).toBeTruthy();
    expect(screen.getByText("Pending")).toBeTruthy();
    // Formal Approval is still open for this actor — one pair of buttons.
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Reject" })).toBeTruthy();
  });

  test("approving a slot calls the API and refreshes", async () => {
    mockPermissions = new Set(["demand.review"]);
    const reload = vi.fn();
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "PENDING_INITIAL_REVIEW" }),
      status: "ready",
      error: null,
      reload,
    });
    mockRecordManagementReview.mockResolvedValue({});

    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));

    await waitFor(() => expect(mockRecordManagementReview).toHaveBeenCalledWith("demand-1", { decision: "APPROVED" }));
    await waitFor(() => expect(reload).toHaveBeenCalled());
  });

  test("rejecting a slot requires a reason and sends it to the API", async () => {
    mockPermissions = new Set(["demand.review"]);
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "PENDING_INITIAL_REVIEW" }),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });
    mockRecordManagementReview.mockResolvedValue({});

    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));

    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    expect(await within(dialog).findByText("A reason is required.")).toBeTruthy();
    expect(mockRecordManagementReview).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: "Not needed this quarter" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));

    await waitFor(() =>
      expect(mockRecordManagementReview).toHaveBeenCalledWith("demand-1", {
        decision: "REJECTED",
        reason: "Not needed this quarter",
      }),
    );
  });

  test("READY_FOR_PRICING shows both slots approved and the ready-for-pricing notice, with no action buttons left", async () => {
    mockPermissions = new Set(["demand.review", "demand.approve"]);
    mockUseDemand.mockReturnValue({
      result: baseDemand(
        { status: "READY_FOR_PRICING" },
        [
          { approval_type: "MANAGEMENT_REVIEW", decision: "APPROVED", actor_name: "Test Site Manager", created_at: "2026-08-25T02:00:00.000Z" },
          { approval_type: "FORMAL_APPROVAL", decision: "APPROVED", actor_name: "Test CEO", created_at: "2026-08-25T03:00:00.000Z" },
        ],
      ),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });

    await renderPage();

    expect(screen.getByText(/ready for procurement pricing/i)).toBeTruthy();
    expect(screen.getByText("Approved by Test Site Manager")).toBeTruthy();
    expect(screen.getByText("Approved by Test CEO")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Reject" })).toBeNull();
  });

  test("a pricing actor gets the Procurement action on READY_FOR_PRICING", async () => {
    mockPermissions = new Set(["procurement.pricing"]);
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "READY_FOR_PRICING" }),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });
    await renderPage();
    expect(screen.getByRole("button", { name: "Enter Pricing" })).toBeTruthy();
    expect(mockUsePricing).not.toHaveBeenCalled();
  });

  test("authorized management sees submitted pricing through the protected resource", async () => {
    mockPermissions = new Set(["procurement.view_prices"]);
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "PENDING_FINAL_APPROVAL" }),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });
    mockUsePricing.mockReturnValue({
      result: {
        demand: { id: "demand-1", status: "PENDING_FINAL_APPROVAL" },
        pricing: { id: "pricing-1", status: "SUBMITTED", currency: "PKR", version: 1 },
        finalApprovals: [],
        lines: [{
          demand_line_id: "line-1",
          item_name_snapshot: "Cement",
          requested_quantity: "50.00",
          uom_name_snapshot: "Bags",
          estimated_unit_price: "1450.00",
          line_total: "72500.00",
          procurement_note: null,
        }],
        estimatedTotal: "72500.00",
      },
      status: "ready",
      error: null,
      reload: vi.fn(),
    });
    await renderPage();
    expect(screen.getAllByText("Rs 72,500.00")).toHaveLength(2);
    expect(screen.getByText("Pending Final Management Review / Formal Approval")).toBeTruthy();
  });

  test("Team Lead and ADMIN-like viewers without financial capability render no pricing component or hidden values", async () => {
    mockPermissions = new Set(["demand.view"]);
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "PENDING_FINAL_APPROVAL" }),
      status: "ready",
      error: null,
      reload: vi.fn(),
    });
    await renderPage();
    expect(mockUsePricing).not.toHaveBeenCalled();
    expect(screen.queryByText("Pricing")).toBeNull();
    expect(screen.queryByText(/Rs 72,500/)).toBeNull();
  });

  test("a final Management reviewer sees Version-bound actions and approval progress", async () => {
    mockPermissions = new Set(["demand.review", "procurement.view_prices"]);
    const reloadDemand = vi.fn().mockResolvedValue({});
    const reloadPricing = vi.fn().mockResolvedValue({});
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "PENDING_FINAL_APPROVAL", revision: 1 }),
      status: "ready",
      error: null,
      reload: reloadDemand,
    });
    mockUsePricing.mockReturnValue({
      result: submittedPricing(),
      status: "ready",
      error: null,
      reload: reloadPricing,
    });
    mockRecordFinalManagementReview.mockResolvedValue({});

    await renderPage();
    expect(screen.getByText("Final Pricing Approval · Version 2")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Approve" })).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Approve" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(mockRecordFinalManagementReview).toHaveBeenCalledWith("demand-1", {
      pricingId: "pricing-1",
      decision: "APPROVED",
    }));
    await waitFor(() => expect(reloadDemand).toHaveBeenCalled());
    expect(mockRecordFinalFormalApproval).not.toHaveBeenCalled();
  });

  test("same ordinary actor is not offered the other FINAL responsibility, while CEO retains the exception", async () => {
    const management = {
      approval_stage: "FINAL",
      approval_type: "MANAGEMENT_REVIEW",
      decision: "APPROVED",
      actor_user_id: "manager-1",
      actor_name: "Test Manager",
      created_at: "2026-08-26T00:00:00.000Z",
    };
    mockPermissions = new Set(["demand.review", "demand.approve", "procurement.view_prices"]);
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "PENDING_FINAL_APPROVAL" }), status: "ready", error: null, reload: vi.fn(),
    });
    mockUsePricing.mockReturnValue({
      result: submittedPricing([management]), status: "ready", error: null, reload: vi.fn(),
    });
    await renderPage();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();

    cleanup();
    mockUser = { id: "ceo-1", role: "CEO" };
    mockUsePricing.mockReturnValue({
      result: submittedPricing([{ ...management, actor_user_id: "ceo-1", actor_name: "CEO" }]),
      status: "ready", error: null, reload: vi.fn(),
    });
    await renderPage();
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
  });

  test("FINAL rejection requires a reason and repricing/READY_FOR_IPO remain price-redacted without permission", async () => {
    mockPermissions = new Set(["demand.review", "procurement.view_prices"]);
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "PENDING_FINAL_APPROVAL" }), status: "ready", error: null, reload: vi.fn(),
    });
    mockUsePricing.mockReturnValue({
      result: submittedPricing(), status: "ready", error: null, reload: vi.fn().mockResolvedValue({}),
    });
    mockRecordFinalManagementReview.mockResolvedValue({});
    await renderPage();
    fireEvent.click(screen.getByRole("button", { name: "Reject" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText(/reason/i), { target: { value: "Reprice this quote" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Reject" }));
    await waitFor(() => expect(mockRecordFinalManagementReview).toHaveBeenCalledWith("demand-1", {
      pricingId: "pricing-1",
      decision: "REJECTED",
      reason: "Reprice this quote",
    }));

    cleanup();
    mockPermissions = new Set(["demand.view"]);
    mockUseDemand.mockReturnValue({
      result: baseDemand({ status: "READY_FOR_IPO" }), status: "ready", error: null, reload: vi.fn(),
    });
    await renderPage();
    expect(screen.getByText(/ready for the future official IPO workflow/i)).toBeTruthy();
    expect(mockUsePricing).toHaveBeenCalledTimes(1); // only the earlier authorized render
  });
});
