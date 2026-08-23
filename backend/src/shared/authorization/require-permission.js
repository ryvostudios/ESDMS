import { ForbiddenError } from "../errors/app-error.js";

// Server-side permission gate. Must run after `authenticate` has populated
// req.user.permissions. Never trust a frontend permission check in place
// of this.
//
// A user with mustChangePassword=true (HR-provisioned Employee login, or
// post-reset — see employees.service.js) is blocked from every
// permission-gated action until they change it, regardless of which
// permissions their role/overrides would otherwise grant. This flag
// defaults false and is only ever set true by Workforce onboarding/reset,
// so no existing Gate Pass account is affected — see docs/DECISIONS.md.
// `/auth/me`, `/auth/logout`, and `/auth/change-password` all bypass this
// (none of them go through requirePermission) so the user can actually see
// and clear the requirement.
export function requirePermission(...codes) {
  return function checkPermission(req, res, next) {
    if (req.user?.mustChangePassword) {
      return next(new ForbiddenError("Password change required before continuing."));
    }

    const permissions = req.user?.permissions;

    if (!permissions || !codes.some((code) => permissions.has(code))) {
      return next(new ForbiddenError());
    }

    return next();
  };
}
