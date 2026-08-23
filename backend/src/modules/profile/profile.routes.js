import { Router } from "express";
import { authenticate } from "../../middleware/authenticate.js";
import { requirePasswordChanged } from "../../shared/authorization/require-password-changed.js";
import { validateUuidParam } from "../../shared/http/validate-uuid-param.js";
import { profilePhotoUpload } from "./photo.upload.js";
import * as controller from "./profile.controller.js";

// mergeParams so this router works identically mounted two ways in app.js:
//   /api/v1/me/profile/...            (self — no :id, controller falls
//                                       back to req.user.employeeId)
//   /api/v1/employees/:id/profile/... (HR/management — :id from the
//                                       parent mount)
// No requirePermission here: every handler's authorization (self access is
// always allowed; a non-self actor needs employees.view/employees.update)
// is centralized in profile.service.js via employees.service.js's
// getEmployee, exactly like every other Employee-scoped resource — see
// docs/DECISIONS.md.
const router = Router({ mergeParams: true });
router.use(authenticate);
router.use(requirePasswordChanged);
router.param("id", validateUuidParam("id"));
router.param("contactId", validateUuidParam("contactId"));
router.param("fieldId", validateUuidParam("fieldId"));

router.get("/", controller.getProfile);
router.patch("/personal-details", controller.updatePersonalDetails);

router.post("/emergency-contacts", controller.addEmergencyContact);
router.patch("/emergency-contacts/:contactId", controller.updateEmergencyContact);
router.delete("/emergency-contacts/:contactId", controller.removeEmergencyContact);

router.put("/fields/:fieldId", controller.setCustomFieldValue);

router.post("/photo", profilePhotoUpload, controller.uploadPhoto);
router.get("/photo", controller.downloadPhoto);

export default router;
