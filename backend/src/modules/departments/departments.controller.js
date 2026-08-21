import pool from "../../config/database.js";
import { asyncHandler } from "../../shared/http/async-handler.js";

export const list = asyncHandler(async (req, res) => {
  const result = await pool.query(
    "SELECT id, name FROM departments WHERE is_active = true ORDER BY name",
  );

  res.status(200).json({ success: true, data: result.rows });
});
