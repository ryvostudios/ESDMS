import { ForbiddenError } from "../errors/app-error.js";

// Server-side permission gate. Must run after `authenticate` has populated
// req.user.permissions. Never trust a frontend permission check in place
// of this.
export function requirePermission(...codes) {
  return function checkPermission(req, res, next) {
    const permissions = req.user?.permissions;

    if (!permissions || !codes.some((code) => permissions.has(code))) {
      return next(new ForbiddenError());
    }

    return next();
  };
}
