import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import jwt from "jsonwebtoken";
import config from "../config/env.js";
import { extractToken } from "../shared/http/extract-token.js";

// A lightweight, cryptographic check — not a trust of any spoofable client
// header — used only to decide WHICH per-IP limiter bucket a request
// belongs to, before routing/authenticate.js has run. Verifies the JWT
// signature/expiry/issuer/audience exactly as authenticate.js does; it
// deliberately does NOT hit the database (no session_version/active-state
// check), since a wrong answer here only misroutes which rate-limit bucket
// a request consumes — actual authorization is still fully re-verified by
// authenticate.js for every request that reaches a real route.
function hasValidSessionToken(req) {
  const token = extractToken(req);
  if (!token) return false;

  try {
    jwt.verify(token, config.jwtSecret, { issuer: config.jwtIssuer, audience: config.jwtAudience });
    return true;
  } catch {
    return false;
  }
}

function normalizedEmailKey(req) {
  const email = typeof req.body?.email === "string" ? req.body.email.trim().toLowerCase() : "";
  // req.ip already respects Express's `trust proxy` setting (see app.js) —
  // only trusted, explicitly-configured proxy hops affect it. ipKeyGenerator
  // collapses an IPv6 address to its /64 so one client can't get a fresh
  // budget per address in its assigned block.
  return `${ipKeyGenerator(req.ip)}:${email}`;
}

// Layered on purpose: a generous per-IP ceiling catches broad abuse from
// one source regardless of which account(s) it targets, while a much
// tighter per-account(+IP) limit stops brute-forcing one specific account
// without giving every account behind a shared IP (a site/office gate NAT)
// a shared budget — one person's repeated typos against their own account
// must never lock out someone else's login at the same gate. Both skip
// successful requests: a real login should never spend down a budget meant
// for catching guesses.
export const loginIpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: {
    success: false,
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many login attempts from this network. Please try again later.",
    },
  },
});

export const loginAccountRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: normalizedEmailKey,
  message: {
    success: false,
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many login attempts. Please try again later.",
    },
  },
});

// ESDMS-017: a single global per-IP budget treats every employee behind one
// site/office NAT as if they were one user — ordinary concurrent usage
// (dashboards, notification polling) from a busy site can exhaust it for
// everyone at that site well before any individual user misbehaves. Split
// into three tracks:
//
//   - apiAuthenticatedIpRateLimiter (below, applied FIRST and globally in
//     app.js, before routing/authenticate.js, for EVERY request — no skip,
//     no dependency on token validity): a much higher, coarse abuse
//     ceiling. This guarantees every request is covered by at least one
//     meaningful bucket, closing a real bypass an earlier version of this
//     design had — a token with a valid signature/expiry/issuer/audience
//     but a revoked session_version or a deactivated user is
//     cryptographically "valid" enough to skip the limiter below, yet
//     authenticate.js still rejects it (session_version/active-state are
//     only checked there, against the database) before it could ever reach
//     an authenticated-only limiter — previously leaving such a request
//     with NO rate-limit coverage at all. This is NOT the per-user quota —
//     it exists only to catch genuinely broad abuse from one source, far
//     above anything real concurrent NAT usage could reach (fully
//     authenticated traffic is a subset of "every request" and remains
//     covered by this same ceiling).
//   - apiUnauthenticatedIpRateLimiter (below, also applied globally in
//     app.js, after the ceiling above): a reasonable, tighter per-IP
//     ceiling layered on top for traffic that is not (yet) authenticated.
//     Skips any request that already carries a valid, verifiable session
//     token — that request is still fully covered by the global ceiling
//     above regardless, so it is never double-counted against this lower
//     one merely for looking authenticated.
//   - apiUserRateLimiter (below, applied in authenticate.js once req.user
//     is set): the actual meaningful per-identity quota — many users
//     behind one IP each get their own budget instead of splitting one.
// Exported as plain numbers (not just baked into the built middleware,
// which express-rate-limit doesn't expose introspectable config on) so
// tests can assert on the exact configured ceilings directly.
export const UNAUTHENTICATED_IP_LIMIT = 3000;
export const AUTHENTICATED_USER_LIMIT = 600;
export const AUTHENTICATED_IP_LIMIT = 30000;

export const apiUnauthenticatedIpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: UNAUTHENTICATED_IP_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  skip: hasValidSessionToken,
  message: {
    success: false,
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests from this network. Please slow down.",
    },
  },
});

// Broad authenticated-traffic-per-IP abuse ceiling — see the block comment
// above. 30,000/15min is deliberately far above what even a busy site NAT
// generates from real usage (see docs/DECISIONS.md for the arithmetic at
// 10/20/50 concurrent users), so it never fires under legitimate load; it
// exists purely as a backstop against a compromised/scripted client.
export const apiAuthenticatedIpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: AUTHENTICATED_IP_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => ipKeyGenerator(req.ip),
  message: {
    success: false,
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests from this network. Please slow down.",
    },
  },
});

// Applied per authenticated identity (never per-IP) from within
// authenticate.js, once req.user is known — many users sharing an IP each
// get their own budget instead of splitting one. Kept generous enough that
// normal navigation plus notification polling never approaches it; see
// docs/DECISIONS.md.
export const apiUserRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: AUTHENTICATED_USER_LIMIT,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user.id,
  message: {
    success: false,
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Please slow down.",
    },
  },
});
