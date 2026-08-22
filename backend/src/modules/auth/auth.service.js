import argon2 from "argon2";
import jwt from "jsonwebtoken";
import pool from "../../config/database.js";
import config from "../../config/env.js";
import { getUserProfileById } from "../../shared/users/user-profile.repository.js";

// A fixed, valid Argon2id hash of an arbitrary string — never a real
// password, never derived from any secret. Used only so a missing or
// deactivated account still pays Argon2's verification cost, keeping
// response time uniform regardless of whether the email exists. Without
// this, response latency alone would let an attacker enumerate valid
// emails (real accounts take ~argon2-verify-time longer than missing ones).
const DUMMY_PASSWORD_HASH =
  "$argon2id$v=19$m=65536,p=4,t=3$Qi26MXI97heIwfZvilM3AA$3AxkXENWudP7d3HPehPEIyLkPS1mhN5EKOqpFwKjSgo";

export async function loginUser(email, password) {
  const normalizedEmail = email.trim().toLowerCase();

  const result = await pool.query(
    `SELECT u.id, u.password_hash, u.is_active, r.is_active AS role_is_active
     FROM users u
     JOIN roles r ON r.id = u.role_id
     WHERE LOWER(u.email) = $1
     LIMIT 1`,
    [normalizedEmail],
  );

  const authRow = result.rows[0];
  const isAccountUsable = Boolean(authRow) && authRow.is_active && authRow.role_is_active;

  // Always verify against something — real hash if usable, dummy hash if
  // not — so this call takes the same time either way.
  const passwordValid = await argon2.verify(
    isAccountUsable ? authRow.password_hash : DUMMY_PASSWORD_HASH,
    password,
  );

  if (!isAccountUsable || !passwordValid) {
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
      issuer: config.jwtIssuer,
      audience: config.jwtAudience,
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
      siteId: profile.site_id,
      permissions: profile.permissions,
    },
  };
}
