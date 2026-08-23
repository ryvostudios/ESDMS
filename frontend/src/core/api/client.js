import { API_BASE_URL } from "../config/env.js";

export class ApiError extends Error {
  constructor(status, code, message, details) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

let onUnauthorized = () => {};

// AuthContext registers itself here once, on mount — this keeps the API
// client free of any dependency on React/auth state (no circular import),
// while still letting a 401 anywhere in the app trigger a clean logout.
// Auth itself rides on the HttpOnly session cookie (credentials: "include"
// below), never a token this client holds or attaches by hand.
export function configureApiClient({ onUnauthorized: onUnauthorizedFn }) {
  onUnauthorized = onUnauthorizedFn;
}

async function request(method, path, { body, isForm, suppressUnauthorizedHandling } = {}) {
  const headers = {};

  if (body && !isForm) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    headers,
    credentials: "include",
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });

  const isJson = response.headers.get("content-type")?.includes("application/json");
  const payload = isJson ? await response.json().catch(() => null) : null;

  if (!response.ok) {
    if (response.status === 401 && !suppressUnauthorizedHandling) {
      onUnauthorized();
    }

    throw new ApiError(
      response.status,
      payload?.error?.code || "UNKNOWN_ERROR",
      payload?.error?.message || "Something went wrong. Please try again.",
      payload?.error?.details,
    );
  }

  return payload;
}

async function blobRequest(method, path, body) {
  const isForm = body instanceof FormData;
  const response = await fetch(`${API_BASE_URL}${path}`, {
    method,
    credentials: "include",
    headers: body && !isForm ? { "Content-Type": "application/json" } : {},
    body: isForm ? body : body ? JSON.stringify(body) : undefined,
  });

  if (!response.ok) {
    if (response.status === 401) {
      onUnauthorized();
    }

    const isJson = response.headers.get("content-type")?.includes("application/json");
    const payload = isJson ? await response.json().catch(() => null) : null;

    throw new ApiError(
      response.status,
      payload?.error?.code || "UNKNOWN_ERROR",
      payload?.error?.message || "Unable to download the file.",
    );
  }

  return response.blob();
}

export const apiClient = {
  get: (path, options) => request("GET", path, options),
  post: (path, body, options) => request("POST", path, { ...options, body }),
  patch: (path, body, options) => request("PATCH", path, { ...options, body }),
  put: (path, body, options) => request("PUT", path, { ...options, body }),
  del: (path, options) => request("DELETE", path, options),
  getBlob: (path) => blobRequest("GET", path),
  postBlob: (path, body) => blobRequest("POST", path, body),
};
