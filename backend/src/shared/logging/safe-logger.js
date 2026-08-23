import crypto from "node:crypto";
import config from "../../config/env.js";
import { AppError } from "../errors/app-error.js";

// ESDMS-021: a raw exception (console.error(rawError)) routinely leaks
// sensitive data into application logs — a Postgres driver error's own
// `.message`/`.detail` frequently embeds the actual submitted row values
// (e.g. "Key (email)=(user@example.com) already exists."), and stack
// traces can include request context. This logger only ever prints:
//   - a generated correlation id (safe to hand back to the caller/support),
//   - the request method/route (not query string — see ESDMS-039),
//   - error name and a normalized code,
//   - an authored message, but ONLY for AppError — a message this codebase
//     wrote itself, never one derived from raw external/DB input,
//   - a stack trace, but only outside production.
// Everything else (headers, cookies, body, DB detail text, secrets) is
// never touched, let alone logged.
const SQL_STATE = /^[0-9A-Z]{5}$/;

// Node's default Error#stack format is "<name>: <message>\n    at ...":
// the message this function otherwise redacts for a non-AppError reappears
// verbatim as the stack's own first line. Call-frame lines (file/line only)
// remain genuinely safe and useful for debugging; only that header line is
// replaced.
function safeStack(error, isAppError) {
  if (!error?.stack) return undefined;
  if (isAppError) return error.stack;

  const lines = error.stack.split("\n");
  lines[0] = `${error?.name || "Error"}: [redacted]`;
  return lines.join("\n");
}

// `context` is an OPTIONAL plain object of fields the CALLER has already
// vetted as safe to log (e.g. { operation: "storage.supabase.remove",
// provider: "supabase", storageKeyHash: "..." }) — never raw provider
// error text, storage keys, signed URLs, or credentials. Kept as one
// nested, clearly-labeled sub-object so it can never accidentally
// overwrite this function's own fields (requestId, name, etc.).
export function logServerError(error, req, context) {
  const requestId = crypto.randomUUID();

  const isAppError = error instanceof AppError;
  const code = typeof error?.code === "string" ? error.code : undefined;

  const safe = {
    requestId,
    method: req?.method,
    route: req?.route?.path || req?.baseUrl || undefined,
    name: error?.name,
    sqlState: !isAppError && code && SQL_STATE.test(code) ? code : undefined,
    appErrorCode: isAppError ? code : undefined,
    message: isAppError ? error.message : undefined,
    ...(context ? { context } : {}),
    ...(config.isProduction ? {} : { stack: safeStack(error, isAppError) }),
  };

  console.error("[server-error]", JSON.stringify(safe));

  return requestId;
}

// Non-reversible reference to a private storage key/path — lets operators
// correlate "the same object failed cleanup twice" across log lines
// without the raw key (a private storage path) ever being logged.
export function hashForLogging(value) {
  return crypto.createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}
