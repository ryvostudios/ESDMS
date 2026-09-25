import { ValidationError } from "../errors/app-error.js";

// PostgreSQL `text` cannot store U+0000 — any statement carrying one fails
// with SQLSTATE 22021, which the error handler could not classify, so it
// surfaced as a 500 "Something went wrong. Please try again."
//
//   GET /demands?search=%00                 -> 500
//   GET /material-catalog?search=%00        -> 500
//   GET /ipos?search=%00                    -> 500
//   GET /receiving/challans?search=%00      -> 500
//   GET /delivery-challans?search=%00       -> 500
//   GET /employees?search=%00               -> 500
//   POST /demands  {"note":"a\u0000b"}  -> 500
//
// Zod's z.string() accepts U+0000, so this was reachable through every
// free-text field in the system, current and future. Fixing it per-schema
// would mean auditing every string in ~26 validation modules and remembering
// forever; the invariant is a property of the storage layer and belongs at
// the boundary where request text is first parsed.
//
// ONLY U+0000 is rejected. Tabs, newlines and carriage returns are
// legitimate in notes and descriptions, and every other Unicode character —
// emoji, non-Latin scripts, combining marks — is stored perfectly well and
// must keep working.
// Written as an escape, never as a literal NUL byte in the source: a literal
// one makes git treat this JavaScript file as BINARY, so it can never be
// diffed, blamed or reviewed — and some editors silently strip or mangle it.
const NUL = "\u0000";

// Bounded so a deeply nested or enormous body cannot turn validation into
// the expensive part of a request. Anything past these limits is already far
// outside what any endpoint's schema accepts and will be rejected by it.
const MAX_DEPTH = 12;
const MAX_NODES = 5000;

function findUnsupportedCharacter(value, path = "", depth = 0, budget = { remaining: MAX_NODES }) {
  if (depth > MAX_DEPTH || budget.remaining <= 0) return null;
  budget.remaining -= 1;

  if (typeof value === "string") {
    return value.includes(NUL) ? path || "value" : null;
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      const found = findUnsupportedCharacter(value[index], `${path}[${index}]`, depth + 1, budget);
      if (found) return found;
    }
    return null;
  }

  // Buffers and other non-plain objects are deliberately skipped: an uploaded
  // file's bytes legitimately contain NUL and never become text.
  if (value && typeof value === "object" && !Buffer.isBuffer(value)) {
    for (const [key, nested] of Object.entries(value)) {
      const found = findUnsupportedCharacter(nested, path ? `${path}.${key}` : key, depth + 1, budget);
      if (found) return found;
    }
  }

  return null;
}

function message(field) {
  return `${field} contains an unsupported character (NUL). Remove it and try again.`;
}

// Applied globally in app.js, immediately after the JSON body parser, so
// every JSON body and query string is covered without any endpoint opting in.
export function rejectUnsupportedText(req, res, next) {
  const inQuery = findUnsupportedCharacter(req.query);
  if (inQuery) return next(new ValidationError(message(inQuery)));

  const inBody = findUnsupportedCharacter(req.body);
  if (inBody) return next(new ValidationError(message(inBody)));

  return next();
}

// Multipart bodies are parsed per-route by multer, long after the global
// middleware above has run, so upload routes re-apply the same single
// definition to the text fields multer produces. Wrapping the upload
// middleware where it is defined keeps that automatic for every route using
// it, instead of something each route has to remember.
export function guardParsedBody(uploadMiddleware) {
  return function guardedUpload(req, res, next) {
    uploadMiddleware(req, res, (error) => {
      // Busboy reports truncated multipart streams as ordinary Errors.
      // Normalize only its fixed parser failures, never arbitrary IO errors.
      if (error && ["Unexpected end of form", "Unexpected end of file", "Malformed part header", "Multipart: Boundary not found"].includes(error.message)) {
        return next(new ValidationError("Invalid multipart upload."));
      }
      if (error) return next(error);
      return rejectUnsupportedText(req, res, next);
    });
  };
}
