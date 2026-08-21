import jwt from "jsonwebtoken";
import config from "../config/env.js";
import { getUserProfileById } from "../shared/users/user-profile.repository.js";
import { UnauthorizedError } from "../shared/errors/app-error.js";

export async function authenticate(req, res, next) {
  const authorization = req.get("authorization");

  if (!authorization?.startsWith("Bearer ")) {
    return next(new UnauthorizedError());
  }

  const token = authorization.slice(7);

  let payload;

  try {
    payload = jwt.verify(token, config.jwtSecret);
  } catch {
    return next(new UnauthorizedError("Invalid or expired authentication token."));
  }

  const user = await getUserProfileById(payload.sub);

  if (!user || !user.is_active) {
    return next(new UnauthorizedError());
  }

  req.user = {
    id: user.id,
    email: user.email,
    fullName: user.full_name,
    role: user.role,
    departmentId: user.department_id,
    permissions: new Set(user.permissions),
  };

  return next();
}
