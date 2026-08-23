import jwt from "jsonwebtoken";
import config from "../config/env.js";
import { getUserProfileById, isProfileActive } from "../shared/users/user-profile.repository.js";
import { readSessionCookie } from "../shared/http/session-cookie.js";
import { UnauthorizedError } from "../shared/errors/app-error.js";

// Browsers authenticate via the HttpOnly session cookie set at login; the
// Authorization header remains supported for non-browser API clients (CI,
// scripts, this project's own test suite) — see docs/DECISIONS.md for why
// both are kept rather than removing bearer support outright. The cookie
// is checked first since it's what the real product UI uses. Exported so
// logout (see auth.controller.js) can identify whose session to revoke
// without duplicating this extraction logic.
export function extractToken(req) {
  const cookieToken = readSessionCookie(req);
  if (cookieToken) return cookieToken;

  const authorization = req.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);

  return null;
}

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

  return next();
}
