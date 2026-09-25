import { ApiError } from "../../core/api/client.js";

export function describeApiError(error, fallback = "Unable to load this record.") {
  if (typeof error === "string") return { title: "Something went wrong", message: error, retryable: true };
  if (!(error instanceof ApiError)) {
    if (error instanceof TypeError) {
      return { title: "Connection problem", message: "We couldn't reach the server. Check your connection and try again.", retryable: true };
    }
    return { title: "Something went wrong", message: error?.message || fallback, retryable: true };
  }

  if (error.status === 401) return { title: "Session expired", message: "Please sign in again to continue.", retryable: false };
  if (error.status === 403) return { title: "Access denied", message: "You do not have permission to view this or perform this action.", retryable: false };
  if (error.status === 404) return { title: "Not found", message: "Record not found or unavailable.", retryable: false };
  if (error.status === 409) return { title: "This has already changed", message: error.message || "Someone else changed this record. Reload to see the current state.", retryable: true };
  if (error.status === 400) return { title: "Invalid request", message: firstValidationMessage(error) || error.message || fallback, retryable: false };
  if (error.status >= 500) return { title: "Something went wrong", message: "The server had a problem. Please try again in a moment.", retryable: true };
  return { title: "Something went wrong", message: error.message || fallback, retryable: true };
}

function firstValidationMessage(error) {
  const details = error.details;
  const messages = [
    ...(Array.isArray(details?.formErrors) ? details.formErrors : []),
    ...(details?.fieldErrors ? Object.values(details.fieldErrors).flat() : []),
  ];
  return messages.find((message) => typeof message === "string" && message.trim()) || null;
}
