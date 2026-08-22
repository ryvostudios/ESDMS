import { asyncHandler } from "../../shared/http/async-handler.js";
import { listActiveDepartmentsForSite } from "./departments.repository.js";

export const list = asyncHandler(async (req, res) => {
  const rows = await listActiveDepartmentsForSite(req.user.siteId);

  res.status(200).json({ success: true, data: rows });
});
