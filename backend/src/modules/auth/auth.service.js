import argon2 from "argon2";
import jwt from "jsonwebtoken";
import pool from "../../config/database.js";
import config from "../../config/env.js";

export async function loginUser(email, password) {
  const normalizedEmail = email.trim().toLowerCase();

  const result = await pool.query(
    `SELECT
       u.id,
       u.email,
       u.password_hash,
       u.full_name,
       u.is_active,
       r.name AS role,
       d.name AS department
     FROM users u
     JOIN roles r ON r.id = u.role_id
     LEFT JOIN departments d ON d.id = u.department_id
     WHERE LOWER(u.email) = $1
     LIMIT 1`,
    [normalizedEmail],
  );

  const user = result.rows[0];

  if (!user || !user.is_active) {
    return null;
  }

  const passwordValid = await argon2.verify(user.password_hash, password);

  if (!passwordValid) {
    return null;
  }

  const token = jwt.sign(
    {
      sub: user.id,
      role: user.role,
    },
    config.jwtSecret,
    {
      expiresIn: config.jwtExpiresIn,
    },
  );

  return {
    token,
    user: {
      id: user.id,
      email: user.email,
      fullName: user.full_name,
      role: user.role,
      department: user.department,
    },
  };
}
