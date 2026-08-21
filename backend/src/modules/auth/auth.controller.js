import { loginUser } from "./auth.service.js";
import { loginSchema } from "./auth.validation.js";
import { asyncHandler } from "../../shared/http/async-handler.js";
import { ValidationError, UnauthorizedError } from "../../shared/errors/app-error.js";

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

  return res.status(200).json({
    success: true,
    data: result,
  });
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
        permissions: Array.from(req.user.permissions),
      },
    },
  });
});
