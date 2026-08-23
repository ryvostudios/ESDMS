import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePasswordChanged } from "../../shared/authorization/require-password-changed.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./business-history.controller.js";

// mergeParams — /api/v1/employees/:id/history and /api/v1/me/history.
const router = Router({ mergeParams: true });
router.use(authenticate);
router.use(requirePasswordChanged);
router.param("id", validateUuidParam("id"));
router.param("entryId", validateUuidParam("entryId"));

router.get("/", controller.list);
router.post("/:entryId/remove", controller.remove);

export default router;
