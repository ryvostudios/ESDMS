import { loginUser } from "./auth.service.js";
import { loginSchema } from "./auth.validation.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, UnauthorizedError } from "../../shared/errors/app-error.js";
import { setSessionCookie, clearSessionCookie } from "../../shared/http/session-cookie.js";

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

  // The browser app authenticates via this cookie and never reads/stores
  // the token field below — that field exists for non-browser API clients
  // (scripts, this project's own test suite). See docs/DECISIONS.md.
  setSessionCookie(res, result.token);

  return res.status(200).json({
    success: true,
    data: result,
  });
});

export const logout = asyncHandler(async (req, res) => {
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
