import rateLimit, { ipKeyGenerator } from "express-rate-limit";

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

export const apiRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 600,
  standardHeaders: true,
  legacyHeaders: false,
  message: {
    success: false,
    error: {
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Please slow down.",
    },
  },
});
