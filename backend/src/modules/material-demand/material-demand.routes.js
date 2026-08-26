import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./material-demand.controller.js";

const router = Router();

router.use(authenticate);
router.param("id", validateUuidParam("id"));

router.get("/", requirePermission("demand.view"), controller.list);
router.post("/", requirePermission("demand.create"), controller.create);
router.get("/:id", requirePermission("demand.view", "demand.review", "demand.approve"), controller.detail);
router.patch("/:id", requirePermission("demand.edit"), controller.updateDraft);
router.post("/:id/submit", requirePermission("demand.submit"), controller.submit);
router.post("/:id/reviews", requirePermission("demand.review"), controller.recordReview);
router.post("/:id/approvals", requirePermission("demand.approve"), controller.recordApproval);
router.post("/:id/final-reviews", requirePermission("demand.review"), controller.recordFinalReview);
router.post("/:id/final-approvals", requirePermission("demand.approve"), controller.recordFinalApproval);

export default router;
