import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import { list, listAll, create, update } from "./departments.controller.js";

const router = Router();
router.param("id", validateUuidParam("id"));

// Department/master data is not "any authenticated user" data — only roles
// that can actually create/edit a Gate Pass, or create/transfer an
// Employee, need it. Guard in particular must never get this for free just
// by being logged in.
router.get(
  "/",
  authenticate,
  requirePermission("gate_pass.create", "gate_pass.edit_draft", "employees.create", "employees.transfer"),
  list,
);

// Workforce configuration surface, additive — gated by the new
// departments.manage permission (HR/CEO baseline; see
// 1787405000000_workforce-schema-foundation.js).
router.get("/manage", authenticate, requirePermission("departments.manage"), listAll);
router.post("/", authenticate, requirePermission("departments.manage"), create);
router.patch("/:id", authenticate, requirePermission("departments.manage"), update);

export default router;
