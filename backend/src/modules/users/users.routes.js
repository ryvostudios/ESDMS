import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./users.controller.js";

const router = Router();

router.use(authenticate);
router.param("id", validateUuidParam("id"));

router.get("/", requirePermission("users.view"), controller.list);
router.post("/", requirePermission("users.create"), controller.create);
router.get("/:id", requirePermission("users.view"), controller.getOne);
router.patch("/:id/role", requirePermission("users.update"), controller.changeRole);
router.post("/:id/activate", requirePermission("users.activate"), controller.activate);
router.post("/:id/deactivate", requirePermission("users.deactivate"), controller.deactivate);

router.get("/:id/permissions", requirePermission("permission_overrides.view"), controller.getPermissions);
router.put("/:id/permissions/:code", requirePermission("permission_overrides.manage"), controller.setPermission);
router.delete("/:id/permissions/:code", requirePermission("permission_overrides.manage"), controller.removePermission);
router.put("/:id/bundles/:code", requirePermission("permission_overrides.manage"), controller.assignBundle);
router.delete("/:id/bundles/:code", requirePermission("permission_overrides.manage"), controller.removeBundle);

router.post(
  "/:id/regenerate-temp-password",
  requirePermission("users.regenerate_temp_password"),
  controller.regenerateTempPassword,
);

export default router;
