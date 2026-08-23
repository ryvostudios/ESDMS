import { readSessionCookie } from "./session-cookie.js";

// Browsers authenticate via the HttpOnly session cookie set at login; the
// Authorization header remains supported for non-browser API clients (CI,
// scripts, this project's own test suite). The cookie is checked first
// since it's what the real product UI uses. Lives here (not in
// middleware/authenticate.js) so both authenticate.js and rate-limit.js can
// import it without creating a circular module dependency between them.
export function extractToken(req) {
  const cookieToken = readSessionCookie(req);
  if (cookieToken) return cookieToken;

  const authorization = req.get("authorization");
  if (authorization?.startsWith("Bearer ")) return authorization.slice(7);

  return null;
}
