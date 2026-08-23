import { ForbiddenError } from "../errors/app-error.js";

// requirePermission.js already blocks every permission-gated route for a
// mustChangePassword=true user, but authenticate-only self-service routes
// (no permission check at all — "/employees/me" and its future
// documents/contracts/rotation/leave siblings) never pass through
// requirePermission. Workforce route modules that expose such routes apply
// this immediately after `authenticate` too. Never applied to Gate Pass or
// other pre-existing route modules — the flag is only ever set true by
// Workforce onboarding (docs/DECISIONS.md), so it would be a no-op there
// anyway, but keeping the change scoped to Workforce routes only is safer.
export function requirePasswordChanged(req, res, next) {
  if (req.user?.mustChangePassword) {
    return next(new ForbiddenError("Password change required before continuing."));
  }
  return next();
}
