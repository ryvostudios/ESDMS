import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { requirePasswordChanged } from "../../shared/authorization/require-password-changed.js";
import { expiring } from "./documents.controller.js";

// Site-wide report, not Employee-scoped — kept separate from
// documents.routes.js (which is mergeParams-mounted under an employee id).
const router = Router();
router.use(authenticate);
router.use(requirePasswordChanged);
router.get("/expiring", requirePermission("employee_documents.view", "workforce.reports.view"), expiring);

export default router;
