const apiBaseUrl = import.meta.env.VITE_API_URL;

if (!apiBaseUrl) {
  throw new Error("Missing VITE_API_URL environment variable.");
}

export const API_BASE_URL = apiBaseUrl.replace(/\/$/, "");

// The business's own timezone, for displaying operational timestamps
// (approval/departure/return/audit) consistently regardless of which
// device or region a viewer happens to be in — see
// shared/utilities/datetime.js. Must match the backend's APP_TIMEZONE (see
// backend/.env.example); duplicated here rather than fetched from the API
// because it's build-time, non-sensitive, and needed before the first
// timestamp ever renders.
export const APP_TIMEZONE = import.meta.env.VITE_APP_TIMEZONE || "Asia/Karachi";
export const BUILD_REVISION = import.meta.env.VITE_BUILD_REVISION || "development";
