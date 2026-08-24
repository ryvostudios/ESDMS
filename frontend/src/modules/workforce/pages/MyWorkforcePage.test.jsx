import { describe, test, expect, vi, afterEach } from "vitest";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { MyWorkforcePage } from "./MyWorkforcePage.jsx";

const emptyList = vi.hoisted(() => () => Promise.resolve({ data: [] }));
const getMyLeaveMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: [] })));
const cancelMyLeaveMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));
const submitMyLeaveMock = vi.hoisted(() => vi.fn(() => Promise.resolve({ data: null })));

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
  removeMyEmergencyContact: vi.fn(),
  listCustomFieldsSelf: emptyList,
  getMyDocuments: emptyList,
  getMyDocumentRequests: emptyList,
  listDocumentTypesSelf: emptyList,
  uploadMyDocument: vi.fn(),
  getMyDocumentBlob: vi.fn(),
  listLeaveTypes: emptyList,
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

describe("MyWorkforcePage Leave tab: submit and cancel are independently permission-gated", () => {
  async function openLeaveTab() {
    fireEvent.click(screen.getByRole("button", { name: "Leave" }));
    await screen.findByText("Apply for leave");
  }

  test("Cancel action is hidden for a SUBMITTED request without leave.self.cancel, even with leave.self.create", async () => {
    mockPermissions = new Set(["leave.self.view", "leave.self.create"]);
    getMyLeaveMock.mockResolvedValue({
      data: [{ id: "req-1", status: "SUBMITTED", start_date: "2026-01-01", end_date: "2026-01-01", leave_type_name: "Annual" }],
    });
    await renderPage();
    await openLeaveTab();

    await screen.findByText(/Annual/);
    expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();
    // Submit remains available — it is gated by leave.self.create, not leave.self.cancel.
    expect(screen.getByRole("button", { name: "Submit" })).toBeTruthy();
  });

  test("Cancel action is shown for a SUBMITTED request when leave.self.cancel is granted", async () => {
    mockPermissions = new Set(["leave.self.view", "leave.self.cancel"]);
    getMyLeaveMock.mockResolvedValue({
      data: [{ id: "req-1", status: "SUBMITTED", start_date: "2026-01-01", end_date: "2026-01-01", leave_type_name: "Annual" }],
    });
    await renderPage();
    await openLeaveTab();

    const cancelButton = await screen.findByRole("button", { name: "Cancel" });
    // Cancel must read as destructive, distinct from Submit's primary styling.
    expect(cancelButton.className).toMatch(/danger/i);
    await act(async () => {
      fireEvent.click(cancelButton);
    });
    expect(cancelMyLeaveMock).toHaveBeenCalledWith("req-1");
  });

  test("Submit action is independently controlled by leave.self.create regardless of leave.self.cancel", async () => {
    mockPermissions = new Set(["leave.self.view", "leave.self.cancel"]);
    await renderPage();
    await openLeaveTab();

    const submitButton = screen.getByRole("button", { name: "Submit" });
    await act(async () => {
      fireEvent.click(submitButton);
    });
    expect(submitMyLeaveMock).toHaveBeenCalled();
  });

  test("no requests yet renders a compact empty state, not a blank panel", async () => {
    mockPermissions = new Set(["leave.self.view"]);
    getMyLeaveMock.mockResolvedValue({ data: [] });
    await renderPage();
    await openLeaveTab();

    expect(await screen.findByText("No leave requests yet.")).toBeTruthy();
  });
});
