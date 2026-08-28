import { z } from "zod";

export function isAbsentOptionalQueryValue(value) {
  return value === undefined || value === null || value === "" || value === "null";
}

// Optional URL query values are normalized before their real schema runs.
// This keeps omitted, empty and explicit null placeholders equivalent while
// preserving strict validation for every non-empty value.
export function optionalQueryValue(schema) {
  return z.preprocess((value) => (isAbsentOptionalQueryValue(value) ? undefined : value), schema.optional());
}
