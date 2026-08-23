import jwt from "jsonwebtoken";
import config from "../config/env.js";
import { getUserProfileById, isProfileActive } from "../shared/users/user-profile.repository.js";
import { UnauthorizedError } from "../shared/errors/app-error.js";
import { extractToken } from "../shared/http/extract-token.js";
import { apiUserRateLimiter } from "./rate-limit.js";

// Re-exported for existing callers (e.g. auth.controller.js's logout) —
// the implementation itself lives in shared/http/extract-token.js so
// rate-limit.js can use it too without importing this module (which itself
// imports rate-limit.js, below) and creating a circular dependency.
export { extractToken };

export async function authenticate(req, res, next) {
  const token = extractToken(req);

  if (!token) {
    return next(new UnauthorizedError());
  }

  let payload;

  try {
    payload = jwt.verify(token, config.jwtSecret, {
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
    });
  } catch {
    return next(new UnauthorizedError("Invalid or expired authentication token."));
  }

  const user = await getUserProfileById(payload.sub);

  if (!isProfileActive(user)) {
    return next(new UnauthorizedError());
  }

  // Session revocation: a token's "sv" claim must match the user's
  // *current* session_version. Logout bumps it, so a captured/replayed
  // token from before logout fails here even though its signature and
  // expiry are both still perfectly valid.
  if (payload.sv !== user.session_version) {
    return next(new UnauthorizedError());
  }

  req.user = {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    departmentId: user.department_id,
    siteId: user.site_id,
    // Nullable — an Employee record may exist with no login and a login may
    // exist with no linked Employee (docs/DECISIONS.md). Workforce
    // self-service routes resolve "my own record" from this, not from a
    // request parameter.
    employeeId: user.employee_id,
    mustChangePassword: user.must_change_password,
    permissions: new Set(user.permissions),
  };

  // ESDMS-017: the broad per-IP abuse ceiling (apiAuthenticatedIpRateLimiter)
  // is applied globally in app.js now, for every request regardless of
  // outcome — see the comment there for why (closing a bypass where a
  // revoked-but-signature-valid token got zero rate-limit coverage). Only
  // the per-identity quota is applied here, now that req.user is known —
  // many users sharing an IP each get their own budget instead of
  // splitting one.
  return apiUserRateLimiter(req, res, next);
}
