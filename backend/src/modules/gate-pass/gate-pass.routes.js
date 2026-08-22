import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./gate-pass.controller.js";
import * as guardController from "./gate-pass.guard-controller.js";
import { evidencePhotoUpload } from "./gate-pass.upload.js";

const router = Router();

router.use(authenticate);
router.param("id", validateUuidParam("id"));
router.param("fileId", validateUuidParam("fileId"));

// Guard discovery endpoints are declared first with fully specific paths
// so they are never shadowed by the generic "/:id" routes below.
router.get(
  "/guard/dashboard",
  requirePermission("gate_pass.verify", "gate_pass.exit", "gate_pass.return"),
  guardController.dashboard,
);
router.get(
  "/guard/search",
  requirePermission("gate_pass.verify", "gate_pass.exit", "gate_pass.return"),
  guardController.search,
);
router.post(
  "/guard/verify",
  requirePermission("gate_pass.verify", "gate_pass.exit", "gate_pass.return"),
  guardController.verify,
);
router.get(
  "/guard/:id",
  requirePermission("gate_pass.verify", "gate_pass.exit", "gate_pass.return"),
  guardController.getById,
);

router.post("/", requirePermission("gate_pass.create"), controller.create);
router.get("/", requirePermission("gate_pass.view_own", "gate_pass.view_site"), controller.list);
router.get("/:id", requirePermission("gate_pass.view_own", "gate_pass.view_site"), controller.detail);
router.patch("/:id", requirePermission("gate_pass.edit_draft"), controller.updateDraft);
router.post("/:id/submit", requirePermission("gate_pass.submit"), controller.submit);
router.post("/:id/approve", requirePermission("gate_pass.approve"), controller.approve);
router.post("/:id/reject", requirePermission("gate_pass.reject"), controller.reject);
router.post("/:id/cancel", requirePermission("gate_pass.cancel"), controller.cancel);
router.get("/:id/pdf", requirePermission("gate_pass.view_own", "gate_pass.view_site"), controller.downloadPdf);
router.get(
  "/:id/files/:fileId",
  requirePermission("gate_pass.view_own", "gate_pass.view_site"),
  controller.downloadFile,
);

router.post("/:id/exit", requirePermission("gate_pass.exit"), evidencePhotoUpload, guardController.exit);
router.post("/:id/return", requirePermission("gate_pass.return"), evidencePhotoUpload, guardController.returnVehicle);

export default router;
