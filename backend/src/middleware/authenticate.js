import jwt from "jsonwebtoken";
import config from "../config/env.js";
import { getUserProfileById, isProfileActive } from "../shared/users/user-profile.repository.js";
import { readSessionCookie } from "../shared/http/session-cookie.js";
import { UnauthorizedError } from "../shared/errors/app-error.js";

// Browsers authenticate via the HttpOnly session cookie set at login; the
// Authorization header remains supported for non-browser API clients (CI,
// scripts, this project's own test suite) — see docs/DECISIONS.md for why
// both are kept rather than removing bearer support outright. The cookie
// is checked first since it's what the real product UI uses.
function extractToken(req) {
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

  req.user = {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    departmentId: user.department_id,
    siteId: user.site_id,
    permissions: new Set(user.permissions),
  };

  return next();
}
