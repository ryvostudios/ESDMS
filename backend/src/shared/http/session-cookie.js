import config from "../../config/env.js";

// SameSite=Lax already excludes this cookie from cross-site fetch/XHR
// requests (it only rides along on top-level GET navigation), which is
// exactly the classic CSRF vector for a JSON-only API — there is no HTML
// form or simple cross-site request that could trigger a state-changing
// call with this cookie attached. That's the actual protection here, not
// CORS (CORS only controls whether a script can *read* a response, not
// whether a request executes). See docs/DECISIONS.md.
const COOKIE_OPTIONS = {
  httpOnly: true,
  secure: config.isProduction,
  sameSite: "lax",
  path: "/",
  domain: config.cookieDomain,
};

// `maxAgeMs` defaults to the normal session lifetime; the login controller
// passes the longer "remember me" lifetime explicitly when the caller
// opted in, so this cookie's maxAge always matches the JWT's own
// expiresIn — the two must never drift apart.
export function setSessionCookie(res, token, maxAgeMs = config.jwtExpiresInMs) {
  res.cookie(config.sessionCookieName, token, {
    ...COOKIE_OPTIONS,
    maxAge: maxAgeMs,
  });
}

export function clearSessionCookie(res) {
  res.clearCookie(config.sessionCookieName, COOKIE_OPTIONS);
}

export function readSessionCookie(req) {
  return req.cookies?.[config.sessionCookieName];
}
