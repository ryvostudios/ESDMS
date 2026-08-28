// P4-1 regression. The Demand material picker used to request pageSize=200
// against a server that caps it at 100, so every picker load returned 400
// and no material could be selected at all. These tests stand a fake server
// in for apiClient that enforces the SAME cap the backend does, so the
// contract is exercised rather than assumed — mocking listCatalog wholesale
// is exactly what let the original defect through.
import { describe, test, expect, vi, beforeEach } from "vitest";

const mockGet = vi.hoisted(() => vi.fn());
vi.mock("../../core/api/client.js", async () => {
  const actual = await vi.importActual("../../core/api/client.js");
  return { ...actual, apiClient: { get: (...args) => mockGet(...args) } };
});

const { listAllCatalog, CATALOG_MAX_PAGE_SIZE } = await import("./api.js");
const { ApiError } = await import("../../core/api/client.js");

const SERVER_MAX_PAGE_SIZE = 100; // material-catalog.validation.js

// Mimics GET /material-catalog: rejects pageSize > 100 the way the real
// endpoint does, and pages a fixed dataset otherwise.
function fakeServer(totalRows) {
  const rows = Array.from({ length: totalRows }, (_, index) => ({ id: `entry-${index + 1}` }));
  return (path) => {
    const query = new URLSearchParams(path.split("?")[1] ?? "");
    const pageSize = Number(query.get("pageSize") ?? 50);
    const page = Number(query.get("page") ?? 1);

    if (pageSize > SERVER_MAX_PAGE_SIZE) {
      return Promise.reject(
        new ApiError(400, "VALIDATION_ERROR", "Invalid request.", {
          formErrors: [],
          fieldErrors: { pageSize: ["Too big: expected number to be <=100"] },
        }),
      );
    }

    const start = (page - 1) * pageSize;
    return Promise.resolve({
      data: rows.slice(start, start + pageSize),
      meta: { page, pageSize, total: rows.length },
    });
  };
}

beforeEach(() => {
  mockGet.mockReset();
});

describe("listAllCatalog honours the server's page-size cap", () => {
  test("never requests more than the server accepts", async () => {
    mockGet.mockImplementation(fakeServer(12));
    await listAllCatalog({ departmentId: "dept-civil" });

    expect(CATALOG_MAX_PAGE_SIZE).toBeLessThanOrEqual(SERVER_MAX_PAGE_SIZE);
    for (const [path] of mockGet.mock.calls) {
      const pageSize = Number(new URLSearchParams(path.split("?")[1]).get("pageSize"));
      expect(pageSize).toBeLessThanOrEqual(SERVER_MAX_PAGE_SIZE);
    }
  });

  test("a small catalog is fetched in a single request", async () => {
    mockGet.mockImplementation(fakeServer(12));
    const result = await listAllCatalog({ departmentId: "dept-civil" });

    expect(mockGet).toHaveBeenCalledTimes(1);
    expect(result.data).toHaveLength(12);
    expect(result.meta.truncated).toBe(false);
  });

  test("a catalog larger than one page is fully returned, not silently truncated", async () => {
    mockGet.mockImplementation(fakeServer(237));
    const result = await listAllCatalog({ departmentId: "dept-civil" });

    expect(result.data).toHaveLength(237);
    expect(new Set(result.data.map((row) => row.id)).size).toBe(237);
    expect(result.meta.total).toBe(237);
    expect(result.meta.truncated).toBe(false);
    expect(mockGet).toHaveBeenCalledTimes(3); // 100 + 100 + 37
  });

  test("an exact multiple of the page size stops instead of looping forever", async () => {
    mockGet.mockImplementation(fakeServer(200));
    const result = await listAllCatalog({ departmentId: "dept-civil" });

    expect(result.data).toHaveLength(200);
    expect(mockGet).toHaveBeenCalledTimes(2);
  });

  test("an empty catalog resolves cleanly", async () => {
    mockGet.mockImplementation(fakeServer(0));
    const result = await listAllCatalog({ departmentId: "dept-civil" });

    expect(result.data).toEqual([]);
    expect(mockGet).toHaveBeenCalledTimes(1);
  });

  test("the department filter is passed through on every page", async () => {
    mockGet.mockImplementation(fakeServer(150));
    await listAllCatalog({ departmentId: "dept-elec" });

    for (const [path] of mockGet.mock.calls) {
      expect(path).toContain("departmentId=dept-elec");
    }
  });

  test("includeInactive is forwarded when asked for, and omitted otherwise", async () => {
    mockGet.mockImplementation(fakeServer(5));
    await listAllCatalog({ departmentId: "dept-civil", includeInactive: true });
    expect(mockGet.mock.calls[0][0]).toContain("includeInactive=true");

    mockGet.mockReset();
    mockGet.mockImplementation(fakeServer(5));
    await listAllCatalog({ departmentId: "dept-civil" });
    expect(mockGet.mock.calls[0][0]).not.toContain("includeInactive");
  });

  test("a server rejection still propagates — it is not swallowed into an empty catalog", async () => {
    mockGet.mockRejectedValue(new ApiError(403, "FORBIDDEN", "You do not have permission to perform this action."));
    await expect(listAllCatalog({ departmentId: "dept-elec" })).rejects.toBeInstanceOf(ApiError);
  });
});
