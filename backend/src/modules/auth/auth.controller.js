import jwt from "jsonwebtoken";
import { loginUser } from "./auth.service.js";
import { loginSchema } from "./auth.validation.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, UnauthorizedError, ServiceUnavailableError } from "../../shared/errors/app-error.js";
import { setSessionCookie, clearSessionCookie } from "../../shared/http/session-cookie.js";
import { extractToken } from "../../middleware/authenticate.js";
import { bumpSessionVersion } from "../../shared/users/user-profile.repository.js";
import config from "../../config/env.js";

export const login = asyncHandler(async (req, res) => {
  const parsed = loginSchema.safeParse(req.body);

  if (!parsed.success) {
    throw new ValidationError("Email and password are required.");
  }

  const result = await loginUser(parsed.data.email, parsed.data.password);

  if (!result) {
    // Deliberately identical response whether the email doesn't exist,
    // the account is inactive, or the password is wrong — do not leak
    // account existence.
    throw new UnauthorizedError("Invalid email or password.");
  }

  // The browser authenticates via this HttpOnly cookie alone — the JWT
  // itself is never put in the response body. A script reading the login
  // response (XSS, a misconfigured logging proxy, browser devtools network
  // tab left open) gets the user's profile, not a bearer credential it
  // could replay. See docs/DECISIONS.md.
  setSessionCookie(res, result.token);

  return res.status(200).json({
    success: true,
    data: { user: result.user },
  });
});

export const logout = asyncHandler(async (req, res) => {
  // Real revocation: if the request still carries a token that verifies
  // (even one close to expiry), bump that user's session_version so it —
  // and any other still-valid token for them — is rejected on its next
  // use. An invalid/missing/expired token isn't an error here: logout is
  // idempotent, the outcome the caller wants (no working session) is
  // already true.
  //
  // A DB failure while bumping session_version is a DIFFERENT case from
  // "no valid token" and must not be treated the same way: the token WAS
  // valid, and if the write to bump session_version fails, that session is
  // NOT actually revoked — it stays live until natural expiry. Reporting
  // success anyway would tell the frontend it's safe to treat the user as
  // logged out while a still-valid token exists. This is surfaced as a
  // failure instead, and the cookie is left in place so client state
  // matches reality (still authenticated) rather than showing a false
  // "logged out" UI over a token that's still actually live.
  const token = extractToken(req);

  if (token) {
    let payload = null;

    try {
      payload = jwt.verify(token, config.jwtSecret, {
        issuer: config.jwtIssuer,
        audience: config.jwtAudience,
      });
    } catch {
      // Invalid/expired/missing signature — nothing to revoke, already
      // unusable. Falls through to the normal success response below.
    }

    if (payload) {
      try {
        await bumpSessionVersion(payload.sub);
      } catch (error) {
        console.error("Logout: failed to revoke session_version for a valid session:", error);
        throw new ServiceUnavailableError("Could not securely sign out. Please try again.");
      }
    }
  }

  clearSessionCookie(res);

  return res.status(200).json({ success: true, data: null });
});

export const me = asyncHandler(async (req, res) => {
  return res.status(200).json({
    success: true,
    data: {
      user: {
        id: req.user.id,
        email: req.user.email,
        fullName: req.user.fullName,
        role: req.user.role,
        departmentId: req.user.departmentId,
        siteId: req.user.siteId,
        permissions: Array.from(req.user.permissions),
      },
    },
  });
});
