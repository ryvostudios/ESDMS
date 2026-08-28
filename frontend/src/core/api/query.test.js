import { describe, expect, test } from "vitest";
import { buildQuery } from "./query.js";

describe("buildQuery", () => {
  test("omits undefined, null and empty optional values", () => {
    expect(buildQuery({ departmentId: undefined, status: "", search: null, page: 1 })).toBe("?page=1");
  });

  test("preserves false, zero and repeated array values", () => {
    const result = buildQuery({ active: false, offset: 0, ids: ["a", "b", "", null] });
    expect(new URLSearchParams(result).get("active")).toBe("false");
    expect(new URLSearchParams(result).get("offset")).toBe("0");
    expect(new URLSearchParams(result).getAll("ids")).toEqual(["a", "b"]);
  });
});
