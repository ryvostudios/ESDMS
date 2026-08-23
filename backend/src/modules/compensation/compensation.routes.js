import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePasswordChanged } from "../../shared/authorization/require-password-changed.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./compensation.controller.js";

// mergeParams — mounted at /api/v1/employees/:id/compensation and
// /api/v1/me/compensation, same pattern as profile/documents. No
// requirePermission here: every handler's authorization (self can always
// view their own; compensation.view/history/change otherwise) is
// centralized in compensation.service.js — see docs/DECISIONS.md.
const router = Router({ mergeParams: true });
router.use(authenticate);
router.use(requirePasswordChanged);
router.param("id", validateUuidParam("id"));

router.get("/current", controller.current);
router.get("/history", controller.history);
router.post("/", controller.create);

export default router;
