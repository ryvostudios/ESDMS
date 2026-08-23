import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePasswordChanged } from "../../shared/authorization/require-password-changed.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import { documentUpload } from "../documents/document.upload.js";
import * as controller from "./contracts.controller.js";

// mergeParams — mounted at /api/v1/employees/:id/contracts and
// /api/v1/me/contracts. Contract access is a permission surface deliberately
// separate from ordinary employees.*/HR access (docs/DECISIONS.md) — every
// handler's authorization, including the employee's own view/download-only
// access to finalized contracts, is centralized in contracts.service.js.
const router = Router({ mergeParams: true });
router.use(authenticate);
router.use(requirePasswordChanged);
router.param("id", validateUuidParam("id"));
router.param("contractId", validateUuidParam("contractId"));

router.get("/", controller.list);
router.get("/:contractId", controller.detail);
router.post("/", controller.createDraft);
router.patch("/:contractId", controller.updateDraft);
router.post("/:contractId/file", documentUpload, controller.uploadDraftFile);
router.post("/:contractId/finalize", controller.finalize);
router.post("/:contractId/transition", controller.transition);
router.delete("/:contractId", controller.remove);
router.get("/:contractId/download", controller.download);

export default router;
