import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MyWorkforcePage } from "./MyWorkforcePage.jsx";
import { ApiError } from "../../../core/api/client.js";

const emptyList = vi.hoisted(() => () => Promise.resolve({ data: [] }));
const getMyLeaveMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));
const cancelMyLeaveMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));
const submitMyLeaveMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));
const listLeaveTypesMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [{ id: "type-1", name: "Annual" }] })));

vi.mock("../api.js", () => ({
  getMyProfile: () =>
    Promise.resolve({
      data: {
        completion: { percent: 50, missingCoreFields: [], missingCustomFields: [] },
        personalDetails: {},
        emergencyContacts: [],
        customFieldValues: [],
        employee: { full_legal_name: "Test Employee", employee_code: "EMP-1", status: "ACTIVE" },
      },
    }),
  getMyPhotoBlob: vi.fn(() => Promise.reject(new Error("No photo"))),
  removeMyEmergencyContact: vi.fn(),
  listCustomFieldsSelf: emptyList,
  getMyDocuments: emptyList,
  getMyDocumentRequests: emptyList,
  listDocumentTypesSelf: emptyList,
  uploadMyDocument: vi.fn(),
  getMyDocumentBlob: vi.fn(),
  listLeaveTypes: listLeaveTypesMock,
  getMyLeave: getMyLeaveMock,
  submitMyLeave: submitMyLeaveMock,
  cancelMyLeave: cancelMyLeaveMock,
  getMyCompensation: () => Promise.resolve({ data: null }),
  getMyRotation: () => Promise.resolve({ data: null }),
  getMyContracts: emptyList,
  getMyContractBlob: vi.fn(),
}));

let mockUser = { employeeId: "employee-1" };
let mockPermissions = new Set();
vi.mock("../../../core/auth/AuthContext.jsx", () => ({
  useAuth: () => ({
    user: mockUser,
    hasPermission: (...codes) => codes.some((code) => mockPermissions.has(code)),
  }),
}));

afterEach(() => {
  cleanup();
  mockUser = { employeeId: "employee-1" };
  mockPermissions = new Set();
  getMyLeaveMock.mockReset().mockResolvedValue({ data: [] });
  cancelMyLeaveMock.mockReset().mockResolvedValue({ data: null });
  submitMyLeaveMock.mockReset().mockResolvedValue({ data: null });
  listLeaveTypesMock.mockReset().mockResolvedValue({ data: [{ id: "type-1", name: "Annual" }] });
});

async function renderPage() {
  await act(async () => {
    render(<MyWorkforcePage />);
  });
}

