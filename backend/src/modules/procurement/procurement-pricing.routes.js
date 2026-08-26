import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./procurement-pricing.controller.js";

const router = Router();

router.use(authenticate);
router.param("demandId", validateUuidParam("demandId"));

router.get("/", requirePermission("procurement.pricing"), controller.list);
router.get(
  "/:demandId",
  requirePermission("procurement.pricing", "procurement.view_prices"),
  controller.detail,
);
router.put("/:demandId", requirePermission("procurement.pricing"), controller.save);
router.post("/:demandId/submit", requirePermission("procurement.pricing"), controller.submit);

export default router;
