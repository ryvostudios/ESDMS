// P4-3. A DRAFT Demand List could not be removed at all — there was no
// control and no endpoint — so an erroneous or test draft stayed forever.
// Deletion is deliberately DRAFT-only; everything past submission keeps its
// history and is closed out through the review/rejection lifecycle.
import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { DemandDetailPage } from "./DemandDetailPage.jsx";

const mockUseDemand = vi.hoisted(() => vi.fn());
const mockDeleteDraftDemand = vi.hoisted(() => vi.fn());
const mockUsePricing = vi.hoisted(() => vi.fn());
const mockNavigate = vi.hoisted(() => vi.fn());

vi.mock("../hooks/useDemand.js", () => ({ useDemand: (...args) => mockUseDemand(...args) }));
vi.mock("../../procurement/hooks/usePricing.js", () => ({ usePricing: (...args) => mockUsePricing(...args) }));
vi.mock("../api.js", () => ({
  submitDemand: vi.fn(),
  recordManagementReview: vi.fn(),
  recordFormalApproval: vi.fn(),
  recordFinalManagementReview: vi.fn(),
  recordFinalFormalApproval: vi.fn(),
  deleteDraftDemand: (...args) => mockDeleteDraftDemand(...args),
  getDemandPdf: vi.fn(),
}));
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return { ...actual, useNavigate: () => mockNavigate };
});

let mockPermissions = new Set();
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    user: { id: "lead-1", role: "TEAM_LEAD" },
    hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)),
  }),
}));

const ApiError = (await import("../../../core/api/client.js")).ApiError;

function demandResult(status, draftDeleteEligible) {
  return {
    demand: {
      id: "demand-1",
      draft_delete_eligible: draftDeleteEligible,
      demand_number: "DL-2026-000001",
      status,
      department_name: "Civil",
      site_name: "E-Set — Main Site",
      created_by_name: "Test Team Lead",
      created_at: "2026-08-25T00:00:00.000Z",
      submitted_at: null,
      note: null,
    },
    lines: [{ id: "line-1", item_name_snapshot: "Cement", requested_quantity: "50.00", uom_name_snapshot: "Bags" }],
    auditLog: [{ id: "audit-1", action: "CREATE", actor_name: "Test Team Lead", created_at: "2026-08-25T00:00:00.000Z" }],
    approvals: [],
  };
}

afterEach(() => {
  cleanup();
  mockUseDemand.mockReset();
  mockDeleteDraftDemand.mockReset();
  mockUsePricing.mockReset();
  mockNavigate.mockReset();
  mockPermissions = new Set();
});

// `...rest` rather than a default parameter, so a test can pass an explicit
// `undefined` (the "server omitted the field" case) without it being replaced
// by the default.
async function renderDetail(status = "DRAFT", ...rest) {
  const draftDeleteEligible = rest.length > 0 ? rest[0] : true;
  mockUseDemand.mockReturnValue({
    status: "ready",
    error: null,
    result: demandResult(status, draftDeleteEligible),
    reload: vi.fn(() => Promise.resolve()),
  });
  mockUsePricing.mockReturnValue({ status: "idle", error: null, result: null, reload: vi.fn() });

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

describe("Delete Draft", () => {
  test("is offered on a DRAFT to a holder of demand.delete_draft", async () => {
    mockPermissions = new Set(["demand.delete_draft"]);
    await renderDetail("DRAFT");
    expect(screen.getByRole("button", { name: "Delete Draft" })).toBeTruthy();
  });

  test("is never offered once the Demand has left DRAFT", async () => {
    mockPermissions = new Set(["demand.delete_draft"]);
    for (const status of [
      "PENDING_INITIAL_REVIEW",
      "READY_FOR_PRICING",
      "PENDING_FINAL_APPROVAL",
      "READY_FOR_IPO",
      "IPO_GENERATED",
      "COMPLETED",
      "REJECTED",
    ]) {
      await renderDetail(status);
      expect(screen.queryByRole("button", { name: "Delete Draft" })).toBeNull();
      cleanup();
    }
  });

  test("is not offered on a DRAFT the server marks ineligible for deletion", async () => {
    // A Demand predating the protected lifecycle. Eligibility comes from the
    // server; the page never tries to work it out from status or history.
    mockPermissions = new Set(["demand.delete_draft"]);
    await renderDetail("DRAFT", false);
    expect(screen.queryByRole("button", { name: "Delete Draft" })).toBeNull();
  });

  test("fails closed when the server omits the eligibility field entirely", async () => {
    // An older or partial API response. The destructive control must be
    // withheld rather than offered on an assumption the server would refuse.
    mockPermissions = new Set(["demand.delete_draft"]);
    await renderDetail("DRAFT", undefined);
    expect(screen.queryByRole("button", { name: "Delete Draft" })).toBeNull();
  });

  test("is offered only on an explicit true", async () => {
    mockPermissions = new Set(["demand.delete_draft"]);
    for (const [value, expected] of [
      [true, true],
      [false, false],
      [undefined, false],
      [null, false],
      ["true", false],
    ]) {
      await renderDetail("DRAFT", value);
      const present = screen.queryByRole("button", { name: "Delete Draft" }) !== null;
      expect(present).toBe(expected);
      cleanup();
    }
  });

  test("is not offered without the capability, even on a DRAFT", async () => {
    mockPermissions = new Set(["demand.edit", "demand.submit"]);
    await renderDetail("DRAFT");
    expect(screen.queryByRole("button", { name: "Delete Draft" })).toBeNull();
  });

  test("asks for confirmation and deletes nothing if cancelled", async () => {
    mockPermissions = new Set(["demand.delete_draft"]);
    await renderDetail("DRAFT");

    fireEvent.click(screen.getByRole("button", { name: "Delete Draft" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/cannot be undone/i)).toBeTruthy();
    expect(mockDeleteDraftDemand).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(mockDeleteDraftDemand).not.toHaveBeenCalled();
  });

  test("confirming deletes, returns to the list, and reports success", async () => {
    mockPermissions = new Set(["demand.delete_draft"]);
    mockDeleteDraftDemand.mockResolvedValue(null);
    await renderDetail("DRAFT");

    fireEvent.click(screen.getByRole("button", { name: "Delete Draft" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete Draft" }));
    });

    await waitFor(() => expect(mockDeleteDraftDemand).toHaveBeenCalledWith("demand-1"));
    expect(mockNavigate).toHaveBeenCalledWith("/demands", {
      replace: true,
      state: { flash: "DL-2026-000001 was deleted." },
    });
  });

  test("a concurrent submit is reported with the server's own reason, and no navigation happens", async () => {
    mockPermissions = new Set(["demand.delete_draft"]);
    mockDeleteDraftDemand.mockRejectedValue(
      new ApiError(409, "CONFLICT", "Cannot delete a Demand currently in PENDING_INITIAL_REVIEW state. Only a DRAFT can be deleted."),
    );
    await renderDetail("DRAFT");

    fireEvent.click(screen.getByRole("button", { name: "Delete Draft" }));
    const dialog = await screen.findByRole("dialog");
    await act(async () => {
      fireEvent.click(within(dialog).getByRole("button", { name: "Delete Draft" }));
    });

    expect(await screen.findByText(/Only a DRAFT can be deleted/)).toBeTruthy();
    expect(mockNavigate).not.toHaveBeenCalled();
  });
});
