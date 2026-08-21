import argon2 from "argon2";
import jwt from "jsonwebtoken";
import pool from "../../config/database.js";
import config from "../../config/env.js";
import { getUserProfileById } from "../../shared/users/user-profile.repository.js";

export async function loginUser(email, password) {
  const normalizedEmail = email.trim().toLowerCase();

  const result = await pool.query(
    `SELECT id, password_hash, is_active FROM users WHERE LOWER(email) = $1 LIMIT 1`,
    [normalizedEmail],
  );

  const authRow = result.rows[0];

  if (!authRow || !authRow.is_active) {
    return null;
  }

  const passwordValid = await argon2.verify(authRow.password_hash, password);

  if (!passwordValid) {
    return null;
  }

  const profile = await getUserProfileById(authRow.id);

  const token = jwt.sign(
    {
      sub: profile.id,
      role: profile.role,
    },
    config.jwtSecret,
    {
      expiresIn: config.jwtExpiresIn,
    },
  );

  return {
    token,
    user: {
      id: profile.id,
      email: profile.email,
      fullName: profile.full_name,
      role: profile.role,
      departmentId: profile.department_id,
      permissions: profile.permissions,
    },
  };
}
