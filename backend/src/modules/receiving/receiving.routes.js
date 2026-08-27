import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePermission } from "../../shared/authorization/require-permission.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import * as controller from "./receiving.controller.js";

const router = Router();

router.use(authenticate);
router.param("id", validateUuidParam("id"));

// requirePermission is only the coarse action gate. Department/site scope —
// including the deliberate split between ordinary department receiving and
// Admin temporary custody — is enforced in the service on the actual record,
// so a caller who knows another department's id gains nothing here.
router.get("/challans", requirePermission("receiving.view"), controller.listDeliveries);
router.get("/challans/:id", requirePermission("receiving.view"), controller.deliveryDetail);
router.post(
  "/challans/:id/receipts",
  requirePermission("receiving.receive", "receiving.fallback_receive"),
  controller.recordReceipt,
);
router.get("/receipts", requirePermission("receiving.view"), controller.listReceipts);
router.get("/receipts/:id", requirePermission("receiving.view"), controller.receiptDetail);
router.post("/receipts/:id/handover", requirePermission("receiving.receive"), controller.acknowledgeHandover);
router.post("/receipts/:id/confirm", requirePermission("receiving.confirm"), controller.confirmReceipt);

export default router;