describe("MyWorkforcePage self-service capability decoupling (ESDMS-018)", () => {
  test("only profile.self.view -> Profile tab is accessible", async () => {
    mockPermissions = new Set(["profile.self.view"]);
    await renderPage();

    expect(screen.getByRole("button", { name: "Profile" })).toBeTruthy();
    expect(screen.getByText(/profile 50% complete/i)).toBeTruthy();
  });

  test("leave capability without profile.self.view -> My Workforce and Leave are accessible", async () => {
    mockPermissions = new Set(["leave.self.view"]);
    await renderPage();

    expect(screen.queryByText(/my workforce unavailable/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Leave" })).toBeTruthy();
  });

  test("document capability without profile.self.view -> My Workforce and Documents are accessible", async () => {
    mockPermissions = new Set(); // Documents needs no permission at all, just identity.
    await renderPage();

    expect(screen.queryByText(/my workforce unavailable/i)).toBeNull();
    expect(screen.getByRole("button", { name: "Documents" })).toBeTruthy();
  });

  test("unauthorized Profile remains hidden", async () => {
    mockPermissions = new Set(["leave.self.view"]);
    await renderPage();

    expect(screen.queryByRole("button", { name: "Profile" })).toBeNull();
  });

  test("only authorized child items are shown (Profile and Leave both denied)", async () => {
    mockPermissions = new Set();
    await renderPage();

    expect(screen.queryByRole("button", { name: "Profile" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Leave" })).toBeNull();
    expect(screen.getByRole("button", { name: "Documents" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Rotation" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Contracts" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Compensation" })).toBeTruthy();
  });

  test("no linked Employee record -> My Workforce is unavailable", async () => {
    mockUser = { employeeId: null };
    mockPermissions = new Set(["profile.self.view"]);
    await renderPage();

    expect(screen.getByText(/my workforce unavailable/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Profile" })).toBeNull();
  });

  test("default landing chooses an authorized child instead of forcing Profile", async () => {
    mockPermissions = new Set(["leave.self.view"]); // no profile.self.view
    await renderPage();

    // Documents precedes Leave in tab order and needs no permission, so it
    // is the default landing tab — its content renders without clicking
    // anything, and no Profile-loading/error state blocks it.
    expect(screen.getByText("My documents")).toBeTruthy();
  });
});

// ADV-P1-03: leave.self.view / leave.self.create / leave.self.cancel are
// three independent capabilities. "Apply for leave" only exists for a
// create-capable user, so — unlike the old helper — this must not assume
// it's present; "My requests" is the one heading every combination below
// renders.
describe("MyWorkforcePage Leave tab: view/create/cancel are independently permission-gated", () => {
  async function openLeaveTab() {
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await screen.findByText("My requests");
  }

  // "Annual" is deliberately reserved for the mocked leave-TYPE option (in
  // the Apply form's Select) — a past REQUEST uses a different name so the
  // two never collide in a text query when both render together.
  const oneRequest = (status = "SUBMITTED") => ({
    data: [{ id: "req-1", status, start_date: "2026-01-01", end_date: "2026-01-01", leave_type_name: "Sick Leave" }],
  });

  test("1. view only: history loads, no leave-types request, no Apply form, no Submit", async () => {
    mockPermissions = new Set(["leave.self.view"]);
    getMyLeaveMock.mockResolvedValue(oneRequest("APPROVED"));
    await renderPage();
    await openLeaveTab();

    await screen.findByText(/Sick Leave/);
    expect(listLeaveTypesMock).not.toHaveBeenCalled();
    expect(screen.queryByText("Apply for leave")).toBeNull();
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
  });

  test("2. view + create: history loads, leave types load, Apply form and Submit are visible", async () => {
    mockPermissions = new Set(["leave.self.view", "leave.self.create"]);
    getMyLeaveMock.mockResolvedValue(oneRequest("APPROVED"));
    await renderPage();
    await openLeaveTab();

    await screen.findByText(/Sick Leave/);
    expect(listLeaveTypesMock).toHaveBeenCalled();
    expect(screen.getByText("Apply for leave")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
  });

  test("3. view + cancel, without create: history loads, cancellable request shows Cancel, no Submit, no leave-types request", async () => {
    mockPermissions = new Set(["leave.self.view", "leave.self.cancel"]);
    getMyLeaveMock.mockResolvedValue(oneRequest("SUBMITTED"));
    await renderPage();
    await openLeaveTab();

    const cancelButton = await screen.findByRole("button", { name: "Cancel" });
    // Cancel must read as destructive, distinct from Submit's primary styling.
    expect(cancelButton.className).toMatch(/danger/i);
    expect(screen.queryByRole("button", { name: "Submit" })).toBeNull();
    expect(listLeaveTypesMock).not.toHaveBeenCalled();

    await act(async () => {
      fireEvent.click(cancelButton);
    });
    expect(cancelMyLeaveMock).toHaveBeenCalledWith("req-1");
  });

  test("4. view + create, without cancel: Submit is visible, Cancel is hidden", async () => {
    mockPermissions = new Set(["leave.self.view", "leave.self.create"]);
    getMyLeaveMock.mockResolvedValue(oneRequest("SUBMITTED"));
    await renderPage();
    await openLeaveTab();

    await screen.findByText(/Sick Leave/);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    const submitButton = screen.getByRole("button", { name: "Submit" });
    await act(async () => {
      fireEvent.click(submitButton);
    });
    expect(submitMyLeaveMock).toHaveBeenCalled();
  });

  test("5. leave.self.create explicitly denied (effective permission absent): viewing still works, create UI unavailable", async () => {
    // The frontend only ever sees the resulting effective-permission set —
    // an explicit DENY override and simply never holding the permission
    // are indistinguishable here, and must behave identically.
    mockPermissions = new Set(["leave.self.view"]);
    getMyLeaveMock.mockResolvedValue(oneRequest("APPROVED"));
    await renderPage();
    await openLeaveTab();

    await screen.findByText(/Sick Leave/);
    expect(screen.queryByText("Apply for leave")).toBeNull();
    expect(listLeaveTypesMock).not.toHaveBeenCalled();
  });

  test("6. a genuine backend error loading leave types (despite holding leave.self.create) is surfaced, not silently swallowed", async () => {
    mockPermissions = new Set(["leave.self.view", "leave.self.create"]);
    listLeaveTypesMock.mockRejectedValueOnce(new ApiError(500, "INTERNAL", "Leave types unavailable."));
    await renderPage();
    await openLeaveTab();

    expect(await screen.findByText("Leave types unavailable.")).toBeTruthy();
  });

  test("no requests yet renders a compact empty state, not a blank panel", async () => {
    mockPermissions = new Set(["leave.self.view"]);
    getMyLeaveMock.mockResolvedValue({ data: [] });
    await renderPage();
    await openLeaveTab();

    expect(await screen.findByText("No leave requests yet.")).toBeTruthy();
  });
});
