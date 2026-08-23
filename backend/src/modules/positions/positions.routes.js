import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import { list, listAll, create, update } from "./positions.controller.js";

const router = Router();
router.use(authenticate);
router.param("id", validateUuidParam("id"));

router.get("/", requirePermission("positions.manage", "employees.view", "employees.create"), list);
router.get("/manage", requirePermission("positions.manage"), listAll);
router.post("/", requirePermission("positions.manage"), create);
router.patch("/:id", requirePermission("positions.manage"), update);

export default router;
