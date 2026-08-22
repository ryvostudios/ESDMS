import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { list } from "./departments.controller.js";

const router = Router();

// Department/master data is not "any authenticated user" data — only roles
// that can actually create or edit a Gate Pass need it. Guard in
// particular must never get this for free just by being logged in.
router.get("/", authenticate, requirePermission("gate_pass.create", "gate_pass.edit_draft"), list);

export default router;
