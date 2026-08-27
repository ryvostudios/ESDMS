import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./ipo.controller.js";

const router = Router();

router.use(authenticate);
router.param("id", validateUuidParam("id"));

// Every route re-checks capability AND record scope in the service layer as
// well; requirePermission here is the coarse first gate, never the only one.
// The PDF route additionally requires commercial authority inside the service
// (assertCanDownloadIpoPdf) — an operational ipo.view holder is deliberately
// admitted by the router and refused there, so the price boundary lives in
// exactly one place.
router.get("/outstanding", requirePermission("ipo.view", "demand.create", "demand.edit"), controller.outstanding);
router.get("/", requirePermission("ipo.view", "procurement.purchase", "procurement.view_prices"), controller.list);
router.get("/:id", requirePermission("ipo.view", "procurement.purchase", "procurement.view_prices"), controller.detail);
router.get(
  "/:id/pdf",
  requirePermission("ipo.view", "procurement.purchase", "procurement.view_prices"),
  controller.downloadPdf,
);
router.post("/:id/acknowledge", requirePermission("procurement.purchase"), controller.acknowledge);
router.post("/:id/purchases", requirePermission("procurement.purchase"), controller.recordPurchase);
router.post("/:id/close-purchasing", requirePermission("procurement.purchase"), controller.closePurchasing);
router.post("/:id/cancel", requirePermission("ipo.cancel"), controller.cancel);

export default router;
