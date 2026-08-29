import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./material-catalog.controller.js";

const router = Router();

router.use(authenticate);
router.param("id", validateUuidParam("id"));
router.param("companyItemId", validateUuidParam("companyItemId"));

// Specific literal paths declared before "/:id" so they're never shadowed.
router.get(
  "/units-of-measure",
  requirePermission("material_catalog.view", "material_catalog.manage"),
  controller.listUnitsOfMeasure,
);
router.get("/company-items/search", requirePermission("material_catalog.manage"), controller.searchItems);
router.patch(
  "/company-items/:companyItemId",
  requirePermission("material_catalog.manage"),
  controller.updateCompanyItem,
);

router.get("/", requirePermission("material_catalog.view", "material_catalog.manage"), controller.list);
router.post("/", requirePermission("material_catalog.manage"), controller.create);
router.patch("/:id", requirePermission("material_catalog.manage"), controller.update);

export default router;
