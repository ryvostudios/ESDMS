import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { requirePasswordChanged } from "../../shared/authorization/require-password-changed.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./rotation.controller.js";

const policyRouter = Router();
policyRouter.use(authenticate);
policyRouter.use(requirePasswordChanged);
policyRouter.param("policyId", validateUuidParam("policyId"));
policyRouter.get("/", requirePermission("rotation.manage", "rotation.view"), controller.listPolicies);
policyRouter.post("/", requirePermission("rotation.manage"), controller.createPolicy);
policyRouter.patch("/:policyId", requirePermission("rotation.manage"), controller.updatePolicy);

// mergeParams — mounted at /api/v1/employees/:id/rotation and
// /api/v1/me/rotation. Self can always view; rotation.view/adjust gate
// non-self access, checked in rotation.service.js.
const statusRouter = Router({ mergeParams: true });
statusRouter.use(authenticate);
statusRouter.use(requirePasswordChanged);
statusRouter.param("id", validateUuidParam("id"));
statusRouter.get("/", controller.status);
statusRouter.post("/adjust", controller.adjust);

export { policyRouter, statusRouter };
