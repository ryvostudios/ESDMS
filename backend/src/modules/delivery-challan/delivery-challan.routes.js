import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./delivery-challan.controller.js";

const router = Router();

router.use(authenticate);
router.param("id", validateUuidParam("id"));

router.get("/", requirePermission("dc.view", "dc.manage"), controller.list);
router.post("/", requirePermission("dc.manage"), controller.create);
router.get("/:id", requirePermission("dc.view", "dc.manage"), controller.detail);
router.patch("/:id", requirePermission("dc.manage"), controller.update);
router.post("/:id/finalize", requirePermission("dc.manage"), controller.finalize);
router.post("/:id/cancel", requirePermission("dc.manage"), controller.cancel);
// Operational document with no commercial content, so ordinary DC view
// authority is sufficient — scope is still re-checked in the service.
router.get("/:id/pdf", requirePermission("dc.view", "dc.manage"), controller.downloadPdf);

export default router;
