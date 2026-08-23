import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { requirePasswordChanged } from "../../shared/authorization/require-password-changed.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./leave.controller.js";

const typeRouter = Router();
typeRouter.use(authenticate);
typeRouter.use(requirePasswordChanged);
typeRouter.param("typeId", validateUuidParam("typeId"));
typeRouter.get("/", requirePermission("leave.manage", "leave.self.create", "leave.approve"), controller.listTypes);
typeRouter.post("/", requirePermission("leave.manage"), controller.createType);
typeRouter.patch("/:typeId", requirePermission("leave.manage"), controller.updateType);

// mergeParams — /api/v1/employees/:id/leave and /api/v1/me/leave.
const requestRouter = Router({ mergeParams: true });
requestRouter.use(authenticate);
requestRouter.use(requirePasswordChanged);
requestRouter.param("id", validateUuidParam("id"));
requestRouter.param("requestId", validateUuidParam("requestId"));
requestRouter.get("/", controller.list);
requestRouter.post("/", controller.submit);
requestRouter.post("/:requestId/cancel", controller.cancel);

// Not employee-scoped — the approver's queue across their site.
const approvalRouter = Router();
approvalRouter.use(authenticate);
approvalRouter.use(requirePasswordChanged);
approvalRouter.param("requestId", validateUuidParam("requestId"));
approvalRouter.get("/pending", requirePermission("leave.approve"), controller.pending);
approvalRouter.post("/:requestId/decide", requirePermission("leave.approve"), controller.decide);

export { typeRouter, requestRouter, approvalRouter };
