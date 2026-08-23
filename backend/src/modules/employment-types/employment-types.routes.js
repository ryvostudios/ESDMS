import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import { list, listAll, create, update } from "./employment-types.controller.js";

const router = Router();
router.use(authenticate);
router.param("id", validateUuidParam("id"));

router.get("/", requirePermission("employment_types.manage", "employees.view", "employees.create"), list);
router.get("/manage", requirePermission("employment_types.manage"), listAll);
router.post("/", requirePermission("employment_types.manage"), create);
router.patch("/:id", requirePermission("employment_types.manage"), update);

export default router;
