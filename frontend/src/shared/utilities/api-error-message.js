import { ApiError } from "../../core/api/client.js";

// A ValidationError from the API carries `details` in Zod's flatten() shape:
// { formErrors: string[], fieldErrors: { [field]: string[] } }. The
// top-level message for those is the deliberately generic "Invalid request.",
// which tells a user nothing — the useful text is in fieldErrors, and it was
// being dropped on the floor.
//
// Only the API's own validation text is surfaced. Any other failure falls
// back to the caller's plain-language message, so a 500 or a network error
// never leaks internals into the UI.
export function apiErrorMessage(error, fallback) {
  if (!(error instanceof ApiError)) return fallback;

  const details = error.details;
  const fieldMessages = details?.fieldErrors
    ? Object.values(details.fieldErrors)
        .flat()
        .filter((message) => typeof message === "string" && message.trim())
    : [];
  const formMessages = Array.isArray(details?.formErrors)
    ? details.formErrors.filter((message) => typeof message === "string" && message.trim())
    : [];

  const specific = [...formMessages, ...fieldMessages];
  if (specific.length > 0) return specific.join(" ");

  return error.message || fallback;
}
