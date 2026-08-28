import { describe, expect, test } from "vitest";
import { ApiError } from "../../core/api/client.js";
import { describeApiError } from "./error-presentation.js";

describe("describeApiError", () => {
  test("distinguishes denial and concealed/not-found records without leaking detail", () => {
    expect(describeApiError(new ApiError(403, "FORBIDDEN", "Forbidden"))).toMatchObject({ title: "Access denied", retryable: false });
    expect(describeApiError(new ApiError(404, "NOT_FOUND", "Secret record detail"))).toMatchObject({ title: "Not found", message: "Record not found or unavailable.", retryable: false });
  });

  test("surfaces only a useful validation message", () => {
    const error = new ApiError(400, "VALIDATION_ERROR", "Invalid request.", { fieldErrors: { pageSize: ["Must be at most 100."] } });
    expect(describeApiError(error)).toMatchObject({ title: "Invalid request", message: "Must be at most 100.", retryable: false });
  });

  test("does not expose server error detail", () => {
    const result = describeApiError(new ApiError(500, "INTERNAL_ERROR", "select * from secrets"));
    expect(result.message).not.toContain("select");
  });
});
