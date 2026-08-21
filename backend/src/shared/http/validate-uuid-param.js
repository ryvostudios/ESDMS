import { ValidationError } from "../errors/app-error.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Every :id/:fileId route param must pass through this before it reaches a
// repository query — an unvalidated non-UUID string reaches Postgres as a
// raw type-mismatch error (22P02), which the generic error handler was
// turning into a leaking 500 instead of a clean 400.
export function validateUuidParam(paramName) {
  return function checkUuidParam(req, res, next) {
    if (!UUID_PATTERN.test(req.params[paramName])) {
      return next(new ValidationError(`Invalid ${paramName}.`));
    }

    return next();
  };
}
