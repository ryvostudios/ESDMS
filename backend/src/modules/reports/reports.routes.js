import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { requirePasswordChanged } from "../../shared/authorization/require-password-changed.js";
import { catalog, employeeMaster, workforceReport, bulkFiles } from "./reports.controller.js";

const router = Router();
router.use(authenticate);
router.use(requirePasswordChanged);
router.get("/employee-master.xlsx", requirePermission("workforce.reports.view", "workforce.export"), employeeMaster);
router.get("/catalog", requirePermission("workforce.reports.view"), catalog);
router.get("/:reportKey.xlsx", requirePermission("workforce.reports.view", "workforce.export"), workforceReport);
router.post("/bulk-files.zip", requirePermission("employee_documents.bulk_export"), bulkFiles);

export default router;
