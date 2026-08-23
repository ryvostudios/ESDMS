import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { requirePasswordChanged } from "../../shared/authorization/require-password-changed.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import { documentUpload } from "./document.upload.js";
import * as controller from "./documents.controller.js";

// mergeParams — mounted at both /api/v1/me/documents (self) and
// /api/v1/employees/:id/documents (HR/management), same pattern and
// reasoning as profile.routes.js.
const router = Router({ mergeParams: true });
router.use(authenticate);
router.use(requirePasswordChanged);
router.param("id", validateUuidParam("id"));
router.param("documentId", validateUuidParam("documentId"));
router.param("documentTypeId", validateUuidParam("documentTypeId"));
router.param("requestId", validateUuidParam("requestId"));

router.get("/", controller.list);
router.get("/versions/:documentTypeId", controller.versions);
router.post("/", documentUpload, controller.upload);
router.get("/:documentId/download", controller.download);
router.post("/:documentId/verify", requirePermission("employee_documents.verify"), controller.verify);

router.get("/requests", controller.pendingRequests);
router.post("/requests", requirePermission("employee_documents.manage"), controller.requestDocument);
router.delete("/requests/:requestId", requirePermission("employee_documents.manage"), controller.cancelRequest);

export default router;
