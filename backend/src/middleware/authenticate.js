import jwt from "jsonwebtoken";
import pool from "../config/database.js";
import config from "../config/env.js";
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

  const result = await pool.query(
    `SELECT
       u.id,
       u.is_active,
       u.department_id,
       u.full_name,
       r.name AS role,
       COALESCE(array_agg(p.code) FILTER (WHERE p.code IS NOT NULL), '{}') AS permissions
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN role_permissions rp ON rp.role_id = r.id
     LEFT JOIN permissions p ON p.id = rp.permission_id
     WHERE u.id = $1
     GROUP BY u.id, r.name
     LIMIT 1`,
    [payload.sub],
  );

  const user = result.rows[0];

  if (!user || !user.is_active) {
    return next(new UnauthorizedError());
  }

  req.user = {
    id: user.id,
    fullName: user.full_name,
    role: user.role,
    departmentId: user.department_id,
    permissions: new Set(user.permissions),
  };

  return next();
}
