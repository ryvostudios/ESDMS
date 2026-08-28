// P4-2 regression. A ValidationError's useful text lives in
// details.fieldErrors; the UI was showing only the deliberately generic
// top-level "Invalid request.", so a user who typed a 151-character material
// name was told nothing about what was wrong.
import { describe, test, expect } from "vitest";
import { ApiError } from "../../core/api/client.js";
import { apiErrorMessage } from "./api-error-message.js";

const FALLBACK = "Unable to add this material.";

describe("apiErrorMessage", () => {
  test("surfaces the field error instead of the generic message", () => {
    const error = new ApiError(400, "VALIDATION_ERROR", "Invalid request.", {
      formErrors: [],
      fieldErrors: { newItem: ["Too big: expected string to have <=150 characters"] },
    });
    expect(apiErrorMessage(error, FALLBACK)).toBe("Too big: expected string to have <=150 characters");
  });

  test("joins several field errors rather than picking one arbitrarily", () => {
    const error = new ApiError(400, "VALIDATION_ERROR", "Invalid request.", {
      formErrors: [],
      fieldErrors: { defaultUomId: ["Required"], departmentId: ["Invalid uuid"] },
    });
    expect(apiErrorMessage(error, FALLBACK)).toBe("Required Invalid uuid");
  });

  test("form-level errors are included, and come first", () => {
    const error = new ApiError(400, "VALIDATION_ERROR", "Invalid request.", {
      formErrors: ["Provide exactly one of companyItemId or newItem."],
      fieldErrors: { companyItemId: ["Required"] },
    });
    expect(apiErrorMessage(error, FALLBACK)).toBe("Provide exactly one of companyItemId or newItem. Required");
  });

  test("an API error with no details keeps its own message", () => {
    const error = new ApiError(409, "CONFLICT", "This material is already in the department catalog.");
    expect(apiErrorMessage(error, FALLBACK)).toBe("This material is already in the department catalog.");
  });

  test("a non-API failure falls back to plain language and leaks nothing", () => {
    const error = new TypeError("Cannot read properties of undefined (reading 'id')");
    expect(apiErrorMessage(error, FALLBACK)).toBe(FALLBACK);
  });

  test("an unexpected details shape does not throw or produce noise", () => {
    for (const details of [null, undefined, {}, { fieldErrors: null }, { fieldErrors: { a: [] } }, { fieldErrors: { a: [""] } }]) {
      const error = new ApiError(400, "VALIDATION_ERROR", "Invalid request.", details);
      expect(apiErrorMessage(error, FALLBACK)).toBe("Invalid request.");
    }
  });
});
