import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { requirePasswordChanged } from "../../shared/authorization/require-password-changed.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./employees.controller.js";
import { employeeImportUpload } from "./employee-import.upload.js";

const router = Router();
router.use(authenticate);
router.use(requirePasswordChanged);
router.param("id", validateUuidParam("id"));

// "/me" declared before "/:id" so it is never shadowed by the generic
// param route (same pattern as gate-pass.routes.js's guard endpoints).
router.get("/me", controller.myEmployee);
router.get("/import/template.xlsx", requirePermission("employees.bulk_import"), controller.importTemplate);
router.post("/import/preview", requirePermission("employees.bulk_import"), employeeImportUpload, controller.previewImport);
router.post("/import/confirm", requirePermission("employees.bulk_import"), employeeImportUpload, controller.confirmImport);

router.post("/check-duplicates", requirePermission("employees.create"), controller.checkDuplicates);
router.post("/", requirePermission("employees.create"), controller.create);
router.get("/", requirePermission("employees.view"), controller.list);
router.get("/:id", requirePermission("employees.view"), controller.detail);
router.patch("/:id", requirePermission("employees.update"), controller.update);
router.get("/:id/assignments", requirePermission("employees.view"), controller.assignmentHistory);
router.post("/:id/transfer", requirePermission("employees.transfer"), controller.transfer);
router.post("/:id/status", requirePermission("employees.status_change"), controller.changeStatus);
router.post("/:id/login", requirePermission("employees.account.create"), controller.createLogin);
router.post("/:id/login/reset", requirePermission("employees.account.reset"), controller.resetLoginPassword);

export default router;
