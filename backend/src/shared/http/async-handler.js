// Express controllers are async; this forwards rejected promises to the
// centralized error handler instead of requiring try/catch in every one.
export function asyncHandler(handler) {
  return function wrapped(req, res, next) {
    Promise.resolve(handler(req, res, next)).catch(next);
  };
}
