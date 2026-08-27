import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { requirePasswordChanged } from "../../shared/authorization/require-password-changed.js";
import { catalog, download } from "./procurement-reports.controller.js";

const router = Router();

router.use(authenticate);
router.use(requirePasswordChanged);

// procurement.export is the coarse gate. Which DATASETS a user may take, and
// which COLUMNS those datasets contain, are both decided again in the service
// against the actor's live price capabilities and record scope.
router.get("/catalog", requirePermission("procurement.export"), catalog);
router.get("/:datasetKey.xlsx", requirePermission("procurement.export"), download);

export default router;
